// What the Market Manager SEES, and what it replies (issue #101). A
// Coinbase order fills in pieces and every fill is a lot; 1,000 of them
// pushed a draft past the runtime's 10,000-character tool-output cap,
// the model read a truncation marker, and -- told to retype the draft
// verbatim -- it declined. Now the tool results carry lots and evidence
// as counts, the reply is the model's CHOICE, and the intake rebuilds
// the draft with the same engine. Driven through the real tool bundle
// over a real ledger, then through the app with the scripted model.

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { assertType, ProposalChoice, type InvestmentPlan, type SnapshotAccount } from "@fin/contracts";
import { fixtureAdapter } from "@fin/institutions";
import { marketTools, type FinToolEnv } from "@fin/tools";
import type { ToolBundle } from "@intx/agent";
import type { InferenceSource } from "@intx/types/runtime";

import { createApp } from "../src/app";
import { scriptedAgentFactory } from "./fixtures/scripted-agent";

/** The runtime's default tool-output cap (DEFAULT_SIZE_CAP_MAX_CHARS in @intx/inference). */
const TOOL_OUTPUT_CAP = 10_000;
const FILLS = 1000;

const stubSource = (): InferenceSource => ({ id: "stub", provider: "anthropic", baseURL: "http://localhost:1", apiKey: "stub", model: "stub" });

/** The phase-4 portfolio, with the equity position bought as 1,000 fills of one order. */
function account(asOf: string): SnapshotAccount {
  return {
    account_id: "acct.broker.taxable",
    name: "Taxable",
    type: "brokerage",
    currency: "USD",
    as_of: asOf,
    balances: [{ balance_type: "total", amount: "108000" }],
    positions: [
      { instrument: { symbol: "VTI", asset_class: "etf" }, quantity: "240", price: "250", market_value: "60000", cost_basis: "50000" },
      {
        instrument: { symbol: "AAPL", asset_class: "equity" },
        quantity: "100",
        price: "300",
        market_value: "30000",
        cost_basis: "12000",
        lots: Array.from({ length: FILLS }, (_, i) => ({ lot_id: `aapl-fill-${String(i).padStart(4, "0")}`, quantity: "0.1", acquired_at: "2020-02-01", cost_basis: "12" })),
      },
      { instrument: { symbol: "BND", asset_class: "bond" }, quantity: "100", price: "100", market_value: "10000", cost_basis: "10500" },
      { instrument: { symbol: "CASH", asset_class: "cash" }, quantity: "8000", price: "1", market_value: "8000", cost_basis: "8000" },
    ],
    transactions: [],
  };
}

const PLAN: InvestmentPlan = {
  as_of: "2026-08-01",
  band: "0.05",
  // Equity is 30% against 5% (+25pp) and bond 10% against 30% (-20pp): the SELL of AAPL is candidate 0.
  targets: [
    { asset_class: "etf", weight: "0.65" },
    { asset_class: "equity", weight: "0.05" },
    { asset_class: "bond", weight: "0.3" },
  ],
  constraints: { do_not_sell: [], tax_cash_horizon_days: 60 },
};

describe("the Market Manager's view of a 1,000-fill position (#101)", () => {
  test("tool results stay under the runtime cap, the reply is a choice, and the queued recommendation carries one conceptual lot", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fin-fills-"));
    fs.writeFileSync(path.join(dataDir, "plan.json"), JSON.stringify(PLAN));
    const app = createApp({ dataDir, adapters: [fixtureAdapter("inst.broker", { accounts: [account(new Date().toISOString())] })], pollMs: 20, agentFactory: scriptedAgentFactory(), inferenceSource: stubSource });
    try {
      expect((await app.runNightly({ runId: "nightly_fills" })).terminalStatus).toBe("completed");
      expect(app.ledger.asOf({ kind: "lot" }).length).toBe(FILLS);

      // The real tool bundle over the real ledger, as the step invoker builds it.
      const fin: FinToolEnv = {
        ledger: app.ledger,
        clock: () => new Date(),
        taxProfile: () => null,
        estateFile: () => null,
        profile: () => null,
        plan: () => PLAN,
        saveDocument: () => {
          throw new Error("not in this test");
        },
        fx: async () => ({ to: "USD", date: "2026-09-06", rates: {}, stale: false }),
        evidence: () => {},
        journal: () => {},
      };
      const bundle: ToolBundle = marketTools({ fin } as never);
      const signal = new AbortController().signal;
      const text = (content: unknown): string => (typeof content === "string" ? content : JSON.stringify(content));

      const drift = await bundle.run({ id: "c1", name: "compute_rebalance", arguments: { run_key: "view" } }, signal);
      expect(drift.isError).not.toBe(true);
      expect(text(drift.content).length).toBeLessThan(TOOL_OUTPUT_CAP);
      const report = drift.content as { evidence_count: number; evidence?: unknown; candidates: Array<{ side: string; symbol: string; quantity: string; tax_lots?: unknown }> };
      expect(report.evidence).toBeUndefined();
      expect(report.evidence_count).toBeGreaterThan(0);
      expect(report.candidates[0]).toMatchObject({ side: "SELL", symbol: "AAPL", quantity: "83" });
      // Lots as counts: 830 fills folded into one long-term conceptual lot.
      expect(report.candidates[0]!.tax_lots).toEqual({ lots: 1, fills: 830, by_treatment: { LTCG: 1, STCG: 0, none: 0, unknown: 0 } });

      const emitted = await bundle.run({ id: "c2", name: "emit_proposal", arguments: { run_key: "view", candidate_index: 0, thesis: "equity is six times its target; trim toward plan", confidence: 0.8 } }, signal);
      expect(emitted.isError).not.toBe(true);
      expect(text(emitted.content).length).toBeLessThan(TOOL_OUTPUT_CAP);
      const out = emitted.content as { draft: Record<string, unknown>; reply: unknown };
      expect(out.draft["evidence"]).toBeUndefined();
      expect(out.draft["tax_lots"]).toEqual({ lots: 1, fills: 830, by_treatment: { LTCG: 1, STCG: 0, none: 0, unknown: 0 } });
      expect(out.draft["action"]).toMatchObject({ verb: "SELL", instrument: "AAPL", quantity: "83" });
      // The reply the model repeats is its choice: a few hundred characters, no figure in it.
      const choice = assertType(ProposalChoice, out.reply, "reply");
      expect(choice).toEqual({ candidate_index: 0, thesis: "equity is six times its target; trim toward plan", confidence: 0.8 });
      expect(JSON.stringify(out.reply).length).toBeLessThan(400);

      // End to end through the app: the scripted model replies with that choice and the intake rebuilds the draft.
      const r = await app.startProposal();
      expect(r.state).toBe("queued");
      const q = app.approvalQueue();
      expect(q).toHaveLength(1);
      expect(q[0]!.recommendation.action).toMatchObject({ verb: "SELL", instrument: "AAPL", quantity: "83" });
      expect(q[0]!.recommendation.evidence.length).toBeGreaterThan(0);
      expect(q[0]!.recommendation.tax_lots).toEqual([{ lot_id: "aapl-fill-0000", treatment: "LTCG", fills: 830, quantity: "83", acquired_at: "2020-02-01" }]);
      expect(q[0]!.verdict.cleared).toBe(true);
    } finally {
      app.close();
    }
  });
});
