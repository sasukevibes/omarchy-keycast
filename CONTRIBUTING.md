# Contributing

Thanks for helping. Bug reports and pull requests are welcome.

## Before opening a pull request

```bash
cargo clippy --manifest-path keycastd/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path keycastd/Cargo.toml
node --test tests/*.test.js
omarchy plugin validate .
```

The settings integration test uses Quickshell, the Omarchy shell UI, and
Sway's headless backend with software rendering. It runs the real widget and
service on a private Wayland display with temporary settings and fake input;
it never connects to your desktop or reads input devices. It skips when these
test dependencies are unavailable. To save a test-panel screenshot, install
`grim` and run `KEYCAST_TEST_SCREENSHOT=/tmp/keycast-settings.png node --test tests/settings.test.js`.

To try the overlay against your running shell, run `scripts/dev-sync --restart`.
To work on it without installing the helper, point `helperCommand` in
`~/.config/keycast/config.json` at `tests/fake-keycastd`.

## Guidelines

- Keep display logic in `lib/Model.js` and cover it with tests. The QML files
  only render.
- Changes to `keycastd`'s privilege handling or the recording gate get extra
  scrutiny. Explain the reasoning in the pull request.
- One change per pull request. Every pull request is reviewed by the
  maintainer before it merges.

See [docs/DESIGN.md](docs/DESIGN.md) for the architecture and protocol.
