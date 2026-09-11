// Issue #122: a property saved before D-049 has a snapshot file without
// the `manual` flag, and the nightly re-reads that file every night. The
// flag must come from the institution being managed, not from the file,
// so the valuation never reads as stale and an open stale finding on it
// clears itself.
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { defaultInbox } from "@fin/institutions";

import { createApp } from "../src/app";

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "fin-managed-stale-"));

describe("managed holdings saved before D-049", () => {
  test("a pre-flag snapshot re-read weeks later is not stale, and its old stale finding resolves", async () => {
    const dataDir = tmp();
    let now = new Date("2026-08-01T00:00:00.000Z");
    const app = createApp({ dataDir, clock: () => now });
    try {
      const inst = app.addInstitution({ name: "The House", mode: "managed", category: "real_estate" });
      // What the managed writer wrote before #85: no `manual` on the account.
      const inbox = defaultInbox(dataDir, inst.institution_id);
      fs.mkdirSync(inbox, { recursive: true });
      const accountId = `acct.${inst.institution_id.slice(5)}.house`;
      fs.writeFileSync(
        path.join(inbox, "2026-08-01T00-00-00-000Z.json"),
        JSON.stringify({
          institution_id: inst.institution_id,
          accounts: [{ account_id: accountId, name: "House", type: "real_estate", currency: "USD", as_of: now.toISOString(), balances: [{ balance_type: "total", amount: "500000" }] }],
        }),
      );
      expect((await app.runNightly({ runId: "n1" })).terminalStatus).toBe("completed");
      // The finding the old code raised on it, still open in the ledger.
      app.ledger.appendFinding({
        kind: "staleness",
        code: "stale_balance",
        severity: "medium",
        subject: accountId,
        summary: "raised before the fix",
        detail: {},
        evidence: [],
        before: [],
        after: [],
        requires_human: true,
        emitted_by: "reconciliation",
        as_of: now.toISOString(),
        provenance: { source_id: "handler.reconcile", source_doc_id: null, observed_at: now.toISOString(), via: "reconcile@1" },
      });
      expect(app.ledger.openFindings({ subject: accountId }).filter((f) => f.code === "stale_balance")).toHaveLength(1);

      // Weeks later the nightly re-reads the same file.
      now = new Date("2026-09-10T21:00:00.000Z");
      expect((await app.runNightly({ runId: "n2" })).terminalStatus).toBe("completed");
      const open = app.ledger.openFindings({ subject: accountId });
      expect(open.filter((f) => f.code === "stale_balance")).toHaveLength(0);
      const all = app.ledger.allFindings(100).filter((f) => f.subject === accountId && f.code === "stale_balance");
      expect(all).toHaveLength(1); // the old one, now resolved; nothing new raised
    } finally {
      app.close();
    }
  });
});
