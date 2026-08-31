// Issue #11: a ledger duplicated by pre-#2 reconnects heals itself on
// boot. API-connector institutions auto-merge; managed ones never do
// (two identically named manual accounts can be genuinely distinct).

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { AccountPayload, FactInput } from "@fin/contracts";
import { addInstitutionEntry, memorySecretStore } from "@fin/institutions";
import { openLedger, views } from "@fin/ledger";

import { createApp } from "../src/app";

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "fin-automerge-"));

function account(subject: string, institution: string, at: string, extra: Partial<AccountPayload> = {}): FactInput {
  return {
    kind: "account",
    subject,
    key: "account",
    payload: {
      account_id: subject,
      institution_id: institution,
      name: "Checking",
      type: "checking",
      currency: "USD",
      masked_number: "1111",
      ...extra,
    },
    observed_at: at,
    effective_at: at,
    source_id: institution,
    source_doc_id: null,
    supersedes: null,
    writer: "assets_manager",
    provisional: false,
  };
}

describe("boot-time repair of relink duplicates", () => {
  test("a duplicated plaid institution merges on createApp; a managed lookalike pair does not", () => {
    const dataDir = tmp();
    const plaid = addInstitutionEntry(dataDir, { name: "Bank", adapter: "plaid", options: {} });
    const managed = addInstitutionEntry(dataDir, { name: "Shoebox", adapter: "jsondrop", options: { managed: true } });
    {
      const ledger = openLedger(path.join(dataDir, "ledger.db"));
      ledger.commit({
        batchId: "seed",
        writer: "assets_manager",
        facts: [
          account("acct.bank.old", plaid.institution_id, "2026-08-24T00:00:00.000Z"),
          account("acct.bank.new", plaid.institution_id, "2026-08-31T00:00:00.000Z"),
          // Two manual accounts that LOOK identical but are distinct.
          account("acct.shoebox.a", managed.institution_id, "2026-08-24T00:00:00.000Z", { masked_number: null }),
          account("acct.shoebox.b", managed.institution_id, "2026-08-31T00:00:00.000Z", { masked_number: null }),
        ],
      });
      ledger.close();
    }
    const app = createApp({ dataDir, connectors: { secrets: memorySecretStore() } });
    try {
      const accts = views.accounts(app.ledger);
      const bankOpen = accts.filter((a) => a.institution_id === plaid.institution_id && a.closed_at === null);
      expect(bankOpen.map((a) => a.account_id)).toEqual(["acct.bank.old"]);
      expect(accts.find((a) => a.account_id === "acct.bank.new")?.merged_into).toBe("acct.bank.old");
      // The managed pair is untouched.
      const shoebox = accts.filter((a) => a.institution_id === managed.institution_id);
      expect(shoebox.filter((a) => a.closed_at === null)).toHaveLength(2);
      expect(shoebox.every((a) => a.merged_into === null)).toBe(true);
      // The repair is journaled, and a second boot changes nothing.
      expect(app.ledger.listJournal(10).some((j) => j.kind === "system" && j.summary.includes("merged duplicate account"))).toBe(true);
      const facts = app.ledger.factCount();
      app.close();
      const again = createApp({ dataDir, connectors: { secrets: memorySecretStore() } });
      try {
        expect(again.ledger.factCount()).toBe(facts);
      } finally {
        again.close();
      }
    } finally {
      try { app.close(); } catch { /* closed above on the happy path */ }
    }
  });
});
