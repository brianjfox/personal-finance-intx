#!/usr/bin/env bash
# Build the fin-host single-file binary (BUILD_PLAN §7.1) and the GUI it
# serves.
#
#   scripts/build-host.sh [bun-target] [outfile]
#     bun-target  bun-darwin-arm64 (default) | bun-darwin-x64 | bun-windows-x64
#     outfile     apps/host/dist-bin/fin-host (default)
#   BUILD_GUI=0   skip the GUI build (when a caller already built it)
#
# The ad-hoc re-sign of darwin binaries is load-bearing: bun's --compile
# injects the bundle after linking, leaving a stale "linker-signed"
# signature that macOS kills at exec (SIGKILL, exit 137). Ad-hoc is all
# this step needs: Tauri re-signs the sidecar with the Developer ID during
# bundling (see docs/PACKAGING.md). Windows binaries are not signed
# (DECISIONS D-038).
set -euo pipefail
cd "$(dirname "$0")/.."
TARGET="${1:-bun-darwin-arm64}"
OUT="${2:-apps/host/dist-bin/fin-host}"
SIGN_IDENTITY="${SIGN_IDENTITY:--}"
# Relative outfiles stay relative (no $PWD prefix) so the Windows CI
# runner's Git Bash never has to translate a POSIX path for bun.exe.
case "$OUT" in /*) OUT_FROM_HOST="$OUT" ;; *) OUT_FROM_HOST="../../$OUT" ;; esac
mkdir -p "$(dirname "$OUT")"
if [ "${BUILD_GUI:-1}" != "0" ]; then ( cd apps/desktop && bun run build ); fi
( cd apps/host && bun build --compile --target="$TARGET" src/cli.ts --outfile "$OUT_FROM_HOST" )
case "$TARGET" in
  bun-darwin-*)
    codesign --force --sign "$SIGN_IDENTITY" "$OUT"
    echo "built + signed $OUT ($TARGET, identity: $SIGN_IDENTITY)" ;;
  *)
    echo "built $OUT ($TARGET)" ;;
esac
