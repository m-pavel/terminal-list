# Terminal List

GNOME Shell extension that puts a dropdown in the top panel listing every GNOME Terminal window across all workspaces. Windows running [Claude Code](https://github.com/anthropics/claude-code) are highlighted, and the panel icon doubles as a gauge of your Anthropic account usage.

## Features

- Lists terminal windows from all workspaces; click a title to focus it.
- Detects Claude Code sessions by their window title and sorts them first.
- Panel label shows `claude/total` window count.
- Panel icon is the Claude starburst drawn with Cairo: lit spokes show remaining quota, ghosted spokes show what is used.
- Icon turns amber at 40% remaining, orange at 20%, red at 10%.
- Dropdown shows each rate limit (5h session, weekly, per-model weekly) with usage percent and reset time, using your desktop 12h/24h clock setting.
- Windows on other workspaces are prefixed with `[N]`; the focused window gets a dot.

## Requirements

- GNOME Shell 46 to 50.
- GNOME Terminal. Other terminals can be added to `TERMINAL_APP_IDS` in `extension.js`.
- Claude Code logged in via `claude login` for the usage gauge. Without it the extension still lists windows and the gauge stays neutral.

## Install

```sh
git clone https://github.com/m-pavel/terminal-list.git \
  ~/.local/share/gnome-shell/extensions/terminal-list@local
gnome-extensions enable terminal-list@local
```

On Wayland log out and back in. On X11 press `Alt+F2`, type `r`, press Enter.

## How usage polling works

The extension reads the OAuth access token from `~/.claude/.credentials.json`, the file Claude Code maintains. The file is only read, never written, so it cannot interfere with Claude Code's own token refresh.

It calls `https://api.anthropic.com/api/oauth/usage` every 5 minutes. On HTTP 429 it honours `Retry-After`, capped at 10 minutes. Opening the menu or clicking the footer triggers a manual refresh, throttled to once per minute. No data is sent anywhere except Anthropic's API.

If the token is missing or expired the menu shows a hint and the gauge falls back to the panel foreground colour.

## Files

| File | Purpose |
|------|---------|
| `extension.js` | Extension entry point, window tracking, usage monitor, icon drawing |
| `stylesheet.css` | Panel and menu styling |
| `icons/claude-symbolic.svg` | Reference drawing for the starburst geometry |
| `metadata.json` | Extension metadata and supported shell versions |

## License

MIT, see [LICENSE](LICENSE).
