#!/usr/bin/env bash
# Build the fin-host single-file binary (BUILD_PLAN §7.1) and the GUI it
# serves. Output: apps/host/dist-bin/fin-host + apps/desktop/dist/.
#
# The ad-hoc re-sign is load-bearing: bun's --compile injects the bundle
# after linking, leaving a stale "linker-signed" signature that macOS
# kills at exec (SIGKILL, exit 137). Distribution builds replace "-"
# with a Developer ID Application identity (see docs/PACKAGING.md).
set -euo pipefail
cd "$(dirname "$0")/.."
TARGET="${1:-bun-darwin-arm64}"
SIGN_IDENTITY="${SIGN_IDENTITY:--}"
( cd apps/desktop && bun run build )
( cd apps/host && bun build --compile --target="$TARGET" src/cli.ts --outfile dist-bin/fin-host )
codesign --force --sign "$SIGN_IDENTITY" apps/host/dist-bin/fin-host
echo "built + signed apps/host/dist-bin/fin-host ($TARGET, identity: $SIGN_IDENTITY)"
