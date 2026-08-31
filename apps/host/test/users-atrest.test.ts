// Truthful at-rest reporting: on platforms without per-user volumes the
// crypt seam delegates to the OS disk and DISCLOSES -- /api/users carries
// what the machine actually provides, so the GUI can never claim
// protection that isn't there.

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { memorySecretStore } from "@fin/institutions";

import { win32StoreCrypt } from "../src/crypt";
import { startIpc } from "../src/ipc";
import { createUserManager } from "../src/users";

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "fin-atrest-"));

describe("at-rest capability through the crypt seam", () => {
  test("an encrypted OS disk reports os-disk for every user, and the probe runs once", () => {
    const root = tmp();
    let probes = 0;
    const crypt = win32StoreCrypt(() => {
      probes += 1;
      return "os-disk";
    });
    const users = createUserManager({ rootDir: root, secrets: memorySecretStore(), crypt });
    try {
      const alice = users.add("Alice", "alice-pw");
      expect(alice.encrypted).toBe("os-disk");
      // No per-user volume on this platform: sign-in still works, no sparsebundle appears.
      expect(fs.existsSync(path.join(root, "users", "alice.sparsebundle"))).toBe(false);
      const sess = users.login("alice", "alice-pw");
      expect(sess).not.toBeNull();
      expect(sess!.user.encrypted).toBe("os-disk");
      expect(users.list().map((u) => u.encrypted)).toEqual(["os-disk"]);
      expect(probes).toBe(1);
    } finally {
      users.closeAll();
    }
  });

  test("an unencrypted disk reports none -- never a claim the machine doesn't back", () => {
    const root = tmp();
    const users = createUserManager({ rootDir: root, secrets: memorySecretStore(), crypt: win32StoreCrypt(() => "none") });
    try {
      expect(users.add("Bob", "bob-pw").encrypted).toBe("none");
    } finally {
      users.closeAll();
    }
  });

  test("/api/users carries the per-user at-rest field, pre-auth", async () => {
    const root = tmp();
    const users = createUserManager({ rootDir: root, secrets: memorySecretStore(), crypt: win32StoreCrypt(() => "os-disk") });
    const server = startIpc({ users, port: 0 });
    try {
      users.add("Alice", "alice-pw");
      const r = await fetch(`http://127.0.0.1:${server.port}/api/users`);
      expect(r.status).toBe(200);
      const body = (await r.json()) as { users: Array<{ id: string; encrypted: string }> };
      expect(body.users.map((u) => ({ id: u.id, encrypted: u.encrypted }))).toEqual([{ id: "alice", encrypted: "os-disk" }]);
    } finally {
      server.stop(true);
      users.closeAll();
    }
  });
});
