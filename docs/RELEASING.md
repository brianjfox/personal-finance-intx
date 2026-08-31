# Releasing

How a version of Corbits Personal Finance gets a number, gets built, and
gets published. One command on this Mac, one tag, one CI run, one click.

## The shape

```
docs/releases/X.Y.Z.md  ──►  scripts/release.sh X.Y.Z  ──►  tag vX.Y.Z pushed
                                                                  │
                              .github/workflows/release.yml  ◄────┘
                              verify → test (macOS + Windows) → build → DRAFT release
                                                                  │
                              gh release edit vX.Y.Z --draft=false  (you, after a look)
```

The version lives in **one place**: `apps/desktop/src-tauri/tauri.conf.json`.
It stamps the bundle, the dmg/installer filenames, and the About popup
(`App.tsx` imports the file). `Cargo.toml` and `Cargo.lock` are kept in
step by the script so `cargo` agrees. Root/workspace `package.json`
files are unversioned (`0.0.0`) on purpose — nothing is published to a
registry.

Semver, tags `vX.Y.Z`. A `-` suffix (`0.3.0-rc.1`) marks a GitHub
pre-release.

## Cutting a release

1. **Write the notes** — `docs/releases/X.Y.Z.md`, first line
   `# Corbits Personal Finance X.Y.Z`, same shape as `0.1.1.md`. Commit
   them on main:
   ```
   git commit -m "docs(release): add perfi X.Y.Z release notes"
   git push
   ```
   The workflow refuses a tag without its notes file.
2. **Cut it** (from main, clean tree, in sync with origin):
   ```
   scripts/release.sh X.Y.Z            # stamp + commit + tag + push
   scripts/release.sh X.Y.Z --dry-run  # only check the preconditions
   scripts/release.sh X.Y.Z --no-push  # stamp/commit/tag, push yourself
   ```
   This writes the version into `tauri.conf.json`, `Cargo.toml`,
   `Cargo.lock`, commits `chore(release): perfi X.Y.Z`, tags `vX.Y.Z`,
   and pushes main and the tag.
3. **Watch** — `gh run watch`, or the Actions tab. The `release`
   workflow runs the full test suite on macOS and Windows, then builds
   the artifacts (≈10–25 minutes; the universal macOS build compiles the
   shell twice).
4. **Review and publish** the draft — `gh release view vX.Y.Z --web`.
   Download the dmg, open it, check the About popup shows X.Y.Z. Then:
   ```
   gh release edit vX.Y.Z --draft=false
   ```
   The draft is the deliberate gate: nothing is public until this.

## What the release contains

| Asset | What |
| --- | --- |
| `Corbits-Personal-Finance-X.Y.Z-macOS-universal.dmg` | The app, one universal binary (Apple silicon + Intel); the `fin-host` sidecar inside is a fat binary too |
| `Corbits-Personal-Finance-X.Y.Z-Windows-x64-setup.exe` | NSIS installer, WebView2 bootstrapper mode; **unsigned** (D-038) |
| `SHA256SUMS.txt` | `shasum -a 256 -c SHA256SUMS.txt` |

Only what an installer needs. The `fin-host` CLI ships inside both
bundles (`Contents/MacOS/fin-host`; the install directory on Windows)
and is not a separate download.

The release body is `docs/releases/X.Y.Z.md` followed by a generated
**Downloads** section that says truthfully whether the macOS build is
notarized or ad-hoc signed.

## macOS signing in CI

Without secrets the workflow still succeeds, but the dmg is **ad-hoc
signed** and the draft notes say so — Gatekeeper will refuse it on
other Macs. To ship a notarized build from CI, add these repository
secrets once — `scripts/ci-apple-secrets.sh` does all six interactively
on the release Mac (it exports the identity, asks for the Apple ID and
an app-specific password, and cleans up after itself); by hand it is
`gh secret set NAME`:

| Secret | Value |
| --- | --- |
| `APPLE_CERTIFICATE` | base64 of the Developer ID Application `.p12`: `base64 -i cert.p12 \| pbcopy` (export from Keychain Access with a password) |
| `APPLE_CERTIFICATE_PASSWORD` | that export password |
| `APPLE_SIGNING_IDENTITY` | `Developer ID Application: BRIAN FOX (UZHK52XR6P)` |
| `APPLE_ID` | the Apple ID e-mail |
| `APPLE_PASSWORD` | an app-specific password (appleid.apple.com → Sign-In and Security) |
| `APPLE_TEAM_ID` | `UZHK52XR6P` |

The workflow imports the certificate into a throwaway keychain (the
.p12 may carry every identity on the release Mac — `APPLE_SIGNING_IDENTITY`
picks the one to use), then the Tauri CLI signs the sidecar, the app,
and the dmg with the hardened runtime and `entitlements.plist`,
notarizes and staples the `.app`, and packs the dmg — so the stapled
app is what the dmg carries (the fully-offline install story
PACKAGING.md asked for). Omit `APPLE_ID`/`APPLE_PASSWORD`/`APPLE_TEAM_ID`
to sign without notarizing.

### Building the same artifact locally

The release machine can also produce the universal dmg itself (the
Developer ID cert and the `fin-notary` notarytool profile are in its
keychain):

```bash
APPLE_SIGNING_IDENTITY="Developer ID Application: BRIAN FOX (UZHK52XR6P)" \
NOTARY_PROFILE=fin-notary \
TRIPLE=universal-apple-darwin ./scripts/build-app.sh
# apps/desktop/src-tauri/target/universal-apple-darwin/release/bundle/dmg/*.dmg
```

To replace CI's ad-hoc dmg with it on the draft:

```bash
gh release upload vX.Y.Z "Corbits-Personal-Finance-X.Y.Z-macOS-universal.dmg" --clobber
```

(and regenerate `SHA256SUMS.txt` accordingly).

## Re-running

The workflow is re-entrant: **Actions → release → Run workflow** with an
existing tag rebuilds everything and re-attaches the assets to the same
draft (`--clobber`). A tag is never moved; a bad build gets a new patch
version.

## Where the sharp edges are

- `bun build --compile` leaves a stale signature on darwin binaries;
  `build-host.sh` re-signs (ad-hoc, or with your identity) — see
  PACKAGING.md. The universal sidecar is `lipo`'d from the arm64 and
  x86_64 compiles, then re-signed.
- Tauri wants the fat sidecar at
  `binaries/fin-host-universal-apple-darwin`; `build-app.sh` puts it
  there.
- `release.sh` uses BSD `sed -i ''` — it runs on the Mac, by design.
- Windows installers can only be bundled on Windows, hence CI.
