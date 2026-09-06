// The nightly wakes the Market Manager (issue #97): after a clean full
// nightly, a plan that opts in and a drift report with candidates start
// the SAME proposal run the Strategy page's button starts -- through the
// scripted Market Manager, the real Auditor, and the real approval gate.
// Bounded: not while a decision is pending, not twice for one drift
// picture, never for a one-institution refresh, never for a plan that
// did not opt in. Every wake and skip is a journal line.

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { SnapshotAccount } from "@fin/contracts";
import { fixtureAdapter, type InstitutionAdapter } from "@fin/institutions";
import type { InferenceSource } from "@intx/types/runtime";

import { createApp, type App } from "../src/app";
import { scriptedAgentFactory } from "./fixtures/scripted-agent";

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "fin-auto-"));
const stubSource = (): InferenceSource => ({ id: "stub", provider: "anthropic", baseURL: "http://localhost:1", apiKey: "stub", model: "stub" });

function writePlan(dataDir: string, autoPropose: boolean | undefined, notes?: string): void {
  fs.mkdirSync(dataDir, { recursive: true });
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
      ...(notes !== undefined ? { notes } : {}),
      ...(autoPropose !== undefined ? { auto_propose: autoPropose } : {}),
    }),
  );
}

/** The phase-4 fixture portfolio: equity is 28% against a 5% target, so drift has candidates. */
function adapters(now: Date): InstitutionAdapter[] {
  const asOf = now.toISOString();
  const broker: SnapshotAccount[] = [
    {
      account_id: "acct.broker.taxable",
      name: "Taxable",
      type: "brokerage",
      currency: "USD",
      as_of: asOf,
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
  return [fixtureAdapter("inst.broker", { accounts: broker })];
}

const openApp = (dataDir: string): App =>
  createApp({ dataDir, adapters: adapters(new Date()), pollMs: 20, agentFactory: scriptedAgentFactory(), inferenceSource: stubSource });

const journal = (app: App): string[] => app.ledger.listJournal(50).map((j) => j.summary);
/** Top-level proposal runs (the rework loop's child is stored as `<parent>.rework__<n>`). */
const proposalRuns = async (app: App): Promise<string[]> => (await app.listRuns()).filter((r) => r.runId.startsWith("proposal_") && !r.runId.includes(".")).map((r) => r.runId);

async function until(cond: () => boolean | Promise<boolean>, ms = 60_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("the nightly wakes the Market Manager (issue #97)", () => {
  test("a clean nightly with drift starts one proposal; a second night waits on the pending decision; a rejected picture is not re-proposed", async () => {
    const dataDir = tmp();
    writePlan(dataDir, true);
    const app = openApp(dataDir);
    try {
      expect((await app.runNightly({ runId: "nightly_1" })).terminalStatus).toBe("completed");
      // The decision is journaled before runNightly resolves; the run itself is detached.
      const woke = journal(app).find((s) => s.startsWith("nightly nightly_1 woke the Market Manager"));
      expect(woke).toMatch(/\d candidate orders? \(.*BUY BND.*\); proposal proposal_\S+ started/);
      const state = app.planStatus().auto_propose!;
      expect(state).toMatchObject({ nightly_run: "nightly_1", outcome: "started" });
      expect(state.signature).toContain("BUY BND");
      expect(state.proposal_run).toMatch(/^proposal_/);
      // ...and parks at the approval gate: the same recommendation the button would queue.
      await until(() => app.approvalQueue().length === 1);
      const q = app.approvalQueue();
      expect(q[0]!.recommendation.id).toBe(`rec_${state.proposal_run!}.1`);
      expect(q[0]!.recommendation.action).toMatchObject({ verb: "BUY", instrument: "BND" });
      // The audit trail ties the two runs together in the journal's detail.
      const wokeEntry = app.ledger.listJournal(50).find((j) => j.summary.startsWith("nightly nightly_1 woke"))!;
      expect(wokeEntry.author).toBe("scheduler");
      expect(wokeEntry.detail).toMatchObject({ nightly_run: "nightly_1", outcome: "started", proposal_run: state.proposal_run });

      // Night two: a recommendation awaits the operator -- no second wake.
      expect((await app.runNightly({ runId: "nightly_2" })).terminalStatus).toBe("completed");
      expect(journal(app).find((s) => s.startsWith("nightly nightly_2"))).toMatch(/did not wake .*1 recommendation already awaits your decision/);
      expect(await proposalRuns(app)).toHaveLength(1);

      // The operator rejects it. Night three: the same drift picture, inside a week -- not again.
      await app.decideRecommendation({ recommendationId: q[0]!.recommendation.id, decision: "reject", note: "not now", signedBy: "brian" });
      await until(() => app.approvalQueue().length === 0);
      expect((await app.runNightly({ runId: "nightly_3" })).terminalStatus).toBe("completed");
      expect(journal(app).find((s) => s.startsWith("nightly nightly_3"))).toMatch(/did not wake .*drift picture \(.*BUY BND.*\) is unchanged since the proposal of \d{4}-\d{2}-\d{2}/);
      expect(await proposalRuns(app)).toHaveLength(1);
      expect(app.planStatus().auto_propose).toMatchObject({ nightly_run: "nightly_3", outcome: "skipped", last_started_signature: state.signature });
    } finally {
      app.close();
    }
  });

  test("a plan that did not opt in, and a one-institution refresh, never wake it", async () => {
    const dataDir = tmp();
    writePlan(dataDir, undefined);
    const app = openApp(dataDir);
    try {
      expect((await app.runNightly({ runId: "nightly_off" })).terminalStatus).toBe("completed");
      expect(app.planStatus().drift!.candidates.length).toBeGreaterThan(0); // material, but not asked for
      expect(app.planStatus().auto_propose).toBeNull();
      expect(journal(app).some((s) => s.includes("Market Manager"))).toBe(false);
      expect(await proposalRuns(app)).toHaveLength(0);

      // Opting in, then a refresh of one institution (a GUI edit's follow-up): still nothing.
      writePlan(dataDir, true);
      expect((await app.runNightly({ runId: "nightly_partial", institutions: ["inst.broker"] })).terminalStatus).toBe("completed");
      expect(app.planStatus().auto_propose).toBeNull();
      expect(await proposalRuns(app)).toHaveLength(0);
    } finally {
      app.close();
    }
  });

  test("a Market Manager decline is journaled by the run itself; the wake is recorded once", async () => {
    const dataDir = tmp();
    writePlan(dataDir, true, "decline: the only candidate buys into a class we are exiting");
    const app = openApp(dataDir);
    try {
      expect((await app.runNightly({ runId: "nightly_d" })).terminalStatus).toBe("completed");
      const state = app.planStatus().auto_propose!;
      expect(state.outcome).toBe("started");
      await until(async () => (await app.listRuns()).some((r) => r.runId === state.proposal_run && r.status !== "running"));
      expect(app.approvalQueue()).toHaveLength(0);
      expect(journal(app).some((s) => s.includes("declined to propose (attempt 1): the only candidate buys into a class we are exiting"))).toBe(true);
    } finally {
      app.close();
    }
  });
});
