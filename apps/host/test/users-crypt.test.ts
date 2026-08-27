// Encryption at rest: a user's data directory is an AES-256 encrypted
// APFS sparse bundle, mounted only while they're signed in. Locked
// means ciphertext on disk -- no password, no data.

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { memorySecretStore } from "@fin/institutions";
import { views } from "@fin/ledger";

import { createApp } from "../src/app";
import { isMounted, storeImagePath } from "../src/crypt";
import { createUserManager, userDir } from "../src/users";

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "fin-crypt-"));
const darwin = process.platform === "darwin";

describe.if(darwin)("encrypted user stores", () => {
  test("a new user's data lives in an encrypted volume; sign-out locks it; only the right password unlocks", async () => {
    const root = tmp();
    const users = createUserManager({ rootDir: root, secrets: memorySecretStore() });
    try {
      users.add("Alice", "alice-pw");
      expect(fs.existsSync(storeImagePath(root, "alice"))).toBe(true);
      expect(users.list()[0]?.encrypted).toBe(true);

      const sess = users.login("alice", "alice-pw");
      expect(sess).not.toBeNull();
      const app = users.appFor("alice");
      const inst = app.addInstitution({ name: "Bank", mode: "managed" });
      await app.saveManagedAccount(inst.institution_id, { name: "Cash", type: "checking", value: "777" });
      expect(fs.existsSync(path.join(userDir(root, "alice"), "ledger.db"))).toBe(true);

      // Sign out: the store locks; the mountpoint is an empty husk and the
      // App is unreachable.
      users.logout(sess!.token);
      expect(isMounted(userDir(root, "alice"))).toBe(false);
      expect(fs.existsSync(path.join(userDir(root, "alice"), "ledger.db"))).toBe(false);
      expect(() => users.appFor("alice")).toThrow(/locked/);

      // The wrong password does not unlock it.
      expect(users.login("alice", "wrong")).toBeNull();
      expect(isMounted(userDir(root, "alice"))).toBe(false);

      // The right one brings everything back.
      const again = users.login("alice", "alice-pw");
      expect(again).not.toBeNull();
      expect(views.netWorth(users.appFor("alice").ledger).assets).toBe("777");
      users.logout(again!.token);
    } finally {
      users.closeAll();
    }
  }, 120_000);

  test("a migrated plaintext user is encrypted at first set-password, data intact; delete removes the volume", async () => {
    const root = tmp();
    const legacy = createApp({ dataDir: root });
    const inst = legacy.addInstitution({ name: "Old Bank", mode: "managed" });
    await legacy.saveManagedAccount(inst.institution_id, { name: "Cash", type: "checking", value: "1234" });
    legacy.close();

    const users = createUserManager({ rootDir: root, secrets: memorySecretStore() });
    try {
      expect(users.list()[0]?.encrypted).toBe(false);
      users.setPassword("primary", "first-pw");
      expect(users.list()[0]?.encrypted).toBe(true);
      expect(fs.existsSync(storeImagePath(root, "primary"))).toBe(true);
      // The plaintext staging dir is gone; the data lives inside the volume.
      expect(fs.existsSync(`${userDir(root, "primary")}.migrating`)).toBe(false);
      expect(views.netWorth(users.appFor("primary").ledger).assets).toBe("1234");

      // closeAll (host exit) locks it; a fresh manager sees it locked.
      users.closeAll();
      expect(isMounted(userDir(root, "primary"))).toBe(false);
      const users2 = createUserManager({ rootDir: root, secrets: memorySecretStore() });
      try {
        expect(() => users2.appFor("primary")).toThrow(/locked/);
        const sess = users2.login("primary", "first-pw");
        expect(sess).not.toBeNull();
        expect(views.netWorth(users2.appFor("primary").ledger).assets).toBe("1234");

        users2.deleteUser("primary");
        expect(fs.existsSync(storeImagePath(root, "primary"))).toBe(false);
        expect(users2.list()).toEqual([]);
      } finally {
        users2.closeAll();
      }
    } finally {
      users.closeAll();
    }
  }, 120_000);
});
