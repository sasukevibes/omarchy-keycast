#!/bin/bash
# Build and install keycastd, the input helper for the keycast Omarchy plugin.
#
#   ./install.sh              build, install the helper and polkit action
#   ./install.sh --uninstall  remove them again
#
# The helper is installed root-owned: polkit lets the active session run it
# without a password, so it must never be writable by a normal user.

set -euo pipefail

PREFIX="${PREFIX:-/usr/local}"
HELPER="$PREFIX/lib/keycast/keycastd"
POLICY="/usr/share/polkit-1/actions/dev.keycast.keycastd.policy"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Build outside the plugin folder: the shell watches that folder and would
# reload plugins on every file cargo writes.
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/keycast/target}"

if [[ ${1:-} == --uninstall ]]; then
  sudo rm -f "$HELPER" "$POLICY"
  sudo rmdir --ignore-fail-on-non-empty "$(dirname "$HELPER")" 2>/dev/null || true
  echo "keycastd removed."
  exit 0
fi

command -v cargo >/dev/null || { echo "cargo is required: sudo pacman -S rust" >&2; exit 1; }

echo "Building keycastd..."
cargo build --release --locked --manifest-path "$ROOT/keycastd/Cargo.toml"

echo "Installing $HELPER and polkit action (needs sudo)..."
sudo install -D -m 0755 -o root -g root "$CARGO_TARGET_DIR/release/keycastd" "$HELPER"
sed "s|@HELPER@|$HELPER|" "$ROOT/packaging/dev.keycast.keycastd.policy.in" \
  | sudo install -D -m 0644 -o root -g root /dev/stdin "$POLICY"

echo "Done. keycast will show keys the next time you start a screen recording."
