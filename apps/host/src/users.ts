// Multiple operators on one Mac, one household each. The separation is
// the framework's own: EVERYTHING an operator owns -- ledger, document
// vault, agent context, standing runs, effects, settings -- already
// hangs off a single data directory, so a user simply gets their own
// (`<root>/users/<id>`), each running its own App with its own agents
// and standing runs. Keychain secrets separate the same way: every
// non-primary user resolves credentials through a scoped SecretStore
// that prefixes the account with `u.<id>.`, so two users' Anthropic
// keys are different Keychain items and neither can read the other's.
//
// A pre-multi-user data directory migrates in place: its files move to
// users/primary, which keeps the UNscoped Keychain accounts it always
// had -- nothing needs re-pasting.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { defaultSecretStore, scopedSecretStore, type SecretStore } from "@fin/institutions";
import { type } from "arktype";

import { createApp, type App, type AppOptions } from "./app";
import { defaultStoreCrypt } from "./crypt";

// One per process: the win32 BitLocker probe runs at most once.
const crypt = defaultStoreCrypt();

const PasswordRecord = type({ salt: "string", hash: "string", n: "number", r: "number", p: "number" });

export const UserInfo = type({
  id: /^[a-z][a-z0-9_]{0,40}$/,
  name: "string > 0",
  created_at: "string",
  /** Keychain account prefix; null = the unscoped legacy accounts (the migrated primary). */
  secret_scope: "string | null",
  /** scrypt parameters + digest. Absent until the user sets one (migrated users start without). */
  "password?": PasswordRecord,
  /** True once the user's data lives in an AES-256 encrypted store (mounted only while signed in). */
  "encrypted?": "boolean",
});
export type UserInfo = typeof UserInfo.infer;

/** What leaves the host about a user: never the password record. */
export interface PublicUser { id: string; name: string; created_at: string; password_set: boolean; encrypted: boolean }
const publicUser = (u: UserInfo): PublicUser => ({ id: u.id, name: u.name, created_at: u.created_at, password_set: u.password !== undefined, encrypted: u.encrypted === true });

const SCRYPT = { n: 16384, r: 8, p: 1 } as const;
function hashPassword(password: string): typeof PasswordRecord.infer {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 32, { N: SCRYPT.n, r: SCRYPT.r, p: SCRYPT.p }).toString("hex");
  return { salt, hash, ...SCRYPT };
}
function verifyPassword(rec: typeof PasswordRecord.infer, password: string): boolean {
  const got = crypto.scryptSync(password, rec.salt, 32, { N: rec.n, r: rec.r, p: rec.p });
  const want = Buffer.from(rec.hash, "hex");
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

const UsersFile = type({ version: "'1'", users: UserInfo.array() });
type UsersFile = typeof UsersFile.infer;

const usersPath = (root: string): string => path.join(root, "users.json");
export const userDir = (root: string, id: string): string => path.join(root, "users", id);

/** Files/dirs a single-user layout may hold at the root; migration moves exactly these. */
const LEGACY_ENTRIES = [
  "ledger.db", "ledger.db-shm", "ledger.db-wal",
  "vault", "blobs", "runs", "context", "effects",
  "institutions", "institutions.json", "profile.json", "inference.json", "fx-cache.json",
];

function readUsersFile(root: string): UsersFile | null {
  if (!fs.existsSync(usersPath(root))) return null;
  const parsed = UsersFile(JSON.parse(fs.readFileSync(usersPath(root), "utf8")));
  if (parsed instanceof type.errors) throw new Error(`users.json: ${parsed.summary}`);
  return parsed;
}

function writeUsersFile(root: string, file: UsersFile): void {
  const tmp = `${usersPath(root)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(file, null, 2));
  fs.renameSync(tmp, usersPath(root));
}

/** Slug a display name into a stable id, uniquified against the registry. */
function idFor(name: string, taken: Set<string>): string {
  let base = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 32);
  if (base === "" || !/^[a-z]/.test(base)) base = `user${base === "" ? "" : `_${base}`}`;
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) if (!taken.has(`${base}_${n}`)) return `${base}_${n}`;
}

/**
 * Load (or create) the registry, migrating a legacy single-user layout
 * into users/primary on first sight.
 */
export function loadUsers(root: string, now: () => Date = () => new Date()): UsersFile {
  fs.mkdirSync(root, { recursive: true });
  const existing = readUsersFile(root);
  if (existing !== null) return existing;
  const legacy = LEGACY_ENTRIES.some((e) => fs.existsSync(path.join(root, e)));
  const file: UsersFile = { version: "1", users: [] };
  if (legacy) {
    const dir = userDir(root, "primary");
    fs.mkdirSync(dir, { recursive: true });
    for (const e of LEGACY_ENTRIES) {
      const from = path.join(root, e);
      if (fs.existsSync(from)) fs.renameSync(from, path.join(dir, e));
    }
    file.users.push({ id: "primary", name: "Primary", created_at: now().toISOString(), secret_scope: null });
  }
  writeUsersFile(root, file);
  return file;
}

/** CLI convenience: a data dir that has migrated to users/ resolves to its first user. */
export function resolveSingleUserDir(root: string): string {
  const file = readUsersFile(root);
  const first = file?.users[0];
  if (first === undefined) return root;
  const dir = userDir(root, first.id);
  if (first.encrypted === true && !crypt.isMounted(dir)) {
    throw new Error(`${first.name}'s data is encrypted and locked -- open the app and sign in first, then run this again`);
  }
  return dir;
}

export interface UserManagerOptions {
  rootDir: string;
  /** Base secret store (tests inject a memory store); scoped per user. */
  secrets?: SecretStore;
  /** Extra options threaded into every user's App (tests: pollMs, adapters...). */
  appOptions?: Partial<Omit<AppOptions, "dataDir" | "connectors">>;
  clock?: () => Date;
}

export interface UserManager {
  rootDir: string;
  list(): PublicUser[];
  count(): number;
  add(name: string, password?: string): PublicUser;
  /** The App for a user id; undefined falls back to the first user. Throws in plain words otherwise. */
  appFor(id?: string): App;
  /** Wipe one user's data and secrets and drop them from the registry. */
  deleteUser(id: string): void;
  resumeAll(): Promise<Array<{ user: string; runId: string; status: string }>>;
  closeAll(): void;
  /** First-time password for a user who has none (the migrated primary). Refuses if one is set. */
  setPassword(idOrName: string, password: string): PublicUser;
  /** Change the display name (also the login name). Refuses collisions with other users. */
  renameUser(id: string, name: string): PublicUser;
  /** Change the password: verifies the old one, re-keys the encrypted store, keeps sessions alive. */
  changePassword(id: string, oldPassword: string, newPassword: string): boolean;
  /** Username (id or display name, case-insensitive) + password -> a session token, or null. */
  login(idOrName: string, password: string): { token: string; user: PublicUser } | null;
  /** The user behind a session token; null when the token is unknown or expired. */
  sessionUser(token: string): PublicUser | null;
  logout(token: string): void;
}

export function createUserManager(opts: UserManagerOptions): UserManager {
  const root = opts.rootDir;
  const clock = opts.clock ?? (() => new Date());
  const base = opts.secrets ?? defaultSecretStore();
  let file = loadUsers(root, clock);
  const apps = new Map<string, App>();
  // Sessions live only as long as the host process: relaunching the app
  // means logging in again. Idle sessions expire.
  const sessions = new Map<string, { id: string; lastSeen: number }>();
  const SESSION_IDLE_MS = 24 * 60 * 60 * 1000;
  const findUser = (idOrName: string): UserInfo | undefined =>
    file.users.find((u) => u.id === idOrName) ?? file.users.find((u) => u.name.toLowerCase() === idOrName.trim().toLowerCase());
  const markEncrypted = (id: string): UserInfo => {
    file = { ...file, users: file.users.map((x) => (x.id === id ? { ...x, encrypted: true } : x)) };
    writeUsersFile(root, file);
    return file.users.find((x) => x.id === id)!;
  };
  // Hygiene: a crashed host can leave stores mounted (data readable
  // without a password). Lock everything before serving anyone.
  for (const u of file.users) {
    if (u.encrypted === true && crypt.isMounted(userDir(root, u.id))) {
      try {
        crypt.unmountStore(userDir(root, u.id));
      } catch {
        /* busy: better mounted than crashed */
      }
    }
  }
  /** Mount (creating or first-encrypting as needed) and boot. Only a correct password gets here. */
  const unlock = (u: UserInfo, password: string): App => {
    const dir = userDir(root, u.id);
    if (u.encrypted === true) {
      if (!crypt.isMounted(dir)) crypt.mountStore(root, u.id, dir, password);
    } else if (crypt.capability() === "volume") {
      // First sign-in with a password: the data moves into an encrypted
      // store now, whether it's a fresh user or a migrated plaintext one.
      // Non-volume platforms skip this: at-rest protection is the OS
      // disk's (disclosed), and the password stays a scrypt hash.
      if (crypt.storeExists(root, u.id)) crypt.mountStore(root, u.id, dir, password);
      else if (fs.existsSync(dir) && fs.readdirSync(dir).length > 0) crypt.encryptExisting(root, u.id, dir, password);
      else crypt.createStore(root, u.id, dir, password);
      u = markEncrypted(u.id);
    }
    const app = bootApp(u);
    // Standing runs parked in this user's store come back now that it's unlocked.
    void app.resumeInFlight().catch(() => {});
    return app;
  };

  const bootApp = (u: UserInfo): App => {
    const cached = apps.get(u.id);
    if (cached !== undefined) return cached;
    const scoped = u.secret_scope === null ? base : scopedSecretStore(base, u.secret_scope);
    const app = createApp({
      dataDir: userDir(root, u.id),
      clock,
      ...(opts.appOptions ?? {}),
      connectors: { secrets: scoped },
      // A scoped user must never inherit the process-wide Anthropic key
      // (that's the primary's), and their credential saves must not be
      // mirrored into the shared process environment.
      envAnthropicFallback: u.secret_scope === null,
      mirrorCredentialEnv: u.secret_scope === null,
      // The all-services Keychain sweep is only safe when no other
      // user's scoped items share those services.
      keychainSweepOnWipe: () => u.secret_scope === null && file.users.length === 1 && opts.secrets === undefined,
    });
    apps.set(u.id, app);
    return app;
  };

  return {
    rootDir: root,
    list: () => file.users.map(publicUser),
    count: () => file.users.length,
    add(name, password) {
      const trimmed = name.trim();
      if (trimmed === "") throw new Error("give the user a name");
      if (password !== undefined && password.length < 4) throw new Error("the password needs at least 4 characters");
      const id = idFor(trimmed, new Set(file.users.map((u) => u.id)));
      const u: UserInfo = {
        id,
        name: trimmed,
        created_at: clock().toISOString(),
        secret_scope: `u.${id}`,
        ...(password !== undefined ? { password: hashPassword(password) } : {}),
      };
      fs.mkdirSync(userDir(root, id), { recursive: true });
      file = { ...file, users: [...file.users, u] };
      writeUsersFile(root, file);
      if (password !== undefined && crypt.capability() === "volume") {
        crypt.createStore(root, id, userDir(root, id), password);
        const enc = markEncrypted(id);
        bootApp(enc);
        return publicUser(enc);
      }
      bootApp(u);
      return publicUser(u);
    },
    appFor(id) {
      const u = id === undefined ? file.users[0] : file.users.find((x) => x.id === id);
      if (u === undefined) {
        throw new Error(id === undefined ? "no users yet -- add one first" : `unknown user ${id}`);
      }
      if (u.encrypted === true && !crypt.isMounted(userDir(root, u.id))) {
        throw new Error(`${u.name}'s data is locked -- sign in to unlock it`);
      }
      return bootApp(u);
    },
    deleteUser(id) {
      const u = file.users.find((x) => x.id === id);
      if (u === undefined) throw new Error(`unknown user ${id}`);
      const app = bootApp(u);
      try {
        app.deleteAllData();
      } catch {
        /* an encrypted store's mountpoint refuses the final rmdir; the volume is deleted below */
      }
      apps.delete(id);
      for (const [token, sess] of sessions) if (sess.id === id) sessions.delete(token);
      if (u.encrypted === true) {
        try {
          crypt.unmountStore(userDir(root, id));
        } catch {
          /* already detached */
        }
        fs.rmSync(crypt.storeImagePath(root, id), { recursive: true, force: true });
      }
      fs.rmSync(userDir(root, id), { recursive: true, force: true });
      file = { ...file, users: file.users.filter((x) => x.id !== id) };
      writeUsersFile(root, file);
    },
    async resumeAll() {
      const out: Array<{ user: string; runId: string; status: string }> = [];
      for (const u of file.users) {
        // An encrypted user's runs resume at sign-in; locked data stays locked.
        if (u.encrypted === true && !crypt.isMounted(userDir(root, u.id))) continue;
        const resumed = await bootApp(u).resumeInFlight();
        for (const r of resumed) out.push({ user: u.id, runId: r.runId, status: r.status });
      }
      return out;
    },
    setPassword(idOrName, password) {
      const u = findUser(idOrName);
      if (u === undefined) throw new Error(`unknown user ${idOrName}`);
      if (u.password !== undefined) throw new Error(`${u.name} already has a password`);
      if (password.length < 4) throw new Error("the password needs at least 4 characters");
      const updated: UserInfo = { ...u, password: hashPassword(password) };
      file = { ...file, users: file.users.map((x) => (x.id === u.id ? updated : x)) };
      writeUsersFile(root, file);
      // The first password immediately moves the data into an encrypted store.
      if (apps.has(u.id)) {
        apps.get(u.id)!.close();
        apps.delete(u.id);
      }
      unlock(updated, password);
      return publicUser(findUser(u.id)!);
    },
    renameUser(id, name) {
      const u = file.users.find((x) => x.id === id);
      if (u === undefined) throw new Error(`unknown user ${id}`);
      const trimmed = name.trim();
      if (trimmed === "") throw new Error("give yourself a name");
      const clash = file.users.some((x) => x.id !== id && (x.name.toLowerCase() === trimmed.toLowerCase() || x.id === trimmed.toLowerCase()));
      if (clash) throw new Error(`the name ${trimmed} is already taken`);
      const updated: UserInfo = { ...u, name: trimmed };
      file = { ...file, users: file.users.map((x) => (x.id === id ? updated : x)) };
      writeUsersFile(root, file);
      return publicUser(updated);
    },
    changePassword(id, oldPassword, newPassword) {
      const u = file.users.find((x) => x.id === id);
      if (u === undefined) throw new Error(`unknown user ${id}`);
      if (u.password === undefined) throw new Error("no password set yet -- set one first");
      if (!verifyPassword(u.password, oldPassword)) return false;
      if (newPassword.length < 4) throw new Error("the new password needs at least 4 characters");
      if (u.encrypted === true) {
        // Re-key the volume: detach (chpass refuses a mounted image),
        // change, and bring it back with the new password.
        const dir = userDir(root, u.id);
        const wasMounted = crypt.isMounted(dir);
        if (wasMounted) {
          apps.get(u.id)?.close();
          apps.delete(u.id);
          crypt.unmountStore(dir);
        }
        crypt.changeStorePassword(root, u.id, oldPassword, newPassword);
        if (wasMounted) crypt.mountStore(root, u.id, dir, newPassword);
      }
      const updated: UserInfo = { ...u, password: hashPassword(newPassword) };
      file = { ...file, users: file.users.map((x) => (x.id === u.id ? updated : x)) };
      writeUsersFile(root, file);
      if (updated.encrypted === true && crypt.isMounted(userDir(root, updated.id))) {
        const app = bootApp(updated);
        void app.resumeInFlight().catch(() => {});
      }
      return true;
    },
    login(idOrName, password) {
      const u = findUser(idOrName);
      if (u === undefined || u.password === undefined || !verifyPassword(u.password, password)) return null;
      unlock(u, password);
      const token = crypto.randomBytes(32).toString("hex");
      sessions.set(token, { id: u.id, lastSeen: Date.now() });
      return { token, user: publicUser(findUser(u.id)!) };
    },
    sessionUser(token) {
      const sess = sessions.get(token);
      if (sess === undefined) return null;
      if (Date.now() - sess.lastSeen > SESSION_IDLE_MS) {
        sessions.delete(token);
        return null;
      }
      sess.lastSeen = Date.now();
      const u = file.users.find((x) => x.id === sess.id);
      return u === undefined ? null : publicUser(u);
    },
    logout(token) {
      const sess = sessions.get(token);
      sessions.delete(token);
      if (sess === undefined) return;
      // Last session out locks the store.
      const remaining = [...sessions.values()].some((x) => x.id === sess.id);
      const u = file.users.find((x) => x.id === sess.id);
      if (!remaining && u?.encrypted === true) {
        apps.get(sess.id)?.close();
        apps.delete(sess.id);
        try {
          crypt.unmountStore(userDir(root, sess.id));
        } catch {
          /* busy: it will lock on host exit */
        }
      }
    },
    closeAll() {
      for (const app of apps.values()) {
        try {
          app.close();
        } catch {
          /* already closed */
        }
      }
      apps.clear();
      for (const u of file.users) {
        if (u.encrypted === true) {
          try {
            crypt.unmountStore(userDir(root, u.id));
          } catch {
            /* busy */
          }
        }
      }
    },
  };
}
