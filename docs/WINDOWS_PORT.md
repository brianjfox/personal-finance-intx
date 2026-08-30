# Windows Port — Design (draft, 2026-08-30)

Corbits Personal Finance on Windows 10/11 x64, with the same GUI, the
same host, and an honest security story. This is a design for review,
not a plan in motion: the two load-bearing choices (§2, §3) are the
operator's to make, and each becomes a DECISIONS.md entry when made.

## 0. What already works

The architecture ports untouched. The GUI is dependency-light web
assets; `fin-host` cross-compiles from a Mac today
(`bun build --compile --target=bun-windows-x64`); `bun:sqlite`,
`node:crypto` (EB RS256, Coinbase EdDSA/ES256, Kraken HMAC), the
ledger, vault, actions, workflows, and every connector's HTTP path are
platform-free. Tauri v2 supports Windows on WebView2, sidecars
included, and the icon set already contains `icon.ico`.

What does NOT work today, precisely:

- `keychainSecretStore` returns null / **throws on `set`** off-darwin
  (`packages/institutions/src/secrets.ts:77`) — saving any credential
  on Windows crashes.
- Per-user encryption is **silently skipped** off-darwin
  (`apps/host/src/users.ts:191`) — users run plaintext while the login
  screen promises AES-256.
- `/api/open` uses `open`/`xdg-open` (`ipc.ts:267`); `defaultDataDir`
  has no win32 branch; Ledger Live import reads a macOS path; the
  Full Disk Access guidance and `x-apple.systempreferences` deep link
  are macOS concepts.
- Packaging is `build-app.sh` + codesign + notarytool — all macOS.

## 1. Principle

Same interfaces, per-platform implementations, truthful copy. Every
macOS-ism already sits behind a seam (`SecretStore`, `crypt.ts`'s six
functions, `/api/open`, `defaultDataDir`). The port adds Windows
implementations behind those seams and makes the GUI's security copy
platform-conditional — the app never claims protection it isn't
providing on the machine it's running on.

## 2. Secrets: Windows Credential Manager (decision needed)

macOS shells out to `security`; Windows mirrors the pattern by shelling
out to PowerShell (preinstalled everywhere).

**Recommended — W1: Credential Manager via PowerShell P/Invoke.** A
`credentialManagerSecretStore()` in `@fin/institutions` calls
`powershell -NoProfile -Command` with an inline `Add-Type` C# shim over
`Advapi32 CredRead/CredWrite/CredDelete/CredEnumerate`, storing generic
credentials named `fin-<service>/<account>` (values base64-wrapped like
the existing `b64:` convention, which also dodges quoting). Properties:
real OS credential store, protected per Windows account, visible to the
user in Credential Manager, and `CredEnumerate("fin-*")` gives the
delete-all-data sweep the same shape as the Keychain sweep.

**Fallback — W2: DPAPI blob file.** If `Add-Type` is blocked
(constrained language mode on managed machines), a `credstore.bin` of
`ProtectedData.Protect(CurrentUser)` blobs, one per service/account.
Same interface, weaker discoverability. Ship W1, detect the failure
once at startup, fall back to W2 with a logged notice.

Both: PowerShell spawns cost 200–500ms, so the store gets a small
in-process cache invalidated by set/delete (reads happen per fetch;
`scopedSecretStore` prefixing is untouched). `defaultSecretStore()`
picks by `process.platform`.

## 3. At-rest encryption: delegate to the disk, say so (THE decision)

The hdiutil sparsebundle trick — per-user AES-256 volume mounted at
`users/<id>` so no path changes, re-keyed by `chpass` — has **no
Windows twin** without either admin+Pro-edition (BitLocker VHDX) or an
invasive rewrite (SQLCipher ledger + encrypted vault blobs).

**Recommended for v1 — delegate + disclose.** On Windows: app-level
sign-in stays mandatory (scrypt hashes, Bearer-token API, exactly as
today); secrets live in Credential Manager (§2); at-rest encryption of
the data directory is delegated to Windows Device Encryption/BitLocker,
which is on by default on most Windows 11 machines. The host exposes
`encrypted: "volume" | "os-disk" | "none"` per user (probing BitLocker
status via `Get-BitLockerVolume`/`manage-bde -status`, read-only), and
the login screen's copy renders accordingly — the AES-256 sentence is
macOS copy; Windows says what is actually true, including a plain
warning when the disk reports unencrypted.

**Upgrade path — v2, if wanted:** SQLCipher for the ledger plus
per-file vault encryption under a scrypt-derived key. Real project,
touches `@fin/ledger` and `@fin/vault`; only worth it if Windows users
with unencrypted disks are an audience we care about.

Mechanically: `crypt.ts`'s functions move behind a `StoreCrypt`
interface — darwin keeps hdiutil; win32 is a no-op that reports the
os-disk status; `users.ts:191`'s silent platform check becomes an
explicit capability. `changeMyPassword` on Windows re-hashes only (no
volume to re-key).

## 4. Platform touchpoints (mechanical)

| Touchpoint | Windows behavior |
| --- | --- |
| `defaultDataDir` | `%APPDATA%\CorbitsPersonalFinance` (win32 branch; fresh platform, no migration) |
| `/api/open` | `cmd /c start "" <url>`; the `x-apple.systempreferences` branch refuses with plain words |
| Ledger Live import | `%APPDATA%\Ledger Live`; the TCC/Full-Disk-Access banner becomes a permissions-free path (no TCC on Windows) |
| Ledger EPERM guidance | macOS-only UI branch, hidden on Windows |
| GUI copy | 15 "this Mac"/"your Mac" strings + Keychain mentions become platform-worded; `/api/health` already reachable pre-auth can carry `platform` for the GUI |
| delete-all-data | Credential Manager sweep (`CredEnumerate fin-*`) replaces the Keychain sweep; WebView2 state at `%LOCALAPPDATA%\com.corbitsdev.macos.personal-finance` noted in the "what we can't revoke" copy |
| Sidecar | `binaries/fin-host-x86_64-pc-windows-msvc.exe`; the codesign-after-compile gotcha is macOS-only |
| `--lan` | unchanged, but Windows Firewall prompts on first bind — document it |

## 5. Build & CI

Tauri cannot bundle Windows installers from macOS; the supported path
is CI:

- GitHub Actions `windows-latest`: bun install → typecheck → tests →
  GUI build → host compile (`bun-windows-x64`) → `tauri build`
  producing an **NSIS** installer with the WebView2
  `downloadBootstrapper` mode (MSI optional later).
- Signing: unsigned at first (friends-and-family; SmartScreen will
  warn) — an Authenticode/EV cert is its own purchase decision.
- Tests in CI as a macos+windows matrix. The hdiutil and Keychain
  suites gain `skipIf(platform !== "darwin")` guards (they already
  fail under sandbox; this makes the gating principled), and the new
  Credential Manager store gets its own suite that runs only on the
  Windows runner.

## 6. Test plan

CI green on both runners, then a manual smoke on a Windows 11 VM:
demo seed → nightly → dashboard/cash flow; save+read+delete a
credential (visible in Credential Manager); Plaid Hosted Link (system
browser + the 7787 loopback finish); EB consent; fetch logs; privacy
eye; theme Auto (WebView2 honors `prefers-color-scheme`); `--lan` from
a phone incl. the firewall prompt; delete-all-data sweep; login copy
truthfulness on a BitLocker-off VM.

## 7. Sequencing (≈5–7 focused days)

1. Seams: `StoreCrypt` interface, `defaultSecretStore` platform pick,
   win32 dirs/open — the app still fully green on macOS. (1–2d)
2. Credential Manager store + fallback + tests. (1d)
3. Truthful copy: `encrypted` capability through `/api/users`,
   platform wording sweep. (0.5d)
4. CI windows job + NSIS bundle; first installer artifact. (1d)
5. VM smoke + fixes; PACKAGING.md gains a Windows section. (1–2d)

## 8. Open questions for the operator

1. **Accept delegate-and-disclose for at-rest v1** (§3)? This is the
   one that shapes everything downstream.
2. Authenticode signing: buy a cert, or ship unsigned to start?
3. Windows Home machines (Device Encryption present but BitLocker
   tooling absent): is "encrypted: none + warning" acceptable there?
4. ARM64 Windows: Bun's compile target is x64-only today — is x64
   emulation acceptable, or park ARM?
5. Data dir name: `%APPDATA%\CorbitsPersonalFinance` — bless it.
