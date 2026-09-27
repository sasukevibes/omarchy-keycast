# keycast — design

Keystroke and click overlay for Omarchy's built-in screen recorder.

## Goals

- Show the keys and clicks you press while recording, drawn live on screen so
  `gpu-screen-recorder` captures them like any other pixels.
- Work with every existing way of starting a recording (`ALT+PRINT`, the
  Capture menu, webcam mode) without patching `omarchy-capture-screenrecording`.
- Never be able to read keys unless a recording is running.
- Never leak a password into a recording.

Non-goals for v1: post-recording burn-in, subtitle sidecars, X11, non-Hyprland
compositors.

## Architecture

```
 omarchy-shell (Quickshell, user)                     root → user
┌──────────────────────────────────────┐  pkexec   ┌──────────────────────────┐
│ sasukevibes.keycast  (service plugin) │ ────────▶ │ keycastd (Rust)          │
│                                      │           │  open /dev/input/event*  │
│  recorder watch ── pgrep gsr (0.7 s) │  stdout   │  drop to PKEXEC_UID      │
│  Model.js  ◀──── JSON lines ──────── │ ◀──────── │  xkbcommon → keysyms     │
│  Overlay.qml (layer-shell, no input) │           │  exit when gsr stops     │
└──────────────────────────────────────┘           └──────────────────────────┘
```

### keycastd (Rust, `keycastd/`)

A small helper that is started by the plugin only while a recording runs.

1. **Open devices.** Enumerates `/dev/input/event*` and keeps keyboards
   (devices reporting `KEY_A`…`KEY_Z` or `KEY_ENTER`) and pointers
   (`BTN_LEFT`). Devices are opened read-only and never grabbed, so input
   still flows to the compositor untouched.
2. **Drop privileges.** When running as root it switches to `PKEXEC_UID`
   (`setgroups([])`, `setgid`, `setuid`) immediately after opening devices,
   then sets `PR_SET_PDEATHSIG` so it dies with the shell. It refuses to run as
   root without `PKEXEC_UID`, and it takes no argument that names a user or
   a file path.
3. **Recording gate.** A privileged run exits unless a `gpu-screen-recorder`
   process owned by the same user exists, and keeps checking `/proc` twice a
   second, exiting as soon as it is gone: keycast can only read the keyboard while
   the recording indicator is on. Unprivileged runs (a user already in the `input` group, or
   development) skip the gate.
4. **Translate.** One `xkbcommon` state, built from the Hyprland keyboard
   layout the plugin passes in (`--layout`, `--variant`, `--options`, `--model`), is
   fed every key event so labels are right on any layout.
5. **Emit** one JSON object per line on stdout. It exits when stdout closes.

#### Protocol (v1)

```jsonc
{"type":"hello","v":1,"version":"0.1.0","keyboards":2,"pointers":1,"gated":true}
{"type":"key","code":28,"sym":"Return","text":"","mods":[],"repeat":false}
{"type":"key","code":46,"sym":"c","text":"","mods":["CTRL","SHIFT"],"repeat":false}
{"type":"key","code":30,"sym":"a","text":"A","mods":["SHIFT"],"repeat":false}
{"type":"mod","sym":"Super_L","mods":["SUPER"]}          // modifier tapped alone
{"type":"click","button":"left","mods":["SUPER"],"tap":false}
{"type":"bye","reason":"recording-stopped"}
```

- `code`: evdev keycode. Hyprland `code:NN` binds use `code + 8`.
- `sym`: the xkb keysym name at shift level 0 (the unshifted key). Stable for
  labels and bind matching.
- `text`: what the key typed with the current modifiers, or `""` if it isn't
  printable (control characters, and anything typed with CTRL/ALT/SUPER held).
- `mods`: held modifiers, always ordered `SUPER, CTRL, ALT, SHIFT`.
  AltGr (`ISO_Level3_Shift`) is not reported as ALT; it is used for typing.
- `tap`: a click synthesized from a touchpad tap (one finger → left, two →
  right, three → middle). libinput does tap-to-click inside the compositor,
  so the raw evdev stream only has touches. keycastd detects taps as a short
  touch that barely moves.

### Plugin (repo root, `sasukevibes.keycast`)

A `service` plugin with `keepLoaded: true`, mounted inside `omarchy-shell`.
Keeping it loaded means a reload of some other plugin cannot kill the helper
in the middle of a recording.

- **Recorder watch** runs `pgrep -a -f ^gpu-screen-recorder` every 0.7 s. The
  recorder's `-w` argument gives the recorded monitor or region
  (`Model.recorderTarget`), so the keys are drawn inside what is being
  captured. When a recording starts, `scripts/keycast-context` collects the
  layout (the `main` keyboard in `hyprctl devices -j`), the binds,
  tap-to-click, the focused window, and the helper path. The service then
  starts `pkexec <helper> …` and stops it when the recording ends.
- **Model.js** is a pure JavaScript state machine, tested with `node --test`.
  It turns protocol events into display rows:
  - *combo* rows: key caps such as `SUPER` `SHIFT` `Enter`, with a `×N`
    counter on repeats, and the Hyprland bind description when the combo
    matches `hyprctl binds -j` (modmask plus case-insensitive keysym, or
    `code:`).
  - *text* rows: typed characters grouped into a single running line.
    Backspace removes a character. The line starts again after 1.2 s of idle,
    on Enter, or when a combo is pressed.
  - *key* rows: special keys (Esc, Tab, arrows, F-keys) shown as caps.
  - *click* rows: `L`, `R` or `M` caps, plus a ripple at the cursor.
  - Rows fade out 1.5 s after their last update. At most 3 are stacked.
- **Overlay.qml** is one layer-shell `PanelWindow` per screen on the Overlay
  layer, with an empty input mask so it never takes clicks, focus, or
  exclusive space. Colours come from the Omarchy theme (`qs.Commons`), so it
  restyles on theme switch. `KeyRow` and `Keycap` draw the rows, and `Ripple`
  draws click rings at the position returned by `hyprctl cursorpos`.
- **IPC** (`omarchy-shell keycast …`): `toggle`, `enable`, `disable`,
  `toggleClicks`, `setClicks`, `toggleSuperOnly`, `setSuperOnly`, `setSize`,
  `pause`, `resume`, `togglePause`, `demo` (plays a scripted sequence without the helper), `preview`, `status`.
- **Settings** live in `~/.config/keycast/config.json`: `enabled`,
  `showClicks`, `superOnly`, `size` (`small`, `medium`, `large`; a numeric
  `scale` also works), `position`, `fadeMs`, `showText`, `showBindLabels`, and
  `helperCommand`, a development override that runs an unprivileged command,
  e.g. `tests/fake-keycastd`, instead of pkexec. When `enabled` is false, no
  helper runs during recordings. When `superOnly` is true, the service drops
  every event whose modifiers don't include SUPER (`Model.heldSuper`) before
  it reaches the display model.
- **Bar widget** (`BarWidget.qml`) is an icon plus a settings panel.
  Replacement bars don't give widgets access to plugin services, so the
  widget never touches the service directly. It reads
  `$XDG_RUNTIME_DIR/keycast/state.json`, which the service rewrites whenever
  its public state changes, and makes changes through the IPC commands above.
  That way it behaves the same on the stock bar and on custom bars.

## Privacy

Typed text is shown by default because it makes tutorials readable. It is
suppressed (the line shows `••••` or is cleared) when:

| Signal | Detection |
| --- | --- |
| Lock screen | `omarchy-shell lock isLocked` polled while recording; the buffer is cleared on lock and nothing is shown until unlock |
| Polkit dialog | Hyprland `openlayer>>omarchy-polkit` / `closelayer>>omarchy-polkit` |
| Password managers, pinentry | active window class matches `pinentry`, `1password`, `bitwarden`, `keepassxc`, `seahorse`, … |
| Login or sudo in a browser or terminal | active window title contains `password`, `sudo`, `sign in`, `log in`, `passphrase`, `2fa`, … |
| Terminal password prompts | after a text line containing `sudo`, `su`, `ssh`, `doas`, `passwd`, `pkexec`, `gpg`, `mysql -p` is ended by Enter, the next line is masked until Enter |
| Manual | `omarchy-shell keycast pause` / `resume` / `togglePause`, bindable to a key |

Combos and special keys are still shown while text is suppressed, because
`CTRL+V` does not reveal a secret.

The helper's recording gate means that, even if the plugin were compromised,
the privileged binary will not read keys unless the recording indicator is
on.

## Permission model

The helper is installed root-owned (it must not be writable by the user, since
it is the target of a passwordless pkexec) at `/usr/lib/keycast/keycastd`
(package) or `/usr/local/lib/keycast/keycastd` (install script). A polkit
action `dev.keycast.keycastd` with `org.freedesktop.policykit.exec.path` set
to that path and `allow_active=yes` lets the active local session start it
without a password prompt. `auth_admin_keep` is an option for stricter setups.

We rejected two alternatives:

- **The `input` group** lets every app you run read every keyboard all the time.
- **A Hyprland plugin** would need no device permissions, but it breaks on
  every Hyprland update and has to be rebuilt through hyprpm.

## Known limitations (v1)

- Devices plugged in after the recording starts are not picked up, because
  privileges are already dropped by then.
- Compose and dead-key sequences show their individual keys, not the
  composed character.
- A password typed into a browser field whose window title looks harmless
  is only protected by the pause hotkey and the terminal heuristics. The
  README says this prominently.
