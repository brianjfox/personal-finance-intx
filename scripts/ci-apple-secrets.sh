#!/usr/bin/env bash
# Put this Mac's Developer ID + notarization credentials into the GitHub
# repository secrets that .github/workflows/release.yml reads, so CI can
# sign and notarize the macOS dmg itself (docs/RELEASING.md).
#
#   scripts/ci-apple-secrets.sh
#
# Run it yourself, interactively: it exports the signing private key from
# the login keychain (macOS asks you to allow `security` to use the key),
# prompts for the Apple ID and an app-specific password (never echoed),
# sets the six secrets with `gh secret set`, and deletes the temp files.
# Nothing is printed or written outside a mode-700 temp directory.
set -euo pipefail
cd "$(dirname "$0")/.."

IDENTITY="${APPLE_SIGNING_IDENTITY:-$(security find-identity -v -p codesigning | sed -n 's/.*"\(Developer ID Application: [^"]*\)".*/\1/p' | head -1)}"
[ -n "$IDENTITY" ] || { echo "no Developer ID Application identity in the keychain" >&2; exit 1; }
TEAM_ID="$(sed -n 's/.*(\([A-Z0-9]\{10\}\))$/\1/p' <<<"$IDENTITY")"
REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
echo "identity: $IDENTITY"
echo "team id:  $TEAM_ID"
echo "repo:     $REPO"

TMP="$(mktemp -d)"; chmod 700 "$TMP"
cleanup() { rm -P -f "$TMP"/* 2>/dev/null || rm -f "$TMP"/*; rmdir "$TMP" 2>/dev/null || true; }
trap cleanup EXIT

read -r -p "Apple ID (e-mail used for notarization): " APPLE_ID
read -r -s -p "App-specific password for that Apple ID (appleid.apple.com → Sign-In and Security): " APPLE_PASSWORD; echo
[ -n "$APPLE_ID" ] && [ -n "$APPLE_PASSWORD" ] || { echo "Apple ID and password are required" >&2; exit 1; }

P12_PASSWORD="$(openssl rand -base64 24 | tr -d '\n')"
echo "exporting the identity to a .p12 (allow 'security' in the keychain dialog if asked)..."
security export -k login.keychain-db -t identities -f pkcs12 -P "$P12_PASSWORD" -o "$TMP/identities.p12"
# The export carries every identity in the keychain (e.g. Apple Development
# too); APPLE_SIGNING_IDENTITY tells the Tauri CLI which one to sign with.
base64 -i "$TMP/identities.p12" | tr -d '\n' > "$TMP/devid.b64"

echo "setting secrets on $REPO..."
gh secret set APPLE_CERTIFICATE          < "$TMP/devid.b64"
gh secret set APPLE_CERTIFICATE_PASSWORD --body "$P12_PASSWORD"
gh secret set APPLE_SIGNING_IDENTITY     --body "$IDENTITY"
gh secret set APPLE_ID                   --body "$APPLE_ID"
gh secret set APPLE_PASSWORD             --body "$APPLE_PASSWORD"
gh secret set APPLE_TEAM_ID              --body "$TEAM_ID"
echo
gh secret list
echo
echo "done. The next tag push produces a Developer ID signed + notarized dmg from CI."
echo "To exercise it now:  gh workflow run release -f tag=v$(sed -n 's/^  "version": "\(.*\)",$/\1/p' apps/desktop/src-tauri/tauri.conf.json)"
