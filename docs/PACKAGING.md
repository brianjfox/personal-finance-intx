# Packaging (BUILD_PLAN §7)

How "Financial Interchange.app" is built, what it does at startup, and
what shipping it to another machine requires.

Versioned releases — the tag, the CI run, the draft GitHub release
with the universal dmg and the Windows installer — are in
[RELEASING.md](RELEASING.md). This document is about the build itself.

## Build

```bash
./scripts/build-host.sh [bun-target] [outfile]   # compiled fin-host binary + GUI dist
./scripts/build-app.sh                            # the .app and .dmg (Tauri v2), this Mac's arch
TRIPLE=universal-apple-darwin ./scripts/build-app.sh   # arm64 + x86_64 in one app (what releases ship)
# result: apps/desktop/src-tauri/target/release/bundle/macos/Corbits Personal Finance.app
#         apps/desktop/src-tauri/target/release/bundle/dmg/*.dmg
#         (universal: target/universal-apple-darwin/release/bundle/...)
```

Pieces:

- **fin-host** is compiled with `bun build --compile` into a single
  binary per architecture (`bun-darwin-arm64`, `bun-darwin-x64`,
  `bun-windows-x64`). The ad-hoc `codesign --force --sign -` after
  compilation is load-bearing on macOS: bun injects the JS bundle after
  linking, leaving a stale "linker-signed" signature that this macOS
  kills at exec (SIGKILL/137).
- **Universal builds** compile both darwin slices, `lipo` them into
  `binaries/fin-host-universal-apple-darwin` (the name Tauri expects for
  `--target universal-apple-darwin`), re-sign, and let Tauri compile the
  shell for both targets (`rustup target add x86_64-apple-darwin` once).
  The x86_64 slice runs under Rosetta with a harmless "CPU lacks AVX
  support" warning from bun (Rosetta hides AVX; every Intel Mac on
  macOS 13+ has it). Bun's `bun-darwin-x64-baseline` target builds and
  runs too, but prints the same warning under Rosetta, so the plain
  x64 build is kept; the release workflow smoke-tests the Intel slice
  under Rosetta on the arm64 runner.
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

## The menu bar (D-046)

The shell carries the platform's standard menus. The **app menu** has
About (the native panel, version from `Cargo.toml`), Settings… (⌘,),
Check for Updates… (the host asks GitHub for the newest published
release; the GUI compares it with its own version and shows a link --
nothing downloads or installs itself), the Kill Switch, and on macOS
Services, Hide, Hide Others, Show All, and Quit. **File**: New Window
(re-shows the window; the app is single-window), Close Window (hides
it, per D-043), Print… (the page's print dialog). **Edit**: Undo, Redo,
Cut, Copy, Paste, Select All. **View**: Enter Full Screen. **Window**:
Minimize, Zoom, Bring All to Front, plus macOS's own window list.
**Help**: the app's help (every Tricks & Tips line, with links to the
releases and the issue tracker), Release Notes, Report an Issue…; on
macOS this is the Help menu NSApp searches.

Menu items the page handles reach it as one DOM event, `fin:menu`, with
the action as its detail (`settings`, `check-updates`, `print`, `help`,
`about`); the shell injects it with `eval` since the page is served by
the host over localhost and uses no Tauri API.

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
it. Institution access is read-only: file drops, plus the Plaid and Enable
Banking connectors, whose read-only tokens follow the same Keychain
pattern (services `fin-plaid` / `fin-enablebanking`; see
docs/CONNECTORS.md). The withdrawal scope does not exist on any of these
credentials — absent, not unused.

## Signing and distribution (§7.4)

The default build is **ad-hoc signed**: it runs on this machine and is
not distributable. To ship:

1. Get a **Developer ID Application** certificate into the login
   keychain (present on this machine since 2026-08-24: team UZHK52XR6P).
2. Sign the sidecar and bundle with it (Tauri's own variable;
   `SIGN_IDENTITY` is accepted as an alias):
   ```bash
   export APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAMID)"
   TRIPLE=universal-apple-darwin ./scripts/build-app.sh
   ```
   The entitlements (`src-tauri/entitlements.plist`) already carry the
   hardened-runtime JIT exceptions the Bun binary needs — that is the
   usual notarization snag, pre-solved.
3. Notarize and staple, one of two ways:
   - **Locally**, with the `fin-notary` keychain profile (created once
     with `xcrun notarytool store-credentials`): add
     `NOTARY_PROFILE=fin-notary` to the command above and the script
     submits the finished dmg and staples it. To check afterwards:
     ```bash
     spctl --assess --type execute -v "<...>/Corbits Personal Finance.app"   # accepted, Notarized Developer ID
     ```
   - **Through Tauri** (what CI does, RELEASING.md): with `APPLE_ID`,
     `APPLE_PASSWORD`, `APPLE_TEAM_ID` (or the App Store Connect API key
     trio) in the environment, `tauri build` notarizes and staples the
     `.app` *before* packing the dmg — the fully-offline install story
     (a stapled app inside the dmg needs no round-trip to Apple on the
     installing Mac).

   First notarization done 2026-08-24 (submission 6f1634d0, Accepted).

## Windows (CI only)

Tauri cannot bundle Windows installers from macOS, so the Windows build
lives in CI (`.github/workflows/ci.yml` on every push, and
`release.yml` for tagged releases; WINDOWS_PORT §5):

- The `test` matrix runs the full suite on `macos-latest` and
  `windows-latest`; the win32-gated live Credential Manager / DPAPI
  suite (`packages/institutions/test/secrets-windows-live.test.ts`)
  executes only on the Windows runner.
- The `windows-installer` job compiles fin-host with
  `scripts/build-host.sh bun-windows-x64 <sidecar slot>`
  (`src-tauri/binaries/fin-host-x86_64-pc-windows-msvc.exe` — the
  script skips codesign off-darwin; that gotcha is macOS-only), then
  runs `tauri build --bundles nsis`. WebView2 ships in
  `downloadBootstrapper` mode: the installer fetches the runtime only
  on machines that lack it (stock Windows 11 has it).
- The `*-setup.exe` under `bundle/nsis/` is uploaded as the
  `windows-installer` workflow artifact.

The installer is **unsigned** (DECISIONS.md D-038): SmartScreen will
warn on first run — "More info → Run anyway" is the expected path for
friends-and-family installs. An Authenticode cert is a separate
purchase decision; x64 only, MSI optional later.

## What is deliberately NOT in the bundle

- No auto-updater, no telemetry, no network surface beyond loopback and
  outbound HTTPS to the inference provider.
- No Linux targets (out of scope for v1); Windows is CI-built only
  (above), never from this machine.
- Execution stays disabled; packaging does not change Phase 5's status.
