import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';
import Soup from 'gi://Soup?version=3.0';
import Cairo from 'gi://cairo';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

// Desktop app ids treated as terminals. Add e.g. 'kitty.desktop',
// 'Alacritty.desktop' or 'com.gexperts.Tilix.desktop' if needed.
const TERMINAL_APP_IDS = [
    'org.gnome.Terminal.desktop',
];

const MAX_TITLE_LENGTH = 70;

// Title prefixes claude-code writes via OSC 0 (verified against 2.1.204):
// U+2733 idle, U+2802/U+2810 busy pulse, plus the picker screen titles.
const CLAUDE_TITLE_RE = /^[\u2733\u2802\u2810] |^claude \u00B7 |claude agents$/;

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const OAUTH_BETA = 'oauth-2025-04-20';

// The endpoint rate-limits hard: anthropics/claude-code#31637 reports
// persistent 429s when polled at 30-60s. 300s is the interval other
// clients settled on.
const POLL_INTERVAL = 300;
const MAX_BACKOFF = 600;
const MANUAL_THROTTLE = 60;
const REQUEST_TIMEOUT = 15;

// Geometry of icons/claude-symbolic.svg: 11 lines rotated about the centre
// of a 16x16 box, each running outward from radius 1.2. The SVG stores an
// end coordinate y2; radius here is 8 - y2. Kept in sync by hand with that
// file, which stays on disk as the reference drawing.
const ICON_BOX = 16;
const SPOKE_INNER_RADIUS = 1.2;
const SPOKE_WIDTH = 1.7;
const SPOKES = [
    {angle: 0, radius: 6.4},
    {angle: 33, radius: 4.6},
    {angle: 66, radius: 5.7},
    {angle: 98, radius: 4.4},
    {angle: 130, radius: 6.0},
    {angle: 163, radius: 4.5},
    {angle: 196, radius: 5.8},
    {angle: 228, radius: 4.7},
    {angle: 262, radius: 6.1},
    {angle: 295, radius: 4.4},
    {angle: 328, radius: 5.5},
];

const GHOST_ALPHA = 0.25;
const COLOR_AMBER = [0.898, 0.647, 0.039];
const COLOR_ORANGE = [1.0, 0.471, 0.0];
const COLOR_RED = [0.878, 0.106, 0.141];

const KIND_LABELS = {
    session: 'Session (5h)',
    weekly_all: 'Weekly',
    weekly_scoped: 'Weekly',
};

// null means "use the panel foreground", i.e. nothing to warn about yet.
function colorForRemaining(remaining) {
    if (remaining <= 10)
        return COLOR_RED;
    if (remaining <= 20)
        return COLOR_ORANGE;
    if (remaining <= 40)
        return COLOR_AMBER;
    return null;
}

function humaniseKind(kind) {
    if (!kind)
        return 'Limit';
    return kind.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());
}

function limitLabel(entry) {
    const base = KIND_LABELS[entry.kind] ?? humaniseKind(entry.kind);
    const model = entry.scope?.model?.display_name;
    return model ? `${base} ${model}` : base;
}

// GLib rather than toLocaleString: JS Intl in gjs ignores LC_TIME and would
// print "04:59 PM / Thu" on a 24h Polish desktop.
function formatReset(timestamp, use12h) {
    const date = GLib.DateTime.new_from_unix_local(Math.floor(timestamp / 1000));
    const time = date.format(use12h ? '%l:%M %p' : '%H:%M').trim();
    const now = GLib.DateTime.new_now_local();
    const sameDay = date.get_year() === now.get_year() &&
        date.get_day_of_year() === now.get_day_of_year();
    return sameDay ? time : `${date.format('%a')} ${time}`;
}

function formatAge(timestamp) {
    const minutes = Math.floor((Date.now() - timestamp) / 60000);
    if (minutes < 1)
        return 'just now';
    if (minutes < 60)
        return `${minutes}m ago`;
    return `${Math.floor(minutes / 60)}h ago`;
}

// Draws the Claude starburst with the first `lit` spokes at full opacity and
// the rest ghosted, so the mark stays readable at any level. A Gio.FileIcon
// cannot be recoloured per spoke, hence drawing it rather than loading it.
const ClaudeUsageIcon = GObject.registerClass(
class ClaudeUsageIcon extends St.DrawingArea {
    _init() {
        // Own style class rather than system-status-icon: that one adds
        // padding, and get_surface_size() reports the content box, which
        // would silently shrink the drawing.
        super._init({
            style_class: 'terminal-list-usage-icon',
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._remaining = null;
        this.connect('repaint', () => this._repaint());

        const themeContext = St.ThemeContext.get_for_stage(global.stage);
        this._scaleSignal = themeContext.connect(
            'notify::scale-factor', () => this._updateSize());
        this._updateSize();
    }

    _updateSize() {
        // St.DrawingArea has no natural size; without this it draws nothing.
        const {scale_factor: scale} = St.ThemeContext.get_for_stage(global.stage);
        this.set_size(ICON_BOX * scale, ICON_BOX * scale);
        this.queue_repaint();
    }

    // remaining: 0-100, or null when the level is not known yet.
    setRemaining(remaining) {
        if (this._remaining === remaining)
            return;
        this._remaining = remaining;
        this.queue_repaint();
    }

    _repaint() {
        const cr = this.get_context();
        const [width, height] = this.get_surface_size();
        const scale = Math.min(width, height) / ICON_BOX;
        const cx = width / 2;
        const cy = height / 2;

        const known = this._remaining !== null;
        const accent = known ? colorForRemaining(this._remaining) : null;
        let rgb = accent;
        if (!rgb) {
            const fg = this.get_theme_node().get_foreground_color();
            rgb = [fg.red / 255, fg.green / 255, fg.blue / 255];
        }
        const lit = known
            ? Math.max(0, Math.min(SPOKES.length,
                Math.round(this._remaining / 100 * SPOKES.length)))
            : 0;

        cr.setLineWidth(SPOKE_WIDTH * scale);
        cr.setLineCap(Cairo.LineCap.ROUND);

        SPOKES.forEach(({angle, radius}, i) => {
            // SVG rotate() turns clockwise with y pointing down, so a spoke
            // at angle a runs along (sin a, -cos a) from the centre.
            const rad = angle * Math.PI / 180;
            const dx = Math.sin(rad);
            const dy = -Math.cos(rad);
            cr.setSourceRGBA(rgb[0], rgb[1], rgb[2],
                i < lit ? 1.0 : GHOST_ALPHA);
            cr.moveTo(cx + dx * SPOKE_INNER_RADIUS * scale,
                cy + dy * SPOKE_INNER_RADIUS * scale);
            cr.lineTo(cx + dx * radius * scale, cy + dy * radius * scale);
            cr.stroke();
        });

        // GJS logs a leaked context every frame unless this is explicit.
        cr.$dispose();
    }

    destroy() {
        if (this._scaleSignal) {
            St.ThemeContext.get_for_stage(global.stage)
                .disconnect(this._scaleSignal);
            this._scaleSignal = null;
        }
        super.destroy();
    }
});

// Polls the OAuth usage endpoint using the token Claude Code maintains in
// ~/.claude/.credentials.json. Read-only: refreshing that file here would
// race the Claude Code process and can break the user's login.
class UsageMonitor {
    constructor(onUpdate) {
        this._onUpdate = onUpdate;
        this._session = new Soup.Session({timeout: REQUEST_TIMEOUT});
        this._cancellable = new Gio.Cancellable();
        this._timerId = 0;
        this._lastManual = 0;
        this._inFlight = false;
        this._destroyed = false;

        this.state = {
            status: 'loading',
            limits: [],
            remaining: null,
            updatedAt: 0,
            message: null,
        };
    }

    start() {
        this.refresh();
    }

    refresh(manual = false) {
        if (this._destroyed)
            return;
        if (manual) {
            const now = GLib.get_monotonic_time() / 1000000;
            if (now - this._lastManual < MANUAL_THROTTLE)
                return;
            this._lastManual = now;
        }
        if (this._inFlight)
            return;
        this._inFlight = true;
        this._readToken(token => {
            if (!token) {
                this._finish('signed-out', 'Claude Code credentials not found');
                return;
            }
            this._request(token);
        });
    }

    _readToken(callback) {
        const path = GLib.build_filenamev(
            [GLib.get_home_dir(), '.claude', '.credentials.json']);
        // Async so a slow or missing home directory cannot freeze the shell.
        Gio.File.new_for_path(path).load_contents_async(
            this._cancellable, (file, res) => {
                try {
                    const [, contents] = file.load_contents_finish(res);
                    const json = JSON.parse(new TextDecoder().decode(contents));
                    callback(json?.claudeAiOauth?.accessToken ?? null);
                } catch (e) {
                    if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        this._inFlight = false;
                    else
                        callback(null);
                }
            });
    }

    _request(token) {
        const message = Soup.Message.new('GET', USAGE_URL);
        const headers = message.get_request_headers();
        headers.append('Authorization', `Bearer ${token}`);
        headers.append('anthropic-beta', OAUTH_BETA);

        this._session.send_and_read_async(
            message, GLib.PRIORITY_DEFAULT, this._cancellable,
            (session, res) => {
                let bytes;
                try {
                    bytes = session.send_and_read_finish(res);
                } catch (e) {
                    if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) {
                        this._inFlight = false;
                        return;
                    }
                    this._finish('error', e.message);
                    return;
                }

                const status = message.status_code;
                if (status === 429) {
                    const retryAfter = parseInt(
                        message.get_response_headers().get_one('Retry-After'), 10);
                    const delay = Math.min(MAX_BACKOFF,
                        Number.isFinite(retryAfter) && retryAfter > 0
                            ? retryAfter : POLL_INTERVAL);
                    this._finish('rate-limited', 'Rate limited', delay);
                    return;
                }
                if (status === 401 || status === 403) {
                    this._finish('signed-out', 'Token expired, run Claude Code');
                    return;
                }
                if (status !== 200) {
                    this._finish('error', `HTTP ${status}`);
                    return;
                }

                try {
                    const data = JSON.parse(
                        new TextDecoder().decode(bytes.get_data()));
                    const limits = this._parse(data);
                    if (limits.length === 0) {
                        this._finish('error', 'No limits in response');
                        return;
                    }
                    const worst = limits.reduce(
                        (max, l) => Math.max(max, l.percent), 0);
                    this.state.limits = limits;
                    this.state.remaining =
                        Math.max(0, Math.min(100, 100 - worst));
                    this.state.updatedAt = Date.now();
                    this._finish('ok', null);
                } catch (e) {
                    this._finish('error', 'Malformed response');
                }
            });
    }

    // limits[] is the only place model-scoped buckets appear; five_hour and
    // seven_day can both read healthy while a scoped weekly sits at 100%.
    _parse(data) {
        const limits = [];
        for (const entry of data?.limits ?? []) {
            if (typeof entry?.percent !== 'number')
                continue;
            limits.push({
                label: limitLabel(entry),
                percent: entry.percent,
                resetsAt: entry.resets_at ? Date.parse(entry.resets_at) : null,
                isActive: !!entry.is_active,
            });
        }
        if (limits.length > 0)
            return limits;

        // Fallback for the older response shape.
        for (const [key, label] of [['five_hour', 'Session (5h)'],
            ['seven_day', 'Weekly']]) {
            const bucket = data?.[key];
            if (typeof bucket?.utilization !== 'number')
                continue;
            limits.push({
                label,
                percent: bucket.utilization,
                resetsAt: bucket.resets_at ? Date.parse(bucket.resets_at) : null,
                isActive: false,
            });
        }
        return limits;
    }

    // Guarded because a response already queued when destroy() runs would
    // otherwise reschedule the timer and outlive the extension.
    _finish(status, message, delay = POLL_INTERVAL) {
        this._inFlight = false;
        if (this._destroyed)
            return;
        this.state.status = status;
        this.state.message = message;
        if (status !== 'ok' && status !== 'rate-limited') {
            this.state.limits = [];
            this.state.remaining = null;
        }
        this._onUpdate();
        this._schedule(delay);
    }

    // One self-rescheduling timer, so backoff is just a longer delay rather
    // than a second timer to keep in sync.
    _schedule(delay) {
        this._clearTimer();
        this._timerId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, delay, () => {
                this._timerId = 0;
                this.refresh();
                return GLib.SOURCE_REMOVE;
            });
    }

    _clearTimer() {
        if (this._timerId) {
            GLib.Source.remove(this._timerId);
            this._timerId = 0;
        }
    }

    destroy() {
        this._destroyed = true;
        this._clearTimer();
        this._cancellable.cancel();
        this._session.abort();
        this._onUpdate = () => {};
    }
}

const TerminalListButton = GObject.registerClass(
class TerminalListButton extends PanelMenu.Button {
    _init() {
        super._init(0.5, 'Terminal List');

        this._tracker = Shell.WindowTracker.get_default();
        this._titleSignals = new Map();
        this._clockSettings = new Gio.Settings({
            schema_id: 'org.gnome.desktop.interface',
        });

        const box = new St.BoxLayout({style_class: 'panel-status-menu-box'});
        this._usageIcon = new ClaudeUsageIcon();
        box.add_child(this._usageIcon);
        this._countLabel = new St.Label({
            text: '0',
            y_align: Clutter.ActorAlign.CENTER,
        });
        box.add_child(this._countLabel);
        this.add_child(box);

        this._monitor = new UsageMonitor(() => this._onUsageUpdate());

        this._trackerSignal = this._tracker.connect(
            'tracked-windows-changed', () => this._updateCount());
        this.menu.connect('open-state-changed', (menu, open) => {
            if (open) {
                this._rebuildMenu();
                this._monitor.refresh(true);
            }
        });

        // Seed the menu: PopupMenu.open() refuses to open an empty menu,
        // so it must never be empty or open-state-changed never fires.
        this._rebuildMenu();
        this._monitor.start();
    }

    _onUsageUpdate() {
        this._usageIcon.setRemaining(this._monitor.state.remaining);
        if (this.menu.isOpen)
            this._rebuildMenu();
    }

    _getTerminalWindows() {
        const wm = global.workspace_manager;
        const seen = new Set();
        const result = [];
        for (let i = 0; i < wm.get_n_workspaces(); i++) {
            const workspace = wm.get_workspace_by_index(i);
            for (const win of workspace.list_windows()) {
                if (win.skip_taskbar || seen.has(win))
                    continue;
                const app = this._tracker.get_window_app(win);
                if (!app || !TERMINAL_APP_IDS.includes(app.get_id()))
                    continue;
                seen.add(win);
                result.push({win, wsIndex: i, isClaude: this._isClaudeTitle(win.get_title())});
            }
        }
        result.sort((a, b) =>
            b.isClaude - a.isClaude ||
            a.wsIndex - b.wsIndex ||
            a.win.get_stable_sequence() - b.win.get_stable_sequence());
        return result;
    }

    _isClaudeTitle(title) {
        return title ? CLAUDE_TITLE_RE.test(title) : false;
    }

    // Keep notify::title connections in sync with the current terminal
    // windows, so the count and highlight react when claude starts or
    // exits inside an already-open window.
    _syncTitleSignals(windows) {
        const current = new Set(windows.map(w => w.win));
        for (const [win, id] of this._titleSignals) {
            if (!current.has(win)) {
                win.disconnect(id);
                this._titleSignals.delete(win);
            }
        }
        for (const win of current) {
            if (!this._titleSignals.has(win)) {
                this._titleSignals.set(win,
                    win.connect('notify::title', () => this._updateCount()));
            }
        }
    }

    _ellipsize(title) {
        if (!title)
            return '(untitled)';
        if (title.length <= MAX_TITLE_LENGTH)
            return title;
        const half = Math.floor((MAX_TITLE_LENGTH - 1) / 2);
        return `${title.slice(0, half)}…${title.slice(-half)}`;
    }

    _updateCount() {
        this._applyWindows(this._getTerminalWindows());
    }

    _applyWindows(windows) {
        this._syncTitleSignals(windows);
        const claude = windows.filter(w => w.isClaude).length;
        this._countLabel.text = `${claude}/${windows.length}`;
    }

    _addUsageSection() {
        const {status, limits, message, updatedAt} = this._monitor.state;

        const use12h = this._clockSettings.get_string('clock-format') === '12h';

        if (limits.length > 0) {
            for (const limit of limits) {
                const reset = limit.resetsAt
                    ? `  resets ${formatReset(limit.resetsAt, use12h)}` : '';
                const item = new PopupMenu.PopupMenuItem(
                    `${limit.label}  ${Math.round(limit.percent)}%${reset}`,
                    {reactive: false});
                if (limit.percent >= 90)
                    item.label.add_style_class_name('terminal-list-limit-critical');
                if (limit.isActive)
                    item.setOrnament(PopupMenu.Ornament.DOT);
                this.menu.addMenuItem(item);
            }
        } else {
            const text = status === 'loading'
                ? 'Claude usage: loading…'
                : `Claude usage: ${message ?? 'unavailable'}`;
            this.menu.addMenuItem(
                new PopupMenu.PopupMenuItem(text, {reactive: false}));
        }

        let footer;
        if (status === 'rate-limited')
            footer = 'Rate limited, retrying';
        else if (status === 'ok' || updatedAt)
            footer = `Updated ${formatAge(updatedAt)} - click to refresh`;
        else
            footer = 'Click to retry';
        const refreshItem = new PopupMenu.PopupMenuItem(footer);
        refreshItem.label.add_style_class_name('terminal-list-footer');
        refreshItem.connect('activate', () => this._monitor.refresh(true));
        this.menu.addMenuItem(refreshItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
    }

    _rebuildMenu() {
        this.menu.removeAll();
        const windows = this._getTerminalWindows();
        this._applyWindows(windows);

        this._addUsageSection();

        if (windows.length === 0) {
            this.menu.addMenuItem(new PopupMenu.PopupMenuItem(
                'No terminal windows', {reactive: false}));
            return;
        }

        const activeWs = global.workspace_manager.get_active_workspace_index();
        const focused = global.display.focus_window;
        for (const {win, wsIndex, isClaude} of windows) {
            const prefix = wsIndex === activeWs ? '' : `[${wsIndex + 1}] `;
            const item = new PopupMenu.PopupMenuItem(
                prefix + this._ellipsize(win.get_title()));
            if (isClaude)
                item.label.add_style_class_name('terminal-list-claude');
            if (win === focused)
                item.setOrnament(PopupMenu.Ornament.DOT);
            item.connect('activate', () => {
                win.activate(global.get_current_time());
            });
            this.menu.addMenuItem(item);
        }
    }

    destroy() {
        this._monitor?.destroy();
        this._monitor = null;
        this._clockSettings = null;
        if (this._trackerSignal) {
            this._tracker.disconnect(this._trackerSignal);
            this._trackerSignal = null;
        }
        for (const [win, id] of this._titleSignals)
            win.disconnect(id);
        this._titleSignals.clear();
        super.destroy();
    }
});

export default class TerminalListExtension extends Extension {
    enable() {
        this._indicator = new TerminalListButton();
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
