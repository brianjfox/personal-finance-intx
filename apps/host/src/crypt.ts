// Encryption at rest, the macOS-native way: each user's data directory
// is an AES-256 encrypted APFS sparse bundle, created and mounted with
// the user's login password and detached on sign-out or host exit.
// While locked, the ledger, vault, and every document are ciphertext on
// disk; no password, no data. The mount point IS the user's dataDir, so
// nothing else in the app changes.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

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
