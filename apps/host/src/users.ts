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

import fs from "node:fs";
import path from "node:path";

import { defaultSecretStore, scopedSecretStore, type SecretStore } from "@fin/institutions";
import { type } from "arktype";

import { createApp, type App, type AppOptions } from "./app";

export const UserInfo = type({
  id: /^[a-z][a-z0-9_]{0,40}$/,
  name: "string > 0",
  created_at: "string",
  /** Keychain account prefix; null = the unscoped legacy accounts (the migrated primary). */
  secret_scope: "string | null",
});
export type UserInfo = typeof UserInfo.infer;

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
  return first === undefined ? root : userDir(root, first.id);
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
  list(): UserInfo[];
  count(): number;
  add(name: string): UserInfo;
  /** The App for a user id; undefined falls back to the first user. Throws in plain words otherwise. */
  appFor(id?: string): App;
  /** Wipe one user's data and secrets and drop them from the registry. */
  deleteUser(id: string): void;
  resumeAll(): Promise<Array<{ user: string; runId: string; status: string }>>;
  closeAll(): void;
}

export function createUserManager(opts: UserManagerOptions): UserManager {
  const root = opts.rootDir;
  const clock = opts.clock ?? (() => new Date());
  const base = opts.secrets ?? defaultSecretStore();
  let file = loadUsers(root, clock);
  const apps = new Map<string, App>();

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
    list: () => file.users.map((u) => ({ ...u })),
    count: () => file.users.length,
    add(name) {
      const trimmed = name.trim();
      if (trimmed === "") throw new Error("give the user a name");
      const id = idFor(trimmed, new Set(file.users.map((u) => u.id)));
      const u: UserInfo = { id, name: trimmed, created_at: clock().toISOString(), secret_scope: `u.${id}` };
      fs.mkdirSync(userDir(root, id), { recursive: true });
      file = { ...file, users: [...file.users, u] };
      writeUsersFile(root, file);
      bootApp(u);
      return u;
    },
    appFor(id) {
      const u = id === undefined ? file.users[0] : file.users.find((x) => x.id === id);
      if (u === undefined) {
        throw new Error(id === undefined ? "no users yet -- add one first" : `unknown user ${id}`);
      }
      return bootApp(u);
    },
    deleteUser(id) {
      const u = file.users.find((x) => x.id === id);
      if (u === undefined) throw new Error(`unknown user ${id}`);
      const app = bootApp(u);
      app.deleteAllData();
      apps.delete(id);
      file = { ...file, users: file.users.filter((x) => x.id !== id) };
      writeUsersFile(root, file);
    },
    async resumeAll() {
      const out: Array<{ user: string; runId: string; status: string }> = [];
      for (const u of file.users) {
        const resumed = await bootApp(u).resumeInFlight();
        for (const r of resumed) out.push({ user: u.id, runId: r.runId, status: r.status });
      }
      return out;
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
    },
  };
}
