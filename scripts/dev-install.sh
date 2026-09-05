#!/usr/bin/env bash
# Build the app from THIS checkout for THIS Mac and install it over the
# copy in /Applications: quit the running app, replace the bundle,
# relaunch. For trying main out before a release (docs/PACKAGING.md
# "Local dev builds", DECISIONS D-050). Ad-hoc signed, this architecture
# only, no dmg -- a few minutes incremental.
#
#   scripts/dev-install.sh              build + install + relaunch
#   NO_LAUNCH=1 scripts/dev-install.sh  build + install, don't relaunch
#   DEV_INSTALL_DIR=~/Applications ...  install somewhere else
#
# tauri.conf.json carries the updater's public key, so bundling needs
# the private key: UPDATER_KEY (default ../UPDATER-SIGNING.key) and
# UPDATER_KEY_PASSWORD_FILE (default ../UPDATER-SIGNING.password),
# relative to the repository -- the PFI root, outside git.
set -euo pipefail
cd "$(dirname "$0")/.."
APP_NAME="Corbits Personal Finance"
DEST="${DEV_INSTALL_DIR:-/Applications}/$APP_NAME.app"
PARENT="$(cd .. && pwd)"
KEY="${UPDATER_KEY:-$PARENT/UPDATER-SIGNING.key}"
PW_FILE="${UPDATER_KEY_PASSWORD_FILE:-$PARENT/UPDATER-SIGNING.password}"
[ -f "$KEY" ] || { echo "dev-install: updater signing key not found at $KEY (see docs/RELEASING.md, In-app updates)" >&2; exit 1; }
# The CLI's bundler reads the key CONTENTS (the _PATH variant is not honoured there).
TAURI_SIGNING_PRIVATE_KEY="$(cat "$KEY")"; export TAURI_SIGNING_PRIVATE_KEY
if [ -f "$PW_FILE" ]; then TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$(cat "$PW_FILE")"; export TAURI_SIGNING_PRIVATE_KEY_PASSWORD; fi

case "$(uname -m)" in
  arm64) TRIPLE=aarch64-apple-darwin ;;
  x86_64) TRIPLE=x86_64-apple-darwin ;;
  *) echo "dev-install: unsupported architecture $(uname -m)" >&2; exit 1 ;;
esac
HOST_TRIPLE="$(rustc -vV | sed -n 's/^host: //p')"
if [ "$TRIPLE" = "$HOST_TRIPLE" ]; then BUNDLE_DIR="apps/desktop/src-tauri/target/release/bundle"; else BUNDLE_DIR="apps/desktop/src-tauri/target/$TRIPLE/release/bundle"; fi

SHA="$(git rev-parse --short HEAD)"
echo "dev-install: building $SHA ($(git log -1 --format=%s)) for $TRIPLE"
[ -d node_modules ] || bun install --frozen-lockfile
TRIPLE="$TRIPLE" ./scripts/build-app.sh --bundles app
SRC="$BUNDLE_DIR/macos/$APP_NAME.app"
[ -d "$SRC" ] || { echo "dev-install: no bundle at $SRC" >&2; exit 1; }

# Replace the installed copy. The shell owns the host's life (D-043):
# stop both, in that order, then swap the bundle and relaunch.
if [ -d "$DEST" ]; then
  echo "dev-install: stopping the running app"
  pkill -f "$DEST/Contents/MacOS/financial-interchange" 2>/dev/null || true
  for _ in $(seq 1 20); do pgrep -f "$DEST/Contents/MacOS/" >/dev/null || break; sleep 1; done
  pkill -f "$DEST/Contents/MacOS/" 2>/dev/null || true
  rm -rf "$DEST"
fi
ditto "$SRC" "$DEST"
xattr -dr com.apple.quarantine "$DEST" 2>/dev/null || true
echo "dev-install: installed $SHA at $DEST"
if [ "${NO_LAUNCH:-0}" != 1 ]; then
  open -a "$DEST"
  echo "dev-install: relaunched"
fi
