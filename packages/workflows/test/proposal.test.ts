// Phase 4 acceptance under runLocal: proposal -> auditor -> approval ->
// prepared instruction, with the model replaced by a scripted step
// invoker that builds drafts through the SAME canonicalizer the real
// emit_proposal tool uses -- so "reproducible" and "tampered" are both
// exact, and the four slide-16 blocks are exercised deterministically.

import { describe, expect, test } from "bun:test";

import { auditRecommendation, buildProposalDraft, recommendationId, approvalSignalId } from "@fin/actions";
import type { ActionContext } from "@fin/actions";
import { decimal, type DriftReport, type InvestmentPlan, type Recommendation, type SnapshotAccount } from "@fin/contracts";
import { fixtureAdapter } from "@fin/institutions";
import { approvalQueue, approvalFor, listInstructions, listRecommendations, verdictsFor } from "@fin/ledger";
import type { StepInvoker } from "@intx/workflow";

import {
  APPROVAL_SIGNAL,
  buildProposalWorkflow,
  DEFAULT_CLASSIFIER,
  nightlyWorkflow,
  proposalReference,
  stepOutcomes,
  workflowById,
} from "../src/index";
import { harness, type Harness } from "./harness";

const NIGHTLY = workflowById(nightlyWorkflow.id);
const NOW = "2026-08-24T06:00:00.000Z";

const PLAN: InvestmentPlan = {
  as_of: "2026-08-01",
  band: "0.05",
  targets: [
    { asset_class: "etf", weight: "0.55" },
    { asset_class: "equity", weight: "0.05" },
    { asset_class: "bond", weight: "0.4" },
  ],
  constraints: { do_not_sell: [], tax_cash_horizon_days: 60 },
};

// Portfolio: etf 60k, equity 30k, bond 10k (invested 100k) + 8k cash.
// Drift: bond -30pp under (candidate 0: BUY 300 BND @100 = 30,000),
// equity +25pp over (candidate 1: SELL 100 AAPL @300 = 30,000, LTCG lot).
function brokerage(asOf: string): SnapshotAccount {
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
        lots: [{ lot_id: "aapl-2020", quantity: "100", acquired_at: "2020-02-01", cost_basis: "12000" }],
      },
      {
        instrument: { symbol: "BND", asset_class: "bond" },
        quantity: "100",
        price: "100",
        market_value: "10000",
        cost_basis: "10500",
        lots: [{ lot_id: "bnd-2024", quantity: "110", acquired_at: "2024-01-01", cost_basis: "11550" }],
      },
      { instrument: { symbol: "CASH", asset_class: "cash" }, quantity: "8000", price: "1", market_value: "8000", cost_basis: "8000" },
    ],
    transactions: [],
  };
}

function seeded(plan: InvestmentPlan = PLAN): Harness {
  const h = harness({ now: NOW });
  h.setAdapters([fixtureAdapter("inst.broker", { accounts: [brokerage(NOW)] })]);
  h.setInvestmentPlan(plan);
  return h;
}

/** Scripted Market Manager: canonical draft via the shared canonicalizer; tamper or decline on demand. */
function scriptedMM(behavior: (attempt: number) => "canonical" | "tampered" | "second-candidate" | "decline"): StepInvoker {
  return async (req) => {
    const input = req.input as DriftReport & { attempt?: number };
    const attempt = input.attempt ?? 1;
    if (behavior(attempt) === "decline") {
      return { output: { reply: `NOTHING: attempt ${String(attempt)} -- the only sensible candidate sells the whole equity sleeve at once.`, turn: { role: "assistant" } } };
    }
    const idx = behavior(attempt) === "second-candidate" ? 1 : 0;
    const draft = buildProposalDraft(input, idx, {
      thesis: `attempt ${String(attempt)}: rebalance toward the written plan`,
      confidence: 0.7,
      now: new Date(input.as_of),
    });
    if (behavior(attempt) === "tampered") {
      draft.action.quantity = decimal.add(draft.action.quantity, "7"); // a figure the model "typed"
    }
    return { output: { reply: JSON.stringify(draft), turn: { role: "assistant" } } };
  };
}

async function waitFor(pred: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await pred())) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("phase 4: proposal -> audit -> approval -> prepared instruction", () => {
  test("the walker's producers and executors are real now", () => {
    const steps = proposalReference.definition.steps;
    const producer = Object.entries(steps).some(([id, p]) => DEFAULT_CLASSIFIER.isProducer(id, p));
    const executor = Object.entries(steps).some(([id, p]) => DEFAULT_CLASSIFIER.isExecutor(id, p));
    // The producer lives inside the loop body; recurse as the walker does.
    const body = Object.values(steps).flatMap((p) => (p.kind === "loop" ? Object.entries(p.body.steps) : []));
    const bodyProducer = body.some(([id, p]) => DEFAULT_CLASSIFIER.isProducer(id, p));
    expect(executor).toBe(true);
    expect(producer || bodyProducer).toBe(true);
  });

  test("happy path: cleared draft queues; a scoped, bounded approval prepares (never sends) the instruction; the same signal twice lands once", async () => {
    const h = seeded();
    expect((await h.run(NIGHTLY, {})).terminalStatus).toBe("completed");
    const wf = buildProposalWorkflow({ model: "scripted" });
    const run = h.start({ definition: wf.definition, stepPrincipals: wf.stepPrincipals }, {}, { runId: "prop-happy", invokeStep: scriptedMM(() => "canonical") });
    // The run parks at the human gate; the queue holds the cleared rec.
    await waitFor(() => approvalQueue(h.ledger, new Date(NOW)).length === 1);
    const recId = recommendationId("prop-happy", 1);
    const queue = approvalQueue(h.ledger, new Date(NOW));
    expect(queue).toHaveLength(1);
    expect(queue[0]!.recommendation.id).toBe(recId);
    expect(queue[0]!.recommendation.action).toMatchObject({ verb: "BUY", instrument: "BND", quantity: "300" });
    expect(queue[0]!.verdict.cleared).toBe(true);
    // Every evidence id resolves (cite or stay quiet).
    for (const id of queue[0]!.recommendation.evidence) expect(h.ledger.getFact(id)).not.toBeNull();

    // Sign it -- scoped to this rec id, bounded, expiring -- twice (a
    // double-click). The signalId dedupe means one approval.
    const payload = { recommendation_id: recId, decision: "approve", signed_by: "brian", bound: { max_quantity: "250", limit_price: "101" }, note: "trim toward plan" };
    await run.signal(APPROVAL_SIGNAL, payload, approvalSignalId(recId));
    await run.signal(APPROVAL_SIGNAL, payload, approvalSignalId(recId));
    const r = await run.complete;
    expect(r.terminalStatus).toBe("completed");
    const outcomes = stepOutcomes(r.events);
    expect(outcomes["prepare"]).toEqual({ status: "completed" });
    expect(outcomes["rejected"]?.status).toBe("skipped");
    expect(outcomes["expired"]?.status).toBe("skipped");

    const approval = approvalFor(h.ledger, recId);
    expect(approval?.signed_by).toBe("brian");
    expect(approval?.bound).toMatchObject({ max_quantity: "250", limit_price: "101" });
    const instructions = listInstructions(h.ledger);
    expect(instructions).toHaveLength(1);
    expect(instructions[0]!.current_status).toBe("prepared"); // NEVER "sent"
    expect(instructions[0]!.bound.max_quantity).toBe("250");
    // The chain journaled: cleared verdict, the signature with the thesis, the prepared instruction.
    const journal = h.ledger.listJournal().map((j) => j.summary).join("\n");
    expect(journal).toContain("auditor cleared");
    expect(journal).toContain("approved rec_prop-happy.1");
    expect(journal).toContain("PREPARED (not sent -- execution is disabled)");
    // Decided: the queue is empty.
    expect(approvalQueue(h.ledger, new Date(NOW))).toHaveLength(0);
  });

  test("reject: journaled, closed, no instruction", async () => {
    const h = seeded();
    await h.run(NIGHTLY, {});
    const wf = buildProposalWorkflow({ model: "scripted" });
    const run = h.start({ definition: wf.definition, stepPrincipals: wf.stepPrincipals }, {}, { runId: "prop-reject", invokeStep: scriptedMM(() => "canonical") });
    await waitFor(() => approvalQueue(h.ledger, new Date(NOW)).length === 1);
    const recId = recommendationId("prop-reject", 1);
    await run.signal(APPROVAL_SIGNAL, { recommendation_id: recId, decision: "reject", signed_by: "brian", note: "not this week" }, approvalSignalId(recId));
    const r = await run.complete;
    expect(r.terminalStatus).toBe("completed");
    expect(stepOutcomes(r.events)["prepare"]?.status).toBe("skipped");
    expect(listInstructions(h.ledger)).toHaveLength(0);
    expect(approvalFor(h.ledger, recId)).toBeNull();
    expect(h.ledger.listJournal().some((j) => j.summary.includes("rejected rec_prop-reject.1"))).toBe(true);
    expect(approvalQueue(h.ledger, new Date(NOW))).toHaveLength(0);
  });

  test("expiry: no decision inside the window routes to expired -- never to execution", async () => {
    const h = seeded();
    await h.run(NIGHTLY, {});
    const wf = buildProposalWorkflow({ model: "scripted", expiryMs: 250 });
    const r = await h.run({ definition: wf.definition, stepPrincipals: wf.stepPrincipals }, {}, { runId: "prop-expire", invokeStep: scriptedMM(() => "canonical") });
    expect(r.terminalStatus).toBe("completed");
    const outcomes = stepOutcomes(r.events);
    expect(outcomes["expired"]).toEqual({ status: "completed" });
    expect(outcomes["decide"]?.status).toBe("skipped");
    expect(outcomes["prepare"]?.status).toBe("skipped");
    expect(listInstructions(h.ledger)).toHaveLength(0);
    expect(h.ledger.eventsSince(0).some((e) => e.kind === "proposal.expired")).toBe(true);
    // Dead, not stale: the rec's own expiry keeps it out of the queue too.
    expect(approvalQueue(h.ledger, new Date(Date.parse(NOW) + 1000))).toHaveLength(0);
  });

  test("the redraft loop: a tampered figure is blocked as unreproducible; the redraft clears on attempt 2", async () => {
    const h = seeded();
    await h.run(NIGHTLY, {});
    const wf = buildProposalWorkflow({ model: "scripted" });
    const run = h.start(
      { definition: wf.definition, stepPrincipals: wf.stepPrincipals },
      {},
      { runId: "prop-redraft", invokeStep: scriptedMM((attempt) => (attempt === 1 ? "tampered" : "canonical")) },
    );
    await waitFor(() => approvalQueue(h.ledger, new Date(NOW)).length === 1);
    const recs = listRecommendations(h.ledger).filter((x) => x.id.startsWith("rec_prop-redraft"));
    expect(recs.map((x) => x.id).sort()).toEqual(["rec_prop-redraft.1", "rec_prop-redraft.2"]);
    const v1 = verdictsFor(h.ledger, "rec_prop-redraft.1");
    expect(v1[0]!.cleared).toBe(false);
    expect(v1[0]!.blocks[0]!.condition).toBe("unreproducible");
    expect(verdictsFor(h.ledger, "rec_prop-redraft.2")[0]!.cleared).toBe(true);
    // Only the cleared attempt is in the queue.
    const queue = approvalQueue(h.ledger, new Date(NOW));
    expect(queue.map((q) => q.recommendation.id)).toEqual(["rec_prop-redraft.2"]);
    const recId = "rec_prop-redraft.2";
    await run.signal(APPROVAL_SIGNAL, { recommendation_id: recId, decision: "approve", signed_by: "b" }, approvalSignalId(recId));
    const r = await run.complete;
    expect((r.outputs["rework"] as { iterations: number; outcome: string }).iterations).toBe(2);
    expect(listInstructions(h.ledger)).toHaveLength(1);
  });

  test("declined: the Market Manager's NOTHING ends the run after ONE attempt at the declined terminal, reason journaled, gate never armed (#45)", async () => {
    const h = seeded();
    await h.run(NIGHTLY, {});
    const wf = buildProposalWorkflow({ model: "scripted" });
    const r = await h.run({ definition: wf.definition, stepPrincipals: wf.stepPrincipals }, {}, { runId: "prop-decline", invokeStep: scriptedMM(() => "decline") });
    expect(r.terminalStatus).toBe("completed");
    const outcomes = stepOutcomes(r.events);
    // One attempt, converged (not exhausted): the same report would only draw the same answer.
    expect(r.outputs["rework"]).toMatchObject({ outcome: "converged", iterations: 1 });
    expect(outcomes["settle"]).toEqual({ status: "completed" });
    expect(r.outputs["settle"]).toMatchObject({ queued: false, recommendation_id: null });
    expect(outcomes["declined"]).toEqual({ status: "completed" });
    expect(outcomes["approve"]?.status).toBe("skipped");
    expect(outcomes["exhausted"]?.status).toBe("skipped");
    // Nothing recorded, nothing queued; the decline and its reason are journaled.
    expect(listRecommendations(h.ledger).filter((x) => x.id.startsWith("rec_prop-decline"))).toHaveLength(0);
    expect(approvalQueue(h.ledger, new Date(NOW))).toHaveLength(0);
    expect(h.ledger.eventsSince(0).some((e) => e.kind === "proposal.declined")).toBe(true);
    const journal = h.ledger.listJournal(20).map((j) => j.summary);
    expect(journal.some((s) => s.includes("declined to propose (attempt 1): attempt 1 -- the only sensible candidate sells the whole equity sleeve at once."))).toBe(true);
  });

  test("exhausted: every redraft blocked -> nothing reaches the queue, the gate never arms", async () => {
    const h = seeded();
    await h.run(NIGHTLY, {});
    const wf = buildProposalWorkflow({ model: "scripted", maxRedrafts: 2 });
    const r = await h.run({ definition: wf.definition, stepPrincipals: wf.stepPrincipals }, {}, { runId: "prop-exhaust", invokeStep: scriptedMM(() => "tampered") });
    expect(r.terminalStatus).toBe("completed");
    const outcomes = stepOutcomes(r.events);
    expect(outcomes["exhausted"]).toEqual({ status: "completed" });
    expect(outcomes["approve"]?.status).toBe("skipped");
    expect(outcomes["settle"]?.status).toBe("skipped");
    expect(outcomes["declined"]?.status).toBe("skipped");
    expect((r.outputs["rework"] as { outcome: string }).outcome).toBe("exhausted");
    expect(approvalQueue(h.ledger, new Date(NOW))).toHaveLength(0);
    expect(h.ledger.eventsSince(0).some((e) => e.kind === "proposal.exhausted")).toBe(true);
  });
});

describe("the four slide-16 blocks, one by one (auditRecommendation direct)", () => {
  function auditCtx(h: Harness, plan: InvestmentPlan): ActionContext {
    return { ledger: h.ledger, vault: h.vault, adapters: () => [], clock: () => new Date(NOW), plan: () => plan };
  }
  async function clearedRec(h: Harness, plan: InvestmentPlan, index: 0 | 1): Promise<Recommendation> {
    // Build the canonical draft the auditor should clear, then vary it per test.
    const actx = auditCtx(h, plan);
    const { computeDrift } = await import("@fin/actions");
    const drift = computeDrift({ runKey: "unit", now: new Date(NOW), plan, positions: h.ledger.asOf({ kind: "position" }), lots: h.ledger.asOf({ kind: "lot" }) });
    const draft = buildProposalDraft(drift, index, { thesis: "t", confidence: 0.5, now: new Date(NOW) });
    void actx;
    return {
      id: `rec_unit.${String(index)}1`,
      from: "market_manager",
      subject: draft.subject,
      action: draft.action,
      thesis: draft.thesis,
      evidence: draft.evidence,
      as_of: draft.as_of,
      ...(draft.tax_lots !== undefined ? { tax_lots: draft.tax_lots } : {}),
      confidence: draft.confidence,
      requires: draft.requires,
      expires: draft.expires,
      provenance: { source_id: "market.manager", source_doc_id: null, observed_at: NOW, via: "mm@1" },
    };
  }

  test("1. unreproducible: an edited figure and a dangling evidence id both block", async () => {
    const h = seeded();
    await h.run(NIGHTLY, {});
    const rec = await clearedRec(h, PLAN, 0);
    expect(auditRecommendation(auditCtx(h, PLAN), rec, "unit", 1).cleared).toBe(true);
    const tampered = { ...rec, action: { ...rec.action, quantity: "301" } };
    const v = auditRecommendation(auditCtx(h, PLAN), tampered, "unit", 1);
    expect(v.cleared).toBe(false);
    expect(v.blocks[0]!.condition).toBe("unreproducible");
    const dangling = { ...rec, evidence: [...rec.evidence, "fact_00000000000000000000000000"] };
    expect(auditRecommendation(auditCtx(h, PLAN), dangling, "unit", 1).blocks.some((b) => b.condition === "unreproducible")).toBe(true);
  });

  test("2b. lots (#51): an unknown lot is a caveat, not a block; a short-term lot blocks unless acknowledged, then becomes a caveat", async () => {
    const h = seeded();
    await h.run(NIGHTLY, {});
    const rec = await clearedRec(h, PLAN, 1); // SELL 100 AAPL, a 2020 (long-term) lot
    const base = auditRecommendation(auditCtx(h, PLAN), rec, "unit", 1);
    expect(base.cleared).toBe(true);
    expect(base.caveats ?? []).toEqual([]);
    // Coinbase-style: no lot detail at all.
    const unknown = auditRecommendation(auditCtx(h, PLAN), { ...rec, tax_lots: [{ lot_id: "unknown", treatment: "unknown" }] }, "unit", 1);
    expect(unknown.cleared).toBe(true);
    expect((unknown.caveats ?? []).map((c) => c.condition)).toEqual(["lot_basis_unknown"]);
    expect(unknown.caveats![0]!.detail).toContain("cannot be verified");
    // A known short-term lot: blocked, and the block says how to acknowledge.
    const st = auditRecommendation(auditCtx(h, PLAN), { ...rec, tax_lots: [{ lot_id: "aapl-2026", treatment: "STCG" }] }, "unit", 1);
    expect(st.cleared).toBe(false);
    expect(st.blocks.map((b) => b.condition)).toEqual(["wash_sale"]);
    expect(st.blocks[0]!.detail).toContain('acknowledgements: ["short_term_lots"]');
    // Acknowledged on the record: cleared, with the caveat instead.
    const acked = auditRecommendation(auditCtx(h, PLAN), { ...rec, tax_lots: [{ lot_id: "aapl-2026", treatment: "STCG" }], acknowledgements: ["short_term_lots"] }, "unit", 1);
    expect(acked.cleared).toBe(true);
    expect((acked.caveats ?? []).map((c) => c.condition)).toEqual(["short_term_lots"]);
    // The draft builder carries acknowledgements through, de-duplicated.
    const { computeDrift } = await import("@fin/actions");
    const drift = computeDrift({ runKey: "unit", now: new Date(NOW), plan: PLAN, positions: h.ledger.asOf({ kind: "position" }), lots: h.ledger.asOf({ kind: "lot" }) });
    const draft = buildProposalDraft(drift, 1, { thesis: "t", confidence: 0.5, now: new Date(NOW), acknowledgements: ["short_term_lots", "short_term_lots"] });
    expect(draft.acknowledgements).toEqual(["short_term_lots"]);
  });

  test("3. plan conflict: a do-not-sell symbol and an oversized order both block", async () => {
    const h = seeded();
    await h.run(NIGHTLY, {});
    const noSell: InvestmentPlan = { ...PLAN, constraints: { ...PLAN.constraints, do_not_sell: ["AAPL"] } };
    const sellRec = await clearedRec(h, noSell, 1); // SELL AAPL
    const v = auditRecommendation(auditCtx(h, noSell), sellRec, "unit", 1);
    expect(v.blocks.some((b) => b.condition === "plan_conflict" && b.detail.includes("do-not-sell"))).toBe(true);
    const capped: InvestmentPlan = { ...PLAN, constraints: { ...PLAN.constraints, max_order_value: "10000" } };
    const bigRec = await clearedRec(h, PLAN, 0); // BUY 30,000 of BND
    expect(
      auditRecommendation(auditCtx(h, capped), bigRec, "unit", 1).blocks.some((b) => b.condition === "plan_conflict" && b.detail.includes("max_order_value")),
    ).toBe(true);
  });

  test("2. wash sale: buying back within 30 days of a loss sale blocks", async () => {
    const h = seeded();
    await h.run(NIGHTLY, {});
    // A BND loss sale 10 days ago (basis 105/share, sold at 100).
    h.ledger.commit({
      batchId: "seed:washsale",
      writer: "cash_flow",
      facts: [
        {
          kind: "transaction",
          subject: "acct.broker.taxable",
          key: "sell-bnd-loss",
          payload: {
            account_id: "acct.broker.taxable",
            txn_id: "sell-bnd-loss",
            posted_at: "2026-08-14T00:00:00.000Z",
            amount: "1000",
            currency: "USD",
            type: "sell",
            description: "SOLD 10 BND",
            instrument: { symbol: "BND", asset_class: "bond" },
            quantity: "10",
            transfer_group: null,
            counterparty_account_id: null,
            raw_category: "Trade",
            swap_from: null,
          },
          observed_at: NOW,
          effective_at: "2026-08-14T00:00:00.000Z",
          source_id: "inst.broker",
          source_doc_id: null,
          supersedes: null,
          writer: "cash_flow",
          provisional: false,
        },
      ],
    });
    const rec = await clearedRec(h, PLAN, 0); // BUY BND
    const v = auditRecommendation(auditCtx(h, PLAN), rec, "unit", 1);
    expect(v.blocks.some((b) => b.condition === "wash_sale" && b.detail.includes("within 30 days"))).toBe(true);
  });

  test("4. tax cash: a buy that raids cash needed for an estimate inside the horizon blocks", async () => {
    const h = seeded();
    await h.run(NIGHTLY, {});
    // A 7,500 tax estimate due in three weeks; cash is 8,000 and the BUY wants 30,000.
    h.ledger.commit({
      batchId: "seed:obligation",
      writer: "liabilities",
      facts: [
        {
          kind: "obligation",
          subject: "household.tax.2026",
          key: "q3",
          payload: {
            account_id: "acct.broker.taxable",
            obligation_id: "tax.2026.q3",
            kind: "tax_estimate",
            description: "Q3 estimate",
            principal_outstanding: null,
            payment_amount: "7500",
            payment_due: "2026-09-15",
            rate: null,
            currency: "USD",
          },
          observed_at: NOW,
          effective_at: NOW,
          source_id: "tax.engine",
          source_doc_id: null,
          supersedes: null,
          writer: "liabilities",
          provisional: false,
        },
      ],
    });
    const rec = await clearedRec(h, PLAN, 0); // BUY 30,000 BND vs 8,000 cash
    const v = auditRecommendation(auditCtx(h, PLAN), rec, "unit", 1);
    const block = v.blocks.find((b) => b.condition === "tax_cash");
    expect(block).toBeDefined();
    expect(block!.detail).toContain("7500 due 2026-09-15");
  });
});
