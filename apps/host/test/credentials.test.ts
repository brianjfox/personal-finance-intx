// The Credentials page's contract: presence-only status, validated
// writes, deletes, the no-restart Anthropic mirror, and token cleanup
// when an institution is deleted. Values never appear in any response.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { addInstitutionEntry, COINBASE_SERVICE, memorySecretStore, PLAID_SERVICE } from "@fin/institutions";

import { createApp } from "../src/app";

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "fin-cred-"));

// setCredential mirrors the Anthropic key into the running process; keep
// the developer's real key out of the blast radius.
let savedKey: string | undefined;
beforeEach(() => {
  savedKey = process.env["ANTHROPIC_API_KEY"];
});
afterEach(() => {
  if (savedKey === undefined) delete process.env["ANTHROPIC_API_KEY"];
  else process.env["ANTHROPIC_API_KEY"] = savedKey;
});

describe("credentials over the secret store", () => {
  test("status -> set -> replace -> delete; validation and the env mirror", () => {
    const secrets = memorySecretStore();
    const app = createApp({ dataDir: tmp(), connectors: { secrets } });
    try {
      let st = app.credentialsStatus();
      expect(st.slots.map((s) => s.id)).toEqual(["anthropic", "plaid", "enablebanking"]);
      expect(st.slots.every((s) => !s.configured)).toBe(true);
      expect(st.tokens).toHaveLength(0);
      // Presence only -- no secret value anywhere in the status.
      expect(JSON.stringify(st)).not.toContain("sk-");

      // Plaid needs both fields.
      expect(() => app.setCredential("plaid", { client_id: "cid" })).toThrow(/missing Secret/);
      app.setCredential("plaid", { client_id: "cid", secret: "sec" });
      expect(app.credentialsStatus().slots.find((s) => s.id === "plaid")?.configured).toBe(true);
      expect(secrets.dump()[`${PLAID_SERVICE}/client_id`]).toBe("cid");

      // Enable Banking refuses a non-key before storing anything.
      expect(() => app.setCredential("enablebanking", { app_id: "a", private_key: "not a pem" })).toThrow(/doesn't parse/);
      const pem = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }) as string;
      app.setCredential("enablebanking", { app_id: "a", private_key: pem });
      expect(app.credentialsStatus().slots.find((s) => s.id === "enablebanking")?.configured).toBe(true);

      // The Anthropic key takes effect in the running host, no restart.
      delete process.env["ANTHROPIC_API_KEY"];
      app.setCredential("anthropic", { anthropic: "sk-ant-test-123" });
      expect(process.env["ANTHROPIC_API_KEY"]).toBe("sk-ant-test-123");
      expect(app.deleteCredential("anthropic")).toBe(true);
      expect(process.env["ANTHROPIC_API_KEY"]).toBeUndefined();

      expect(app.deleteCredential("plaid")).toBe(true);
      st = app.credentialsStatus();
      expect(st.slots.find((s) => s.id === "plaid")?.configured).toBe(false);
      // Unknown ids are refused (the slot list is a whitelist).
      expect(() => app.setCredential("keychain-anything", { x: "y" })).toThrow(/unknown credential/);
    } finally {
      app.close();
    }
  });

  test("connection tokens are listed and cleaned up when the institution is deleted", async () => {
    const dataDir = tmp();
    const secrets = memorySecretStore({
      [`${COINBASE_SERVICE}/api_key_name:inst.coinbase`]: "org/x/apiKeys/y",
      [`${COINBASE_SERVICE}/private_key:inst.coinbase`]: "pem-here",
    });
    addInstitutionEntry(dataDir, { name: "Coinbase", adapter: "coinbase" });
    const app = createApp({ dataDir, connectors: { secrets } });
    try {
      const st = app.credentialsStatus();
      expect(st.tokens).toEqual([{ institution_id: "inst.coinbase", name: "Coinbase", adapter: "coinbase", set: true }]);

      // Removing tokens from the Credentials page disconnects but keeps the entry.
      expect(app.deleteConnectionTokens("inst.coinbase")).toBe(2);
      expect(app.credentialsStatus().tokens[0]?.set).toBe(false);
      expect(Object.keys(secrets.dump())).toHaveLength(0);

      // Deleting an institution also deletes its tokens.
      secrets.set!(COINBASE_SERVICE, "api_key_name:inst.coinbase", "again");
      secrets.set!(COINBASE_SERVICE, "private_key:inst.coinbase", "again");
      expect(app.removeInstitution("inst.coinbase")).toBe(true);
      expect(Object.keys(secrets.dump())).toHaveLength(0);
      expect(app.credentialsStatus().tokens).toHaveLength(0);
    } finally {
      app.close();
    }
  });
});

describe("delete all data", () => {
  test("wipes the data dir and every stored secret; the injected store never touches the real Keychain", async () => {
    const dataDir = tmp();
    const secrets = memorySecretStore({
      "fin-plaid/client_id": "cid",
      "fin-plaid/secret": "sec",
      "fin-inference/key:openai": "sk-live",
    });
    const app = createApp({ dataDir, connectors: { secrets } });
    try {
      const entry = app.addInstitution({ name: "Wipe Me", mode: "managed" });
      await app.saveManagedAccount(entry.institution_id, { name: "Cash", type: "checking", value: "5" });
      const plaidEntry = addInstitutionEntry(dataDir, { name: "Plaid Bank", adapter: "plaid", options: {} });
      app.reloadInstitutions();
      secrets.set!("fin-plaid", `access_token:${plaidEntry.institution_id}`, "tok");
      expect(fs.existsSync(path.join(dataDir, "ledger.db"))).toBe(true);

      app.deleteAllData();
      expect(fs.existsSync(dataDir)).toBe(false);
      const left = Object.keys(secrets.dump()).filter((k) => k.startsWith("fin-"));
      expect(left).toEqual([]);
    } finally {
      try { app.close(); } catch { /* ledger already closed by the wipe */ }
    }
  });

  // The win32 path: no `security` CLI, but the store can enumerate, so the
  // stray-item sweep asks it for the app's whole fin-* footprint.
  test("sweeps stray fin-* items via enumerate when the store supports it", () => {
    const dataDir = tmp();
    const base = memorySecretStore({
      "fin-interchange/session:stale": "tok",
      "fin-kraken/api_key": "k",
      "other-app/item": "keep",
    });
    const patterns: string[] = [];
    const secrets = {
      ...base,
      enumerate: (pattern: string) => {
        patterns.push(pattern);
        const prefix = pattern.endsWith("*") ? pattern.slice(0, -1) : pattern;
        return Object.keys(base.dump()).filter((k) => k.startsWith(prefix));
      },
    };
    const app = createApp({ dataDir, connectors: { secrets } });
    try {
      app.deleteAllData();
      expect(patterns).toEqual(["fin-*"]);
      expect(Object.keys(base.dump())).toEqual(["other-app/item"]);
      expect(fs.existsSync(dataDir)).toBe(false);
    } finally {
      try { app.close(); } catch { /* ledger already closed by the wipe */ }
    }
  });

  // Multi-user mode passes keychainSweepOnWipe=false for scoped users: the
  // shared store's enumerate would match every user's items, so no sweep.
  test("keychainSweepOnWipe=false suppresses the enumerate sweep", () => {
    const dataDir = tmp();
    const base = memorySecretStore({ "fin-interchange/session:other-user": "tok" });
    const secrets = { ...base, enumerate: (pattern: string) => Object.keys(base.dump()).filter((k) => k.startsWith(pattern.slice(0, -1))) };
    const app = createApp({ dataDir, connectors: { secrets }, keychainSweepOnWipe: () => false });
    try {
      app.deleteAllData();
      expect(Object.keys(base.dump())).toEqual(["fin-interchange/session:other-user"]);
    } finally {
      try { app.close(); } catch { /* ledger already closed by the wipe */ }
    }
  });
});
