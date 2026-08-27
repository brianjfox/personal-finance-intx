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
      expect(u.secret_scope).toBe("u.brian_fox");
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

describe("multi-user IPC", () => {
  test("requests route by x-fin-user; /api/users lists and adds", async () => {
    const root = tmp();
    const users = createUserManager({ rootDir: root, secrets: memorySecretStore() });
    const server = startIpc({ users, port: 0 });
    const call = (p: string, user: string | null, body?: unknown): Promise<Response> =>
      fetch(`http://127.0.0.1:${server.port}${p}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { "content-type": "application/json", ...(user !== null ? { "x-fin-user": user } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    try {
      expect(((await (await call("/api/users", null)).json()) as { multi_user: boolean }).multi_user).toBe(true);
      const a = (await (await call("/api/users", null, { name: "Alice" })).json()) as { id: string };
      const b = (await (await call("/api/users", null, { name: "Bob" })).json()) as { id: string };

      const made = await call("/api/institutions", a.id, { name: "Alice Bank", mode: "managed" });
      expect(made.status).toBe(201);
      const listA = (await (await call("/api/institutions", a.id)).json()) as unknown[];
      const listB = (await (await call("/api/institutions", b.id)).json()) as unknown[];
      expect(listA).toHaveLength(1);
      expect(listB).toHaveLength(0);

      // An unknown user is refused in plain words; health needs no user.
      expect((await call("/api/institutions", "nobody")).status).toBe(500);
      expect((await call("/api/health", null)).status).toBe(200);
    } finally {
      server.stop(true);
      users.closeAll();
    }
  });
});
