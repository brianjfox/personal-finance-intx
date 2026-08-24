# Packaging (BUILD_PLAN §7)

How "Financial Interchange.app" is built, what it does at startup, and
what shipping it to another machine requires.

## Build

```bash
./scripts/build-host.sh      # compiled fin-host binary + GUI dist
./scripts/build-app.sh       # the .app and .dmg (Tauri v2)
# result: apps/desktop/src-tauri/target/release/bundle/macos/Financial Interchange.app
#         apps/desktop/src-tauri/target/release/bundle/dmg/*.dmg
```

Pieces:

- **fin-host** is compiled with `bun build --compile` into a single
  arm64 binary. The ad-hoc `codesign --force --sign -` after compilation
  is load-bearing: bun injects the JS bundle after linking, leaving a
  stale "linker-signed" signature that this macOS kills at exec
  (SIGKILL/137).
- **The Tauri shell** bundles that binary as the `fin-host` sidecar and
  the built GUI as a `gui/` resource. Do not set `strip = true` in the
  release profile: on this macOS it corrupts proc-macro dylibs
  ("mis-aligned LINKEDIT string pool") mid-build.

## Startup sequence (§7.2)

double-click → spawn `fin-host serve --data ~/Library/Application
Support/FinInterchange --gui <bundled> --port <free port>` → the host
runs migrations and resumes every parked run (deadline timers, chat
sessions, proposals at the approval gate) → the shell polls
`/api/health` → the window opens on the queue. Quitting the app (or the
menu-bar **Kill Switch**, Cmd+Shift+K) kills the host; parked runs stay
durable on disk and resume next launch.

The app and the CLI share the same data directory, so `fin-host ...`
commands operate on the same household.

## Credentials (§7.3)

The only secret in v1 is the Anthropic API key for the advisory agents.
Store it once in the login Keychain:

```bash
security add-generic-password -s fin-interchange -a anthropic -w '<KEY>'
```

The shell reads it at spawn and passes it to the host's environment; the
GUI process never sees key material, nothing writes it to disk, and
revocation is deleting that one Keychain item. Without it, everything
deterministic still works — only chat and model-drafted proposals need
it. Institution access remains read-only file drops; when API connectors
arrive, their read-only tokens follow the same Keychain pattern and the
withdrawal scope must not exist on the key — absent, not unused.

## Signing and distribution (§7.4)

The default build is **ad-hoc signed**: it runs on this machine and is
not distributable. To ship:

1. Get a **Developer ID Application** certificate into the login
   keychain (this machine currently has only an "Apple Development"
   identity, which cannot notarize).
2. Sign the sidecar and bundle with it:
   ```bash
   export SIGN_IDENTITY="Developer ID Application: Your Name (TEAMID)"
   export APPLE_SIGNING_IDENTITY="$SIGN_IDENTITY"   # used by tauri
   ./scripts/build-app.sh
   ```
   The entitlements (`src-tauri/entitlements.plist`) already carry the
   hardened-runtime JIT exceptions the Bun binary needs — that is the
   usual notarization snag, pre-solved.
3. Notarize and staple the dmg:
   ```bash
   xcrun notarytool submit <dmg> --apple-id <id> --team-id <team> --password <app-specific> --wait
   xcrun stapler staple <dmg>
   ```

## What is deliberately NOT in the bundle

- No auto-updater, no telemetry, no network surface beyond loopback and
  outbound HTTPS to the inference provider.
- No Windows/Linux targets (out of scope for v1).
- Execution stays disabled; packaging does not change Phase 5's status.
