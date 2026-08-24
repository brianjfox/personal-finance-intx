#!/usr/bin/env bash
# Build the double-clickable macOS app (BUILD_PLAN §7): compile fin-host,
# stage it as the Tauri sidecar, and bundle "Financial Interchange.app"
# (+ .dmg). Ad-hoc signed by default; export SIGN_IDENTITY="Developer ID
# Application: ..." (and see docs/PACKAGING.md for notarization) to ship.
set -euo pipefail
cd "$(dirname "$0")/.."
TRIPLE="${TRIPLE:-aarch64-apple-darwin}"
SIGN_IDENTITY="${SIGN_IDENTITY:--}"
./scripts/build-host.sh "bun-darwin-${TRIPLE%%-*}" 2>/dev/null || ./scripts/build-host.sh
mkdir -p apps/desktop/src-tauri/binaries
cp apps/host/dist-bin/fin-host "apps/desktop/src-tauri/binaries/fin-host-${TRIPLE}"
cd apps/desktop
if [ "$SIGN_IDENTITY" != "-" ]; then
  # Let Tauri sign DURING bundling (sidecar + app, with the entitlements
  # from tauri.conf.json) so the .dmg contains the correctly signed app.
  export APPLE_SIGNING_IDENTITY="$SIGN_IDENTITY"
fi
bunx @tauri-apps/cli@^2 build "$@"
cd ../..

APP="apps/desktop/src-tauri/target/release/bundle/macos/Financial Interchange.app"
DMG=$(ls apps/desktop/src-tauri/target/release/bundle/dmg/*.dmg 2>/dev/null | head -1 || true)
ENTITLEMENTS="apps/desktop/src-tauri/entitlements.plist"
if [ "$SIGN_IDENTITY" = "-" ]; then
  # Ad-hoc local build: proper bundle signing so `codesign --verify`
  # passes (the dmg stays ad-hoc; it is not distributable anyway).
  codesign --force --options runtime --entitlements "$ENTITLEMENTS" --sign - "$APP/Contents/MacOS/fin-host"
  codesign --force --options runtime --entitlements "$ENTITLEMENTS" --sign - "$APP"
else
  # Distribution: sign the dmg too, then notarize + staple it
  # (docs/PACKAGING.md).
  [ -n "$DMG" ] && codesign --force --sign "$SIGN_IDENTITY" "$DMG"
fi
codesign --verify --strict "$APP" && echo "bundle signature: valid ($SIGN_IDENTITY)"
echo
echo "bundle: $APP"
[ -n "$DMG" ] && echo "dmg:    $DMG"
