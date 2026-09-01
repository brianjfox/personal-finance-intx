// Phase 4 through fin-host: the approval queue over a real proposal run
// -- scripted Market Manager driving the REAL tools (authorized as
// market_manager by the matrix), the real Auditor, the durable approval
// signal, and the prepared-never-sent instruction. Including the
// property the phase is named for: the DECISION delivered through the
// durable inbox while no host is running, honored on the next start.

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { SnapshotAccount } from "@fin/contracts";
import { fixtureAdapter, type InstitutionAdapter } from "@fin/institutions";
import type { InferenceSource } from "@intx/types/runtime";

import { createApp, type App } from "../src/app";
import { scriptedAgentFactory } from "./fixtures/scripted-agent";

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "fin-p4-"));
const stubSource = (): InferenceSource => ({ id: "stub", provider: "anthropic", baseURL: "http://localhost:1", apiKey: "stub", model: "stub" });

function writePlan(dataDir: string, notes?: string): void {
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
    }),
  );
}

function adapters(now: Date, extra: SnapshotAccount[] = []): InstitutionAdapter[] {
  const asOf = now.toISOString();
  const broker: SnapshotAccount[] = [
    ...extra,
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

const openApp = (dataDir: string, extra: SnapshotAccount[] = []): App =>
  createApp({ dataDir, adapters: adapters(new Date(), extra), pollMs: 20, agentFactory: scriptedAgentFactory(), inferenceSource: stubSource });

/** A brokerage account holding a crypto position that would dominate the drift report if it counted. */
function deadAccount(now: Date): SnapshotAccount {
  return {
    account_id: "acct.broker.dead",
    name: "Old account",
    type: "brokerage",
    currency: "USD",
    as_of: now.toISOString(),
    balances: [{ balance_type: "total", amount: "1000000" }],
    positions: [{ instrument: { symbol: "BTC", asset_class: "crypto" }, quantity: "16", price: "62500", market_value: "1000000", cost_basis: "100000" }],
    transactions: [],
  };
}

describe("phase 4 through fin-host: the approval queue", () => {
  test("a second proposal in the same data dir runs its OWN loop child, not a replay of the first (#41)", async () => {
    const dataDir = tmp();
    writePlan(dataDir);
    const app = openApp(dataDir);
    try {
      expect((await app.runNightly({ runId: "nightly_c" })).terminalStatus).toBe("completed");
      const r1 = await app.startProposal({ timeoutMs: 60_000 });
      expect(r1.state).toBe("queued");
      const rec1 = app.approvalQueue()[0]!.recommendation;
      await app.decideRecommendation({ recommendationId: rec1.id, decision: "reject", note: "not now", signedBy: "brian" });
      // The pinned runtime names every loop child `<loopId>__<index>` and
      // adopts an already-persisted child log verbatim -- without the
      // per-run namespace, this second run would replay run 1's child
      // (same recommendation id, or its old failure) instead of drafting.
      const r2 = await app.startProposal({ timeoutMs: 60_000 });
      expect(r2.state).toBe("queued");
      const queue = app.approvalQueue();
      expect(queue).toHaveLength(1);
      expect(queue[0]!.recommendation.id).toBe(`rec_${r2.runId}.1`);
      expect(fs.existsSync(path.join(dataDir, "runs", `${r1.runId}.rework__0`))).toBe(true);
      expect(fs.existsSync(path.join(dataDir, "runs", `${r2.runId}.rework__0`))).toBe(true);
    } finally {
      app.close();
    }
  });

  test("a clean run never inherits a failure from the stale flat rework__0 log an older install left behind (#43)", async () => {
    const dataDir = tmp();
    writePlan(dataDir, "decline");
    // The pre-#41 layout: one flat `runs/rework__0` shared by every
    // proposal, holding a dead child's failure. Left in place by upgrades.
    const legacy = path.join(dataDir, "runs", "rework__0");
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(
      path.join(legacy, "events.jsonl"),
      [
        JSON.stringify({ kind: "RunStarted", seq: 1, at: "2026-09-01T08:53:31.000Z", definitionHash: "00" }),
        JSON.stringify({ kind: "StepFailed", seq: 2, at: "2026-09-01T08:53:41.009Z", stepId: "intake", attempt: 1, error: { message: "missing key intake in path steps.intake.output" }, retriesExhausted: true }),
        JSON.stringify({ kind: "RunFailed", seq: 3, at: "2026-09-01T08:53:41.010Z", error: { message: "one or more steps failed" } }),
      ].join("\n") + "\n",
    );
    const app = openApp(dataDir);
    try {
      expect((await app.runNightly({ runId: "nightly_stale" })).terminalStatus).toBe("completed");
      // The Market Manager declines on every attempt: the run settles with
      // child runs that COMPLETED -- no failure anywhere in this run.
      const r = await app.startProposal({ timeoutMs: 60_000 });
      expect(r.state).toBe("terminal");
      expect(r.status).toBe("completed");
      expect(r.reason).not.toMatch(/missing key/);
      expect(r.reason).toMatch(/declined/);
      expect(app.approvalQueue()).toHaveLength(0);
    } finally {
      app.close();
    }
  });

  test("a decline ends the run after one attempt and puts the Market Manager's reason on the page (#45)", async () => {
    const dataDir = tmp();
    writePlan(dataDir, "decline: the only candidate sells the whole equity sleeve in one order");
    const app = openApp(dataDir);
    try {
      expect((await app.runNightly({ runId: "nightly_decl" })).terminalStatus).toBe("completed");
      const r = await app.startProposal({ timeoutMs: 60_000 });
      expect(r.state).toBe("terminal");
      expect(r.status).toBe("completed");
      expect(r.reason).toBe("the Market Manager reviewed the drift and declined to propose: the only candidate sells the whole equity sleeve in one order");
      expect(app.approvalQueue()).toHaveLength(0);
      // Exactly one model call: the loop converged on the decline instead of redrafting to exhaustion.
      const events = await app.runEvents(r.runId);
      expect(events.filter((e) => e.kind === "ChildSpawned")).toHaveLength(1);
      expect(events.some((e) => e.kind === "StepCompleted" && e.stepId === "declined")).toBe(true);
      const journal = app.ledger.listJournal(20).map((j) => j.summary);
      expect(journal.some((s) => s.includes("declined to propose (attempt 1): the only candidate sells the whole equity sleeve in one order"))).toBe(true);
    } finally {
      app.close();
    }
  });

  test("a hidden account's positions are invisible to drift, the Market Manager, and the Auditor (#47)", async () => {
    const dataDir = tmp();
    writePlan(dataDir);
    const app = openApp(dataDir, [deadAccount(new Date())]);
    try {
      expect((await app.runNightly({ runId: "nightly_dead" })).terminalStatus).toBe("completed");
      // Before hiding: the dead account's 1M of BTC swamps the 100k portfolio.
      const before = app.planStatus().drift!;
      expect(before.by_class.find((l) => l.asset_class === "crypto")?.value).toBe("1000000.00");
      app.setAccountIgnored("acct.broker.dead", true);
      // After: the closed account's facts are still current facts...
      expect(app.ledger.asOf({ kind: "position" }).some((f) => f.subject === "acct.broker.dead")).toBe(true);
      // ...but no longer holdings: the drift report matches the dashboard.
      const after = app.planStatus().drift!;
      expect(after.by_class.find((l) => l.asset_class === "crypto")).toBeUndefined();
      expect(after.portfolio_value).toBe("108000.00");
      expect(after.candidates.map((c) => c.account)).not.toContain("acct.broker.dead");
      // The proposal run (scripted Market Manager through the REAL compute_rebalance /
      // ledger_read_positions tools, real Auditor) queues the live portfolio's candidate.
      const r = await app.startProposal({ timeoutMs: 60_000 });
      expect(r.state).toBe("queued");
      const q = app.approvalQueue();
      expect(q).toHaveLength(1);
      expect(q[0]!.recommendation.subject).toBe("acct.broker.taxable");
      expect(q[0]!.recommendation.action).toMatchObject({ verb: "BUY", instrument: "BND", quantity: "300" });
    } finally {
      app.close();
    }
  });

  test("a sale from an account without lot detail reaches the queue with the Auditor's caveat, not a block (#51)", async () => {
    const dataDir = tmp();
    writePlan(dataDir); // no crypto target: crypto's whole weight is excess
    const crypto: SnapshotAccount = {
      account_id: "acct.broker.crypto",
      name: "Exchange",
      type: "brokerage",
      currency: "USD",
      as_of: new Date().toISOString(),
      balances: [{ balance_type: "total", amount: "100000" }],
      // No lots: exactly what Coinbase/Kraken/wallets deliver.
      positions: [{ instrument: { symbol: "BTC", asset_class: "crypto" }, quantity: "1.6", price: "62500", market_value: "100000", cost_basis: "10000" }],
      transactions: [],
    };
    const app = openApp(dataDir, [crypto]);
    try {
      expect(app.ledger.schemaVersion()).toBe(3);
      expect((await app.runNightly({ runId: "nightly_lots" })).terminalStatus).toBe("completed");
      const r = await app.startProposal({ timeoutMs: 60_000 });
      expect(r.state).toBe("queued");
      const q = app.approvalQueue();
      expect(q).toHaveLength(1);
      expect(q[0]!.recommendation.subject).toBe("acct.broker.crypto");
      expect(q[0]!.recommendation.action).toMatchObject({ verb: "SELL", instrument: "BTC", quantity: "1" });
      expect(q[0]!.recommendation.tax_lots).toEqual([{ lot_id: "unknown", treatment: "unknown" }]);
      expect(q[0]!.verdict.cleared).toBe(true);
      expect(q[0]!.verdict.blocks).toEqual([]);
      expect((q[0]!.verdict.caveats ?? []).map((c) => c.condition)).toEqual(["lot_basis_unknown"]);
      const journal = app.ledger.listJournal(20).map((j) => j.summary);
      expect(journal.some((s) => s.includes("auditor cleared") && s.includes("caveat(s): lot_basis_unknown"))).toBe(true);
    } finally {
      app.close();
    }
  });

  test("bank and sweep balances are cash on hand; a foreign-currency balance is listed, not summed (#55)", async () => {
    const dataDir = tmp();
    writePlan(dataDir);
    const now = new Date().toISOString();
    const bank = (account_id: string, currency: string, total: string): SnapshotAccount => ({ account_id, name: account_id, type: "checking", currency, as_of: now, balances: [{ balance_type: "total", amount: total }], positions: [], transactions: [] });
    const app = openApp(dataDir, [bank("acct.broker.checking", "USD", "5000"), bank("acct.broker.euro", "EUR", "100")]);
    try {
      expect((await app.runNightly({ runId: "nightly_cash" })).terminalStatus).toBe("completed");
      const drift = app.planStatus().drift!;
      // 8,000 CASH sweep position + 5,000 checking; the euro account is excluded by name.
      expect(drift.cash_value).toBe("13000.00");
      expect(drift.cash_excluded).toEqual([{ currency: "EUR", amount: "100.00" }]);
      expect(drift.portfolio_value).toBe("113000.00");
      app.setAccountIgnored("acct.broker.checking", true);
      expect(app.planStatus().drift!.cash_value).toBe("8000.00");
    } finally {
      app.close();
    }
  });

  test("a drift with no candidates ends the run cleanly: no model call, no gate, a plain-words reason (#38)", async () => {
    const dataDir = tmp();
    // A plan that MATCHES the fixture positions (invested: etf .6, equity .3, bond .1): zero candidates.
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(
      path.join(dataDir, "plan.json"),
      JSON.stringify({
        as_of: "2026-08-01",
        band: "0.05",
        targets: [
          { asset_class: "etf", weight: "0.6" },
          { asset_class: "equity", weight: "0.3" },
          { asset_class: "bond", weight: "0.1" },
        ],
        constraints: {},
      }),
    );
    const app = openApp(dataDir);
    try {
      expect((await app.runNightly({ runId: "nightly_nc" })).terminalStatus).toBe("completed");
      const r = await app.startProposal({ timeoutMs: 60_000 });
      expect(r.state).toBe("terminal");
      expect(r.status).toBe("completed");
      expect(r.reason).toMatch(/nothing to propose/);
      expect(app.approvalQueue()).toHaveLength(0);
      // The designed decline is journaled, and the model was never asked.
      expect(app.ledger.listJournal(10).some((j) => j.summary.includes("declined to propose"))).toBe(true);
      // The loop body (where the model call lives) never spawned: the
      // skipped rework branch emits bookkeeping events but no child run.
      const events = await app.runEvents(r.runId);
      expect(events.some((e) => e.kind === "ChildSpawned")).toBe(false);
    } finally {
      app.close();
    }
  });

  test("propose -> queue -> decide through the durable inbox while no host runs -> prepared -> revoke", async () => {
    const dataDir = tmp();
    writePlan(dataDir);
    const seed = openApp(dataDir);
    expect((await seed.runNightly({ runId: "nightly_p4" })).terminalStatus).toBe("completed");
    seed.close();

    // A separate process proposes (real tools under the market_manager
    // principal, real auditor) and exits with the run parked at the gate.
    const child = Bun.spawn(["bun", path.join(import.meta.dir, "fixtures/propose-child.ts"), dataDir], { stdout: "pipe", stderr: "pipe" });
    const out = await new Response(child.stdout).text();
    expect(await child.exited).toBe(0);
    const proposed = JSON.parse(out.trim().split("\n").at(-1) ?? "{}") as { state: string; runId: string; recommendation_id: string };
    expect(proposed.state).toBe("queued");

    // Inspect from the outside (no driver): the queue holds the cleared rec.
    const app = openApp(dataDir);
    const queue = app.approvalQueue();
    expect(queue).toHaveLength(1);
    const rec = queue[0]!.recommendation;
    expect(rec.id).toBe(proposed.recommendation_id);
    expect(rec.action).toMatchObject({ verb: "BUY", instrument: "BND", quantity: "300" });
    expect(queue[0]!.verdict.cleared).toBe(true);
    for (const id of rec.evidence) expect(app.ledger.getFact(id)).not.toBeNull();
    // The scripted agent's tool calls flowed through the policy under
    // market_manager and none were denied.
    expect(app.ledger.listAccess(2000).some((a) => a.action === "denied")).toBe(false);

    // The operator decides while NO host drives the run: durable inbox only.
    await app.decideRecommendation({
      recommendationId: rec.id,
      decision: "approve",
      bound: { max_quantity: "250", limit_price: "101" },
      note: "trim toward plan",
      signedBy: "brian",
      wait: false,
    });
    app.close();

    // The next host consumes it: decide -> route -> prepare -> run completes.
    const restart = Bun.spawn(["bun", path.join(import.meta.dir, "fixtures/resume-child.ts"), dataDir, proposed.runId, "until-complete"], { stdout: "pipe", stderr: "pipe" });
    const out2 = await new Response(restart.stdout).text();
    expect(await restart.exited).toBe(0);
    expect(out2).toContain('"event":"done"');

    const app2 = openApp(dataDir);
    const instructions = app2.listPreparedInstructions();
    expect(instructions).toHaveLength(1);
    expect(instructions[0]!.current_status).toBe("prepared"); // never "sent"
    expect(instructions[0]!.bound).toMatchObject({ max_quantity: "250", limit_price: "101" });
    expect(app2.approvalQueue()).toHaveLength(0);
    const journal = app2.ledger.listJournal().map((j) => j.summary).join("\n");
    expect(journal).toContain("auditor cleared");
    expect(journal).toContain("approved rec_");
    expect(journal).toContain("PREPARED (not sent -- execution is disabled)");

    // Revocable until sent -- and nothing is ever sent. Idempotent.
    const first = app2.revokeInstruction({ instructionId: instructions[0]!.id, note: "changed my mind" });
    expect(first.replayed).toBe(false);
    expect(app2.revokeInstruction({ instructionId: instructions[0]!.id }).replayed).toBe(true);
    expect(app2.listPreparedInstructions()[0]!.current_status).toBe("revoked");
    app2.close();
  }, 90_000);
});
