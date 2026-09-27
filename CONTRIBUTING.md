# Contributing

Thanks for helping. Bug reports and pull requests are welcome.

## Before opening a pull request

```bash
cargo clippy --manifest-path keycastd/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path keycastd/Cargo.toml
node --test tests/*.test.js
omarchy plugin validate .
```

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
