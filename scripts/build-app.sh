#!/usr/bin/env bash
# Build the double-clickable macOS app (BUILD_PLAN §7): compile fin-host,
# stage it as the Tauri sidecar, and bundle "Corbits Personal Finance.app"
# (+ .dmg).
#
#   TRIPLE=aarch64-apple-darwin   (default) this Mac's architecture only
#   TRIPLE=universal-apple-darwin arm64 + x86_64 in one bundle (releases)
#   TRIPLE=x86_64-apple-darwin    Intel only
#
# Signing: ad-hoc by default (runs here, not distributable). To ship, set
# APPLE_SIGNING_IDENTITY="Developer ID Application: ..." (SIGN_IDENTITY
# is accepted as an alias). Notarization, either of:
#   - APPLE_ID + APPLE_PASSWORD + APPLE_TEAM_ID (or APPLE_API_KEY /
#     APPLE_API_ISSUER / APPLE_API_KEY_PATH): Tauri notarizes and staples
#     the .app before packing the .dmg — the CI path (release.yml).
#   - NOTARY_PROFILE=<notarytool keychain profile>: notarize + staple the
#     finished .dmg with notarytool — the local path (docs/PACKAGING.md).
# Extra arguments are passed to `tauri build` (e.g. --bundles app).
set -euo pipefail
cd "$(dirname "$0")/.."
TRIPLE="${TRIPLE:-aarch64-apple-darwin}"
SIGN_IDENTITY="${APPLE_SIGNING_IDENTITY:-${SIGN_IDENTITY:--}}"
export SIGN_IDENTITY
HOST_TRIPLE="$(rustc -vV | sed -n 's/^host: //p')"
BIN="apps/desktop/src-tauri/binaries"
TAURI_TARGET_ARGS=()
BUNDLE_DIR="apps/desktop/src-tauri/target/release/bundle"
mkdir -p "$BIN"

bun_target() { # rust arch -> bun compile target
  case "$1" in
    aarch64) echo bun-darwin-arm64 ;;
    x86_64)  echo bun-darwin-x64 ;;
    *) echo "unknown arch: $1" >&2; exit 1 ;;
  esac
}

case "$TRIPLE" in
  universal-apple-darwin)
    # One fat sidecar: Tauri looks for binaries/fin-host-universal-apple-darwin.
    ./scripts/build-host.sh "$(bun_target aarch64)" "$BIN/fin-host-aarch64-apple-darwin"
    BUILD_GUI=0 ./scripts/build-host.sh "$(bun_target x86_64)" "$BIN/fin-host-x86_64-apple-darwin"
    lipo -create -output "$BIN/fin-host-universal-apple-darwin" \
      "$BIN/fin-host-aarch64-apple-darwin" "$BIN/fin-host-x86_64-apple-darwin"
    codesign --force --sign "$SIGN_IDENTITY" "$BIN/fin-host-universal-apple-darwin"
    lipo -info "$BIN/fin-host-universal-apple-darwin"
    ;;
  aarch64-apple-darwin|x86_64-apple-darwin)
    ./scripts/build-host.sh "$(bun_target "${TRIPLE%%-*}")" "$BIN/fin-host-$TRIPLE"
    ;;
  *) echo "unsupported TRIPLE: $TRIPLE" >&2; exit 1 ;;
esac
if [ "$TRIPLE" != "$HOST_TRIPLE" ]; then
  TAURI_TARGET_ARGS=(--target "$TRIPLE")
  BUNDLE_DIR="apps/desktop/src-tauri/target/$TRIPLE/release/bundle"
fi

if [ "$SIGN_IDENTITY" != "-" ]; then
  # Let Tauri sign DURING bundling (sidecar + app, with the entitlements
  # from tauri.conf.json) so the .dmg contains the correctly signed app;
  # with APPLE_ID/APPLE_API_KEY credentials in the environment it also
  # notarizes and staples the .app before the .dmg is packed.
  export APPLE_SIGNING_IDENTITY="$SIGN_IDENTITY"
fi
( cd apps/desktop && bunx @tauri-apps/cli@^2 build "${TAURI_TARGET_ARGS[@]}" "$@" )

APP="$BUNDLE_DIR/macos/Corbits Personal Finance.app"
DMG=$(ls "$BUNDLE_DIR"/dmg/*.dmg 2>/dev/null | head -1 || true)
ENTITLEMENTS="apps/desktop/src-tauri/entitlements.plist"
if [ "$SIGN_IDENTITY" = "-" ]; then
  # Ad-hoc local build: proper bundle signing so `codesign --verify`
  # passes (the dmg stays ad-hoc; it is not distributable anyway).
  codesign --force --options runtime --entitlements "$ENTITLEMENTS" --sign - "$APP/Contents/MacOS/fin-host"
  codesign --force --options runtime --entitlements "$ENTITLEMENTS" --sign - "$APP"
else
  # Distribution: sign the dmg too.
  [ -n "$DMG" ] && codesign --force --sign "$SIGN_IDENTITY" "$DMG"
  if [ -n "${NOTARY_PROFILE:-}" ] && [ -n "$DMG" ]; then
    xcrun notarytool submit "$DMG" --keychain-profile "$NOTARY_PROFILE" --wait
    xcrun stapler staple "$DMG"
  fi
fi
codesign --verify --strict "$APP" && echo "bundle signature: valid ($SIGN_IDENTITY)"
echo
echo "bundle: $APP"
[ -n "$DMG" ] && echo "dmg:    $DMG"
if [ "$TRIPLE" = "universal-apple-darwin" ]; then
  lipo -info "$APP/Contents/MacOS/financial-interchange" "$APP/Contents/MacOS/fin-host"
fi
