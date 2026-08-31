// Multiple operators, one Mac: each user is their own data directory
// (ledger, vault, agents, runs) and their own scoped slice of the
// Keychain. A legacy single-user layout migrates into users/primary and
// keeps its unscoped secrets.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { memorySecretStore, scopedSecretStore } from "@fin/institutions";
import { views } from "@fin/ledger";

import { createApp } from "../src/app";
import { startIpc } from "../src/ipc";
import { createUserManager, loadUsers, resolveSingleUserDir, userDir } from "../src/users";

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "fin-users-"));

let savedKey: string | undefined;
beforeEach(() => {
  savedKey = process.env["ANTHROPIC_API_KEY"];
});
afterEach(() => {
  if (savedKey === undefined) delete process.env["ANTHROPIC_API_KEY"];
  else process.env["ANTHROPIC_API_KEY"] = savedKey;
});

describe("scoped secret store", () => {
  test("prefixes accounts per user; users cannot see each other's items", () => {
    const base = memorySecretStore();
    const alice = scopedSecretStore(base, "u.alice");
    const bob = scopedSecretStore(base, "u.bob");
    alice.set!("fin-interchange", "anthropic", "sk-alice");
    bob.set!("fin-interchange", "anthropic", "sk-bob");
    expect(alice.get("fin-interchange", "anthropic")).toBe("sk-alice");
    expect(bob.get("fin-interchange", "anthropic")).toBe("sk-bob");
    expect(base.dump()).toEqual({
      "fin-interchange/u.alice.anthropic": "sk-alice",
      "fin-interchange/u.bob.anthropic": "sk-bob",
    });
    expect(alice.delete!("fin-interchange", "anthropic")).toBe(true);
    expect(bob.get("fin-interchange", "anthropic")).toBe("sk-bob");
  });
});

describe("legacy migration", () => {
  test("a single-user layout moves to users/primary and still works", async () => {
    const root = tmp();
    // Build a legacy household at the root.
    const legacy = createApp({ dataDir: root });
    const entry = legacy.addInstitution({ name: "Old Bank", mode: "managed" });
    await legacy.saveManagedAccount(entry.institution_id, { name: "Cash", type: "checking", value: "1234" });
    legacy.close();

    const file = loadUsers(root);
    expect(file.users.map((u) => u.id)).toEqual(["primary"]);
    expect(file.users[0]?.secret_scope).toBeNull();
    expect(fs.existsSync(path.join(root, "ledger.db"))).toBe(false);
    expect(fs.existsSync(path.join(userDir(root, "primary"), "ledger.db"))).toBe(true);
    expect(resolveSingleUserDir(root)).toBe(userDir(root, "primary"));

    const users = createUserManager({ rootDir: root, secrets: memorySecretStore() });
    try {
      const app = users.appFor(undefined); // first user by default
      expect(views.netWorth(app.ledger).assets).toBe("1234");
      // A second load is idempotent.
      expect(loadUsers(root).users).toHaveLength(1);
    } finally {
      users.closeAll();
    }
  });

  test("a fresh root starts with no users; apps exist only after add", () => {
    const root = tmp();
    const users = createUserManager({ rootDir: root, secrets: memorySecretStore() });
    try {
      expect(users.list()).toEqual([]);
      expect(() => users.appFor(undefined)).toThrow(/no users yet/);
      const u = users.add("Brian Fox");
      expect(u.id).toBe("brian_fox");
      expect(u.password_set).toBe(false);
      expect(users.appFor("brian_fox").dataDir).toBe(userDir(root, "brian_fox"));
      // Same display name again: the id gets a counter.
      expect(users.add("Brian Fox").id).toBe("brian_fox_2");
    } finally {
      users.closeAll();
    }
  });
});

describe("user isolation", () => {
  test("institutions, assets, and keys are fully separate; env never leaks between users", async () => {
    const root = tmp();
    const base = memorySecretStore();
    const users = createUserManager({ rootDir: root, secrets: base });
    try {
      const a = users.add("Alice");
      const b = users.add("Bob");
      const appA = users.appFor(a.id);
      const appB = users.appFor(b.id);

      // Assets: Alice's account is invisible to Bob.
      const inst = appA.addInstitution({ name: "Alice Bank", mode: "managed" });
      await appA.saveManagedAccount(inst.institution_id, { name: "Cash", type: "checking", value: "500" });
      expect(views.netWorth(appA.ledger).assets).toBe("500");
      expect(views.netWorth(appB.ledger).lines).toHaveLength(0);
      expect(appB.institutionsOverview().institutions).toHaveLength(0);

      // Keys: Alice's Anthropic key lands in HER scope only, and is not
      // mirrored into the shared process env.
      delete process.env["ANTHROPIC_API_KEY"];
      appA.setCredential("anthropic", { anthropic: "sk-ant-alice" });
      expect(process.env["ANTHROPIC_API_KEY"]).toBeUndefined();
      expect(base.dump()["fin-interchange/u.alice.anthropic"]).toBe("sk-ant-alice");
      expect(appA.credentialsStatus().slots.find((s) => s.id === "anthropic")?.configured).toBe(true);
      expect(appB.credentialsStatus().slots.find((s) => s.id === "anthropic")?.configured).toBe(false);

      // A process-env key (the primary's) must not bleed into scoped users.
      process.env["ANTHROPIC_API_KEY"] = "sk-ant-primary-env";
      expect(appB.getInferenceSettings().key_set["anthropic"]).toBe(false);

      // Deleting Bob leaves Alice untouched.
      users.deleteUser(b.id);
      expect(users.list().map((u) => u.id)).toEqual([a.id]);
      expect(fs.existsSync(userDir(root, b.id))).toBe(false);
      expect(views.netWorth(users.appFor(a.id).ledger).assets).toBe("500");
      expect(base.dump()["fin-interchange/u.alice.anthropic"]).toBe("sk-ant-alice");
    } finally {
      users.closeAll();
    }
  });
});

describe("multi-user IPC with login", () => {
  test("no session -> 401; login issues a token; identity is the session's, never a client header", async () => {
    const root = tmp();
    const users = createUserManager({ rootDir: root, secrets: memorySecretStore() });
    const server = startIpc({ users, port: 0 });
    const call = (p: string, opts: { token?: string; headers?: Record<string, string>; body?: unknown } = {}): Promise<Response> =>
      fetch(`http://127.0.0.1:${server.port}${p}`, {
        method: opts.body === undefined ? "GET" : "POST",
        headers: {
          "content-type": "application/json",
          ...(opts.token !== undefined ? { authorization: `Bearer ${opts.token}` } : {}),
          ...(opts.headers ?? {}),
        },
        ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      });
    try {
      // Creating a user requires a password and signs them in.
      expect((await call("/api/users", { body: { name: "Alice" } })).status).toBe(400); // no password
      const a = (await (await call("/api/users", { body: { name: "Alice", password: "alice-pw" } })).json()) as { user: { id: string }; token: string };
      const b = (await (await call("/api/users", { body: { name: "Bob", password: "bob-pw" } })).json()) as { user: { id: string }; token: string };
      expect(a.token).not.toBe(b.token);

      // Without a session, data is unreachable; the public surface is only users+health.
      expect((await call("/api/institutions")).status).toBe(401);
      expect((await call("/api/net-worth")).status).toBe(401);
      const health = await call("/api/health");
      expect(health.status).toBe(200);
      // Pre-auth health names the platform so the GUI can word its copy truthfully.
      expect(((await health.json()) as { platform: string }).platform).toBe(process.platform);
      expect((await call("/api/users")).status).toBe(200);

      // Wrong password: refused. Right password: a session.
      expect((await call("/api/login", { body: { user: "alice", password: "nope" } })).status).toBe(401);
      const login = (await (await call("/api/login", { body: { user: "Alice", password: "alice-pw" } })).json()) as { token: string };

      // Each session sees only its own data.
      const made = await call("/api/institutions", { token: login.token, body: { name: "Alice Bank", mode: "managed" } });
      expect(made.status).toBe(201);
      expect((await (await call("/api/institutions", { token: login.token })).json()) as unknown[]).toHaveLength(1);
      expect((await (await call("/api/institutions", { token: b.token })).json()) as unknown[]).toHaveLength(0);

      // A spoofed user header changes nothing: identity is the session's.
      const spoofed = (await (await call("/api/institutions", { token: b.token, headers: { "x-fin-user": a.user.id } })).json()) as unknown[];
      expect(spoofed).toHaveLength(0);

      // Logout kills the session.
      await call("/api/logout", { token: login.token, body: {} });
      expect((await call("/api/institutions", { token: login.token })).status).toBe(401);
    } finally {
      server.stop(true);
      users.closeAll();
    }
  }, 120_000);

  test("a migrated user without a password sets one exactly once, via the login screen's flow", async () => {
    const root = tmp();
    const legacy = createApp({ dataDir: root });
    legacy.addInstitution({ name: "Old Bank", mode: "managed" });
    legacy.close();
    const users = createUserManager({ rootDir: root, secrets: memorySecretStore() });
    const server = startIpc({ users, port: 0 });
    const post = (p: string, body: unknown, token?: string): Promise<Response> =>
      fetch(`http://127.0.0.1:${server.port}${p}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(token !== undefined ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(body),
      });
    try {
      // Login before a password exists: a plain-words 409, so the GUI shows the set-password form.
      const early = await post("/api/login", { user: "primary", password: "whatever" });
      expect(early.status).toBe(409);
      expect(((await early.json()) as { needs_password: boolean }).needs_password).toBe(true);

      const set = (await (await post("/api/set-password", { user: "primary", password: "first-pw" })).json()) as { token: string };
      const r = await fetch(`http://127.0.0.1:${server.port}/api/institutions`, { headers: { authorization: `Bearer ${set.token}` } });
      expect(((await r.json()) as unknown[])).toHaveLength(1); // the migrated data, theirs alone

      // Once set, it cannot be overwritten by this route.
      expect((await post("/api/set-password", { user: "primary", password: "evil-pw" })).status).toBe(500);
      expect(users.login("primary", "first-pw")).not.toBeNull();
      expect(users.login("primary", "evil-pw")).toBeNull();
    } finally {
      server.stop(true);
      users.closeAll();
    }
  }, 120_000);
});
