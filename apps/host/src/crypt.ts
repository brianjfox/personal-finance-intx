// Encryption at rest, behind one seam. On macOS each user's data
// directory is an AES-256 encrypted APFS sparse bundle, created and
// mounted with the user's login password and detached on sign-out or
// host exit. While locked, the ledger, vault, and every document are
// ciphertext on disk; no password, no data. The mount point IS the
// user's dataDir, so nothing else in the app changes.
//
// Windows has no per-user volume twin without admin+Pro or a storage
// rewrite, so at-rest encryption is delegated to the OS disk (Device
// Encryption / BitLocker) and DISCLOSED: the win32 implementation is a
// no-op that reports the os-disk status truthfully, read-only.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * What a platform provides at rest: "volume" = a per-user encrypted
 * volume this app manages; "os-disk" = whole-disk encryption the OS
 * manages (BitLocker); "none" = plaintext on disk.
 */
export type AtRestCapability = "volume" | "os-disk" | "none";

/** The per-platform seam users.ts drives; darwin keeps hdiutil, win32 delegates to the disk. */
export interface StoreCrypt {
  capability(): AtRestCapability;
  storeImagePath(root: string, id: string): string;
  storeExists(root: string, id: string): boolean;
  isMounted(mountPoint: string): boolean;
  createStore(root: string, id: string, mountPoint: string, password: string): void;
  mountStore(root: string, id: string, mountPoint: string, password: string): void;
  unmountStore(mountPoint: string): void;
  changeStorePassword(root: string, id: string, oldPassword: string, newPassword: string): void;
  encryptExisting(root: string, id: string, dataDir: string, password: string): void;
}

/** A marker written inside the volume: present <=> the store is mounted here. */
const MARKER = ".fin-volume";

function hdiutil(args: string[], stdinPass?: string): { ok: boolean; err: string } {
  const r = spawnSync("hdiutil", args, {
    encoding: "utf8",
    ...(stdinPass !== undefined ? { input: stdinPass } : {}),
  });
  return { ok: r.status === 0, err: (r.stderr || r.stdout || "").trim().slice(0, 300) };
}

export function storeImagePath(root: string, id: string): string {
  return path.join(root, "users", `${id}.sparsebundle`);
}

export function storeExists(root: string, id: string): boolean {
  return fs.existsSync(storeImagePath(root, id));
}

export function isMounted(mountPoint: string): boolean {
  return fs.existsSync(path.join(mountPoint, MARKER));
}

/** Create the encrypted store and leave it mounted at mountPoint. */
export function createStore(root: string, id: string, mountPoint: string, password: string): void {
  if (process.platform !== "darwin") throw new Error("encrypted stores need macOS");
  const image = storeImagePath(root, id);
  fs.mkdirSync(path.dirname(image), { recursive: true });
  const made = hdiutil(
    ["create", "-quiet", "-size", "32g", "-type", "SPARSEBUNDLE", "-fs", "APFS", "-volname", `fin-${id}`, "-encryption", "AES-256", "-stdinpass", image],
    password,
  );
  if (!made.ok) throw new Error(`couldn't create the encrypted store: ${made.err}`);
  mountStore(root, id, mountPoint, password);
  fs.writeFileSync(path.join(mountPoint, MARKER), `fin-${id}\n`);
}

/** Mount with the password; a wrong password refuses in plain words. */
export function mountStore(root: string, id: string, mountPoint: string, password: string): void {
  if (isMounted(mountPoint)) return;
  fs.mkdirSync(mountPoint, { recursive: true });
  const r = hdiutil(["attach", "-quiet", storeImagePath(root, id), "-stdinpass", "-mountpoint", mountPoint, "-nobrowse", "-owners", "off"], password);
  if (!r.ok) throw new Error(`couldn't unlock the encrypted store (wrong password?): ${r.err}`);
}

/** Detach; the data on disk goes back to being ciphertext. */
export function unmountStore(mountPoint: string): void {
  if (!isMounted(mountPoint)) return;
  const gentle = hdiutil(["detach", "-quiet", mountPoint]);
  if (!gentle.ok) {
    const forced = hdiutil(["detach", "-quiet", "-force", mountPoint]);
    if (!forced.ok) throw new Error(`couldn't lock the encrypted store: ${forced.err}`);
  }
}

/** Re-key the store: the volume's password becomes newPassword. Detached only. */
export function changeStorePassword(root: string, id: string, oldPassword: string, newPassword: string): void {
  const r = hdiutil(["chpass", "-oldstdinpass", "-newstdinpass", storeImagePath(root, id)], `${oldPassword}\0${newPassword}\0`);
  if (!r.ok) throw new Error(`couldn't change the store's password: ${r.err}`);
}

/**
 * First encryption of an existing plaintext directory: stage it aside,
 * create the store at its path, move everything in. Crash-safe: the
 * staged directory survives until the move completes.
 */
export function encryptExisting(root: string, id: string, dataDir: string, password: string): void {
  const stage = `${dataDir}.migrating`;
  if (fs.existsSync(dataDir) && !fs.existsSync(stage)) fs.renameSync(dataDir, stage);
  createStore(root, id, dataDir, password);
  if (fs.existsSync(stage)) {
    for (const entry of fs.readdirSync(stage)) {
      fs.cpSync(path.join(stage, entry), path.join(dataDir, entry), { recursive: true });
    }
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

/** macOS: the hdiutil sparsebundle behavior above, verbatim. */
export function darwinStoreCrypt(): StoreCrypt {
  return {
    capability: () => "volume",
    storeImagePath,
    storeExists,
    isMounted,
    createStore,
    mountStore,
    unmountStore,
    changeStorePassword,
    encryptExisting,
  };
}

/**
 * Read-only probe of the OS disk's encryption. Get-BitLockerVolume needs
 * the BitLocker module (Pro/Enterprise); manage-bde -status is the wider
 * fallback (Home reports through it too). Anything unreadable is "none":
 * the copy must never claim protection it can't see.
 */
function probeOsDiskEncryption(): "os-disk" | "none" {
  const script =
    "$d = $env:SystemDrive; " +
    "try { $v = Get-BitLockerVolume -MountPoint $d -ErrorAction Stop; if (\"$($v.ProtectionStatus)\" -eq 'On') { 'on' } else { 'off' } } " +
    "catch { $s = (manage-bde -status $d) 2>$null | Out-String; if ($s -match 'Protection On') { 'on' } elseif ($s -ne '') { 'off' } else { 'unknown' } }";
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", timeout: 15_000 });
  return r.status === 0 && r.stdout.trim() === "on" ? "os-disk" : "none";
}

/**
 * Windows: no per-user volume -- app data sits on the OS disk, whose
 * encryption (Device Encryption / BitLocker) is probed once and
 * reported. The volume operations refuse in plain words; users.ts never
 * reaches them when the capability isn't "volume".
 */
export function win32StoreCrypt(probe: () => "os-disk" | "none" = probeOsDiskEncryption): StoreCrypt {
  let probed: "os-disk" | "none" | null = null;
  const refuse = (): never => {
    throw new Error("per-user encrypted volumes need macOS; on Windows the data directory relies on the OS disk's encryption (BitLocker)");
  };
  return {
    capability() {
      if (probed === null) probed = probe();
      return probed;
    },
    storeImagePath,
    storeExists: () => false,
    isMounted: () => false,
    createStore: refuse,
    mountStore: refuse,
    unmountStore: () => {},
    changeStorePassword: refuse,
    encryptExisting: refuse,
  };
}

/** The platform pick: darwin manages volumes; everything else delegates and discloses. */
export function defaultStoreCrypt(): StoreCrypt {
  if (process.platform === "darwin") return darwinStoreCrypt();
  if (process.platform === "win32") return win32StoreCrypt();
  // Other unixes: no volume support and no BitLocker to probe.
  return win32StoreCrypt(() => "none");
}
