# keycast

[![CI](https://github.com/sasukevibes/omarchy-keycast/actions/workflows/ci.yml/badge.svg)](https://github.com/sasukevibes/omarchy-keycast/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Shows your keystrokes on screen while you record with Omarchy's built-in recorder.**

Start a recording the way you already do (`ALT + PRINT`, the Capture menu,
or webcam mode) and keycast draws your shortcuts, typing, and clicks as key
caps in your current Omarchy theme. The recorder captures them like anything
else on screen. When the recording stops, keycast goes away.

- **Theme-matched key caps.** Colours come from your Omarchy theme and
  change when you switch themes.
- **Hyprland bind labels.** `SUPER` `Enter` → *Terminal*, `SUPER` `SHIFT` `1`
  → *Move window to workspace 1*, `SUPER` + drag → *Move window*. The
  descriptions come from your own binds.
- **Typing is grouped** into one running line, and Backspace edits it.
  Shortcuts get their own caps, and repeats collapse into a counter: `↓ ×12`.
- **Clicks and touchpad taps** show as caps with a ripple at the pointer.
- **Region-aware.** Record a region and the keys appear inside that region.
- **Password masking.** See [Privacy](#privacy).
- **SUPER-only mode.** Show only what you press while holding `SUPER`, so
  your Hyprland shortcuts appear and ordinary typing never does.
- **Bar widget.** Turn keycast on or off, hide mouse clicks, switch to
  SUPER-only, and pick a small, medium, or large overlay from your bar.

## Install

Needs Omarchy with the Quickshell shell (`omarchy plugin` available) and Rust
(`sudo pacman -S rust`).

```bash
omarchy plugin add https://github.com/sasukevibes/omarchy-keycast --enable
~/.config/omarchy/plugins/sasukevibes.keycast/install.sh
```

`install.sh` builds the small `keycastd` helper and installs it with a
polkit rule (it asks for sudo once). That's it: start a recording.

Already installed? Update and restart the shell:

```bash
omarchy plugin update sasukevibes.keycast
omarchy restart shell
```

To preview the overlay without recording:

```bash
omarchy-shell keycast demo
```

## How it works

Wayland does not let apps read the keyboard globally, which is the right
default. keycast works around it without weakening it:

1. The plugin runs inside `omarchy-shell` and checks whether
   `gpu-screen-recorder` is running.
2. When a recording starts, it launches `keycastd` through `pkexec`.
   `keycastd` opens the input devices read-only, **immediately drops root**,
   and becomes you.
3. `keycastd` **refuses to start without a recording, and exits by itself when
   the recording stops**, whoever launched it. It only reads keys while the red
   recording indicator is in your bar.
4. Key events go to the overlay as JSON lines. They are translated with
   xkbcommon, so any keyboard layout works. Nothing is written to disk.

The polkit rule lets your active local session start the helper without a
password. For a password prompt instead, change `allow_active` to
`auth_admin_keep` in
`/usr/share/polkit-1/actions/dev.keycast.keycastd.policy`.

## Privacy

Recordings get shared, so keycast hides typed text
(shortcuts still show) when:

- the screen is locked, or the polkit password dialog is open
- a password manager or pinentry window is focused (1Password, Bitwarden,
  KeePassXC, …)
- the focused window's title mentions a password, sign-in, sudo, 2FA, …
- **the line right after** `sudo`, `ssh`, `su`, `doas`, `yay`, `paru`, `gpg`,
  `passwd` and friends, until you press Enter

Hidden text shows as `••••••`, whatever its length. It is never stored.

A password typed into a web page whose title looks harmless **can't be
detected**. Bind a pause key and use it:

```lua
-- ~/.config/hypr/bindings.lua
o.bind("SUPER + ALT + PRINT", "Pause keycast", "omarchy-shell keycast togglePause")
```

## Settings

Click the ⌨ icon in your bar for the settings panel:

- **Show keystrokes:** turn keycast off to record without keys on screen.
  Right-clicking the icon does the same.
- **Show mouse clicks:** hide click caps and ripples.
- **Only while holding SUPER:** show only keys and clicks made while `SUPER`
  is held. Typing and other shortcuts stay off screen.
- **Size:** small, medium, or large. A preview plays when you pick one.

If the icon isn't on your bar, add it with
`omarchy bar put sasukevibes.keycast right`.

Settings are saved to `~/.config/keycast/config.json`. The file also takes a
few options the panel doesn't show:

```json
{
  "enabled": true,
  "showClicks": true,
  "superOnly": false,
  "size": "medium",
  "position": "bottom",
  "fadeMs": 1500,
  "showText": true,
  "showBindLabels": true
}
```

Everything is also scriptable, so you can bind it to keys:

| Command | Effect |
| --- | --- |
| `omarchy-shell keycast toggle` | turn keycast on or off |
| `omarchy-shell keycast toggleClicks` | show or hide mouse clicks |
| `omarchy-shell keycast toggleSuperOnly` | show only keys held with `SUPER`, or all keys |
| `omarchy-shell keycast setSize large` | `small`, `medium`, or `large` |
| `omarchy-shell keycast togglePause` | hide typed text until toggled back |
| `omarchy-shell keycast demo` | play a sample sequence on screen |
| `omarchy-shell keycast status` | JSON state, for troubleshooting |

## Uninstall

```bash
~/.config/omarchy/plugins/sasukevibes.keycast/install.sh --uninstall
omarchy plugin remove sasukevibes.keycast
```

## Develop

```bash
cargo test --manifest-path keycastd/Cargo.toml   # helper
node --test tests/*.test.js                      # display model
scripts/dev-sync --restart                       # install the working copy and reload the shell
```

`tests/fake-keycastd` speaks the helper's protocol without touching devices.
Add `{"helperCommand": ["/path/to/tests/fake-keycastd"]}` to the config to
work on the overlay without root. See [docs/DESIGN.md](docs/DESIGN.md) for the
protocol and design.

## Contributing

Issues and pull requests are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md).
Please report security problems privately as described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
