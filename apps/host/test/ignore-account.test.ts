// Issue #17: hide one account from among many at the same institution.
// Hiding closes it (leaves totals and the card now) and flags it ignored
// so fetches skip it; restoring reopens it for the next fetch.

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { addInstitutionEntry, memorySecretStore } from "@fin/institutions";
import { openLedger, views } from "@fin/ledger";
import type { AccountPayload, FactInput } from "@fin/contracts";

import { createApp } from "../src/app";

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "fin-ignore-"));

function account(subject: string, institution: string, name: string, mask: string): FactInput {
  return {
    kind: "account",
    subject,
    key: "account",
    payload: { account_id: subject, institution_id: institution, name, type: "checking", currency: "USD", masked_number: mask } satisfies AccountPayload,
    observed_at: "2026-08-24T00:00:00.000Z",
    effective_at: "2026-08-24T00:00:00.000Z",
    source_id: institution,
    source_doc_id: null,
    supersedes: null,
    writer: "assets_manager",
    provisional: false,
  };
}

describe("setAccountIgnored", () => {
  test("hide closes and flags; the overview hides the row but lists it for restore; restore reopens", () => {
    const dataDir = tmp();
    const plaid = addInstitutionEntry(dataDir, { name: "Bank", adapter: "plaid", options: {} });
    {
      const ledger = openLedger(path.join(dataDir, "ledger.db"));
      ledger.commit({
        batchId: "seed",
        writer: "assets_manager",
        facts: [
          account("acct.bank.keep", plaid.institution_id, "Keep", "1111"),
          account("acct.bank.hide", plaid.institution_id, "Hide Me", "2222"),
        ],
      });
      ledger.close();
    }
    const app = createApp({ dataDir, connectors: { secrets: memorySecretStore() } });
    try {
      app.setAccountIgnored("acct.bank.hide", true);
      const hidden = views.accounts(app.ledger).find((a) => a.account_id === "acct.bank.hide");
      expect(hidden?.ignored).toBe(true);
      expect(hidden?.closed_at).not.toBeNull();
      const card = app.institutionsOverview().institutions.find((i) => i.institution_id === plaid.institution_id)!;
      const row = card.accounts.find((r) => r.account_id === "acct.bank.hide")!;
      expect(row.closed).toBe(true); // the GUI's row filter hides it...
      expect(row.ignored).toBe(true); // ...and the hidden-accounts list offers Restore
      expect(card.accounts.find((r) => r.account_id === "acct.bank.keep")?.closed).toBe(false);

      app.setAccountIgnored("acct.bank.hide", true); // idempotent: no second fact
      const factsAfter = app.ledger.factCount();
      app.setAccountIgnored("acct.bank.hide", true);
      expect(app.ledger.factCount()).toBe(factsAfter);

      app.setAccountIgnored("acct.bank.hide", false);
      const restored = views.accounts(app.ledger).find((a) => a.account_id === "acct.bank.hide");
      expect(restored?.ignored).toBe(false);
      expect(restored?.closed_at).toBeNull();

      expect(() => app.setAccountIgnored("acct.nope", true)).toThrow(/not an account/);
    } finally {
      app.close();
    }
  });
});
