// Phase 4 with the REAL Market Manager model (skipped without
// ANTHROPIC_API_KEY): the model reads the drift through its tools,
// emits the canonical draft, and the Auditor -- who re-runs the same
// deterministic engine -- clears it into the approval queue.

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { SnapshotAccount } from "@fin/contracts";
import { fixtureAdapter } from "@fin/institutions";

import { createApp } from "../src/app";

const hasKey = (process.env["ANTHROPIC_API_KEY"] ?? "") !== "";

describe("phase 4 live (real model; needs ANTHROPIC_API_KEY)", () => {
  test.skipIf(!hasKey)(
    "the Market Manager proposes from real drift and the Auditor clears it",
    async () => {
      const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fin-p4live-"));
      fs.writeFileSync(
        path.join(dataDir, "plan.json"),
        JSON.stringify({
          as_of: "2026-08-01",
          band: "0.05",
          targets: [
            { asset_class: "etf", weight: "0.55" },
            { asset_class: "equity", weight: "0.05" },
            { asset_class: "bond", weight: "0.4" },
          ],
          constraints: { do_not_sell: [], tax_cash_horizon_days: 60 },
        }),
      );
      const broker: SnapshotAccount[] = [
        {
          account_id: "acct.broker.taxable",
          name: "Taxable",
          type: "brokerage",
          currency: "USD",
          as_of: new Date().toISOString(),
          balances: [{ balance_type: "total", amount: "108000" }],
          positions: [
            { instrument: { symbol: "VTI", asset_class: "etf" }, quantity: "240", price: "250", market_value: "60000", cost_basis: "50000" },
            { instrument: { symbol: "AAPL", asset_class: "equity" }, quantity: "100", price: "300", market_value: "30000", cost_basis: "12000", lots: [{ lot_id: "aapl-2020", quantity: "100", acquired_at: "2020-02-01", cost_basis: "12000" }] },
            { instrument: { symbol: "BND", asset_class: "bond" }, quantity: "100", price: "100", market_value: "10000", cost_basis: "10500" },
            { instrument: { symbol: "CASH", asset_class: "cash" }, quantity: "8000", price: "1", market_value: "8000", cost_basis: "8000" },
          ],
          transactions: [],
        },
      ];
      const app = createApp({ dataDir, adapters: [fixtureAdapter("inst.broker", { accounts: broker })], pollMs: 20 });
      expect((await app.runNightly({ runId: "nightly_p4live" })).terminalStatus).toBe("completed");

      const r = await app.startProposal({ timeoutMs: 300_000 });
      expect(r.state).toBe("queued");
      const queue = app.approvalQueue();
      expect(queue).toHaveLength(1);
      const rec = queue[0]!.recommendation;
      // The figures are the canonical candidate's -- the model chose,
      // the engine computed, the auditor reproduced.
      expect(["BUY", "SELL"]).toContain(rec.action.verb);
      expect(rec.thesis.length).toBeGreaterThan(20);
      expect(queue[0]!.verdict.cleared).toBe(true);
      for (const id of rec.evidence) expect(app.ledger.getFact(id)).not.toBeNull();
      app.close();
    },
    360_000,
  );
});
