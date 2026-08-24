#!/usr/bin/env bash
# Build the double-clickable macOS app (BUILD_PLAN §7): compile fin-host,
# stage it as the Tauri sidecar, and bundle "Financial Interchange.app"
# (+ .dmg). Ad-hoc signed by default; export SIGN_IDENTITY="Developer ID
# Application: ..." (and see docs/PACKAGING.md for notarization) to ship.
set -euo pipefail
cd "$(dirname "$0")/.."
TRIPLE="${TRIPLE:-aarch64-apple-darwin}"
./scripts/build-host.sh "bun-darwin-${TRIPLE%%-*}" 2>/dev/null || ./scripts/build-host.sh
mkdir -p apps/desktop/src-tauri/binaries
cp apps/host/dist-bin/fin-host "apps/desktop/src-tauri/binaries/fin-host-${TRIPLE}"
cd apps/desktop
bunx @tauri-apps/cli@^2 build "$@"
cd ../..

# Proper bundle signing (inner binaries first, then the bundle). Ad-hoc
# by default; a Developer ID identity + entitlements is what notarization
# verifies (docs/PACKAGING.md).
SIGN_IDENTITY="${SIGN_IDENTITY:--}"
APP="apps/desktop/src-tauri/target/release/bundle/macos/Financial Interchange.app"
ENTITLEMENTS="apps/desktop/src-tauri/entitlements.plist"
codesign --force --options runtime --entitlements "$ENTITLEMENTS" --sign "$SIGN_IDENTITY" "$APP/Contents/MacOS/fin-host"
codesign --force --options runtime --entitlements "$ENTITLEMENTS" --sign "$SIGN_IDENTITY" "$APP"
codesign --verify --strict "$APP" && echo "bundle signature: valid ($SIGN_IDENTITY)"
echo
echo "bundle: $APP"
