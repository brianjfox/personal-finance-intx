// Windows secret stores (docs/WINDOWS_PORT.md §2, DECISIONS D-038).
// W1: Windows Credential Manager via `powershell -NoProfile
// -NonInteractive -Command` running an inline Add-Type C# shim over
// Advapi32 CredRead/CredWrite/CredDelete/CredEnumerate. Generic
// credentials are named `<service>/<account>` -- services already
// carry the fin- prefix, so `CredEnumerate("fin-*")` finds every item
// for the delete-all-data sweep, and the user sees them in the
// Credential Manager control panel.
//
// W2: when the Add-Type shim can't compile (no C# compiler on the
// box), a DPAPI blob file: credstore.bin holds one
// ProtectedData.Protect(CurrentUser) blob per service/account. Same
// SecretStore interface, weaker discoverability. windowsSecretStore()
// probes the shim ONCE at construction and commits to W1 or W2 for
// the process lifetime, logging the fallback. Note: strict
// Constrained Language Mode blocks Add-Type entirely -- including
// W2's `Add-Type -AssemblyName` -- so W2 covers the compiler-missing
// case, not a CLM lockdown.
//
// Everything crossing the PowerShell boundary -- target names in,
// values in and out -- travels base64-encoded, so no secret or name
// is ever quoted into a script (the same motivation as the Keychain
// `b64:` convention, applied unconditionally). The credential blob
// itself stores the raw UTF-8 value bytes.
//
// PowerShell spawns cost 200-500ms, so each store keeps a small
// in-process cache, written through by set and invalidated by delete.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { SecretStore } from "./secrets";

export interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Test seam: how a store shells out. The default wraps spawnSync. */
export type CommandRunner = (command: string, args: string[]) => RunResult;

function spawnRunner(command: string, args: string[]): RunResult {
  // 15s cap, matching the BitLocker probe: a hung PowerShell (AV scan,
  // profile server) must not wedge the host.
  const r = spawnSync(command, args, { encoding: "utf8", windowsHide: true, timeout: 15_000 });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

const toB64 = (s: string): string => Buffer.from(s, "utf8").toString("base64");
const fromB64 = (s: string): string => Buffer.from(s, "base64").toString("utf8");

function runPowerShell(run: CommandRunner, script: string): RunResult {
  return run("powershell", ["-NoProfile", "-NonInteractive", "-Command", script]);
}

// The Advapi32 shim. Compiled by Add-Type on every spawn (each
// PowerShell process is fresh); kept C#-5-plain so Windows PowerShell
// 5.1's bundled compiler accepts it. Exit-code convention for the
// scripts below: 0 = ok, 3 = not found, anything else = error.
const CRED_SHIM = `using System;
using System.Runtime.InteropServices;
public static class FinCred {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public uint Flags; public uint Type; public string TargetName; public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public uint CredentialBlobSize; public IntPtr CredentialBlob;
    public uint Persist; public uint AttributeCount; public IntPtr Attributes;
    public string TargetAlias; public string UserName;
  }
  [DllImport("advapi32", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredReadW(string target, uint type, uint flags, out IntPtr cred);
  [DllImport("advapi32", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredWriteW(ref CREDENTIAL cred, uint flags);
  [DllImport("advapi32", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredDeleteW(string target, uint type, uint flags);
  [DllImport("advapi32", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredEnumerateW(string filter, uint flags, out uint count, out IntPtr creds);
  [DllImport("advapi32")]
  static extern void CredFree(IntPtr buffer);
  const uint GENERIC = 1; const uint PERSIST_LOCAL_MACHINE = 2;
  public static string Read(string target) {
    IntPtr p;
    if (!CredReadW(target, GENERIC, 0, out p)) return null;
    try {
      CREDENTIAL c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL));
      byte[] bytes = new byte[c.CredentialBlobSize];
      if (c.CredentialBlobSize > 0) Marshal.Copy(c.CredentialBlob, bytes, 0, (int)c.CredentialBlobSize);
      return Convert.ToBase64String(bytes);
    } finally { CredFree(p); }
  }
  public static void Write(string target, string b64) {
    byte[] bytes = Convert.FromBase64String(b64);
    IntPtr blob = Marshal.AllocHGlobal(bytes.Length == 0 ? 1 : bytes.Length);
    try {
      Marshal.Copy(bytes, 0, blob, bytes.Length);
      CREDENTIAL c = new CREDENTIAL();
      c.Type = GENERIC; c.TargetName = target; c.CredentialBlobSize = (uint)bytes.Length;
      c.CredentialBlob = blob; c.Persist = PERSIST_LOCAL_MACHINE; c.UserName = "fin";
      if (!CredWriteW(ref c, 0)) throw new Exception("CredWrite failed: " + Marshal.GetLastWin32Error());
    } finally { Marshal.FreeHGlobal(blob); }
  }
  public static bool Delete(string target) { return CredDeleteW(target, GENERIC, 0); }
  public static string[] List(string filter) {
    uint n; IntPtr arr;
    if (!CredEnumerateW(filter, 0, out n, out arr)) return new string[0];
    try {
      string[] targets = new string[n];
      for (int i = 0; i < n; i++) {
        IntPtr p = Marshal.ReadIntPtr(arr, i * IntPtr.Size);
        CREDENTIAL c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL));
        targets[i] = c.TargetName;
      }
      return targets;
    } finally { CredFree(arr); }
  }
}`;

// Single-quoted here-string: no interpolation, and the shim contains
// no line starting with '@.
const SHIM_HEADER = `$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
${CRED_SHIM}
'@
`;

const decodeTarget = (b64: string): string => `$t=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}'))`;

function credGetScript(target: string): string {
  return `${SHIM_HEADER}${decodeTarget(toB64(target))}
$v=[FinCred]::Read($t)
if ($null -eq $v) { exit 3 }
[Console]::Out.Write($v)`;
}

function credSetScript(target: string, value: string): string {
  return `${SHIM_HEADER}${decodeTarget(toB64(target))}
[FinCred]::Write($t,'${toB64(value)}')`;
}

function credDeleteScript(target: string): string {
  return `${SHIM_HEADER}${decodeTarget(toB64(target))}
if (-not [FinCred]::Delete($t)) { exit 3 }`;
}

function credEnumerateScript(pattern: string): string {
  return `${SHIM_HEADER}$f=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${toB64(pattern)}'))
foreach ($t in [FinCred]::List($f)) { [Console]::Out.WriteLine([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($t))) }`;
}

/** Compiles the shim and prints a marker: the one-time W1/W2 probe. */
function credProbeScript(): string {
  return `${SHIM_HEADER}[Console]::Out.Write('fin-credman-ok')`;
}

export interface CredentialManagerOpts {
  /** Test seam: replaces the real PowerShell spawn. */
  run?: CommandRunner;
}

/** W1: Windows Credential Manager, generic credentials named `<service>/<account>`. */
export function credentialManagerSecretStore(opts: CredentialManagerOpts = {}): SecretStore {
  const run = opts.run ?? spawnRunner;
  const cache = new Map<string, string | null>();
  const target = (service: string, account: string): string => `${service}/${account}`;
  return {
    get(service, account) {
      const t = target(service, account);
      const hit = cache.get(t);
      if (hit !== undefined) return hit;
      const r = runPowerShell(run, credGetScript(t));
      // Exit 3 is the genuine not-found; any other failure (spawn error,
      // AV stall) is transient and must not hide the credential for the
      // process lifetime -- return null without caching, so the next
      // read re-spawns.
      if (r.status !== 0 && r.status !== 3) return null;
      const decoded = r.status === 0 ? fromB64(r.stdout.trim()) : "";
      const v = decoded === "" ? null : decoded;
      cache.set(t, v);
      return v;
    },
    set(service, account, value) {
      const t = target(service, account);
      const r = runPowerShell(run, credSetScript(t, value));
      if (r.status !== 0) throw new Error(`Credential Manager write failed for ${t}: ${r.stderr.trim()}`);
      cache.set(t, value);
    },
    delete(service, account) {
      const t = target(service, account);
      cache.delete(t);
      const r = runPowerShell(run, credDeleteScript(t));
      return r.status === 0;
    },
    enumerate(pattern) {
      const r = runPowerShell(run, credEnumerateScript(pattern));
      if (r.status !== 0) return [];
      return r.stdout.split(/\r?\n/).filter((line) => line !== "").map(fromB64);
    },
  };
}

// --- W2: DPAPI blob file ---------------------------------------------

const dpapiProtectScript = (valueB64: string): string => `$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Security
$b=[Convert]::FromBase64String('${valueB64}')
$p=[Security.Cryptography.ProtectedData]::Protect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([Convert]::ToBase64String($p))`;

const dpapiUnprotectScript = (blobB64: string): string => `$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Security
$b=[Convert]::FromBase64String('${blobB64}')
$u=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([Convert]::ToBase64String($u))`;

/** `fin-*`-style patterns: `*` is the only wildcard, everything else literal. */
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, (ch) => (ch === "*" ? ".*" : `\\${ch}`));
  return new RegExp(`^${escaped}$`);
}

function defaultCredstoreFile(): string {
  const appData = process.env["APPDATA"] ?? path.join(os.homedir(), "AppData", "Roaming");
  return path.join(appData, "CorbitsPersonalFinance", "credstore.bin");
}

export interface DpapiFileOpts {
  /** Blob file (default: %APPDATA%\CorbitsPersonalFinance\credstore.bin). */
  file?: string;
  /** Test seam: replaces the real PowerShell spawn. */
  run?: CommandRunner;
}

/**
 * W2: a JSON map of `<service>/<account>` -> base64(DPAPI blob) in
 * credstore.bin, one Protect(CurrentUser) blob per entry. File I/O
 * stays in-process; only Protect/Unprotect shell out.
 */
export function dpapiFileSecretStore(opts: DpapiFileOpts = {}): SecretStore {
  const run = opts.run ?? spawnRunner;
  const file = opts.file ?? defaultCredstoreFile();
  const cache = new Map<string, string | null>();
  const target = (service: string, account: string): string => `${service}/${account}`;
  const readEntries = (): Record<string, string> => {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
      if (typeof parsed !== "object" || parsed === null) return {};
      return Object.fromEntries(Object.entries(parsed).filter(([, v]) => typeof v === "string")) as Record<string, string>;
    } catch {
      return {};
    }
  };
  const writeEntries = (entries: Record<string, string>): void => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(entries));
  };
  return {
    get(service, account) {
      const t = target(service, account);
      const hit = cache.get(t);
      if (hit !== undefined) return hit;
      const blob = readEntries()[t];
      if (blob === undefined) {
        // The genuine not-found: no entry in the file.
        cache.set(t, null);
        return null;
      }
      const r = runPowerShell(run, dpapiUnprotectScript(blob));
      // An Unprotect failure is transient (spawn error, AV stall): the
      // blob exists, so return null without caching and re-spawn next read.
      if (r.status !== 0) return null;
      const decoded = fromB64(r.stdout.trim());
      const v = decoded === "" ? null : decoded;
      cache.set(t, v);
      return v;
    },
    set(service, account, value) {
      const t = target(service, account);
      const r = runPowerShell(run, dpapiProtectScript(toB64(value)));
      if (r.status !== 0) throw new Error(`DPAPI protect failed for ${t}: ${r.stderr.trim()}`);
      const entries = readEntries();
      entries[t] = r.stdout.trim();
      writeEntries(entries);
      cache.set(t, value);
    },
    delete(service, account) {
      const t = target(service, account);
      cache.delete(t);
      const entries = readEntries();
      if (!(t in entries)) return false;
      delete entries[t];
      writeEntries(entries);
      return true;
    },
    enumerate(pattern) {
      const re = globToRegExp(pattern);
      return Object.keys(readEntries()).filter((t) => re.test(t));
    },
  };
}

// --- Selection --------------------------------------------------------

export interface WindowsSecretStoreOpts extends DpapiFileOpts {
  /** Where the fallback notice goes (default: console.error). */
  log?: (message: string) => void;
}

/**
 * The Windows store: probes the Credential Manager shim once, then
 * commits -- W1 when Add-Type compiles, otherwise the W2 DPAPI file
 * with a logged notice. Callers construct this once per process
 * (defaultSecretStore memoizes it).
 */
export function windowsSecretStore(opts: WindowsSecretStoreOpts = {}): SecretStore {
  const run = opts.run ?? spawnRunner;
  const log = opts.log ?? ((message: string): void => console.error(message));
  const probe = runPowerShell(run, credProbeScript());
  if (probe.status === 0 && probe.stdout.includes("fin-credman-ok")) {
    return credentialManagerSecretStore({ run });
  }
  const detail = probe.stderr.trim().split(/\r?\n/, 1)[0] ?? "";
  log(`fin: Credential Manager unavailable (Add-Type shim failed${detail === "" ? "" : `: ${detail}`}); falling back to the DPAPI blob store (credstore.bin). Secrets will not appear in the Credential Manager control panel.`);
  return dpapiFileSecretStore({ run, ...(opts.file !== undefined ? { file: opts.file } : {}) });
}
