// Phase 2 acceptance (BUILD_PLAN §6): "a simulated Q3 with a mid-year
// income change produces a corrected estimate and funds it from reserve
// without a forced sale." Run under runLocal with the real handlers, the
// real ledger and the real policy.
//
// The simulated year (all figures hand-computed; the math unit tests
// carry the per-function derivations):
//   - payroll 8,000/mo Jan-Jun, then a mid-year change to 14,000/mo
//   - estimated payments 2,200 on Apr 10 and Jun 10; withholding 12,000/yr
//   - VTI sale May 1: +4,800 LT, +450 ST (FIFO over two lots)
//   - SNAP loss sale Mar 10 (-2,500 LT) repurchased Mar 25 -> wash sale
//   - profile: 30% ordinary, 15% LTCG, prior-year tax 26,000 (cap 28,600)
//
//   Q3 pre-stage (checked Aug 10, before the Aug payroll posts):
//     installment 5,918.50 vs reserve 2,500 -> shortfall, escalate
//   Q3 due (checked Sep 15, Aug payroll posted, reserve funded to 8,500):
//     corrected installment 8,050.00, covered -> "funded from reserve"

import { describe, expect, test } from "bun:test";

import { decimal, type SnapshotAccount, type TaxProfile } from "@fin/contracts";
import { fixtureAdapter } from "@fin/institutions";
import { views } from "@fin/ledger";

import type { QuarterEstimate } from "@fin/contracts";
import {
  buildTaxYearWorkflow,
  deadlineSignal,
  nightlyWorkflow,
  skipSignalId,
  stepOutcomes,
  TAX_CHECK_ID,
  workflowById,
} from "../src/index";
import { harness, type Harness } from "./harness";

const NIGHTLY = workflowById(nightlyWorkflow.id);
const TAXCHECK = workflowById(TAX_CHECK_ID);

const PROFILE: TaxProfile = {
  tax_year: 2026,
  ordinary_rate: "0.30",
  ltcg_rate: "0.15",
  prior_year_tax: "26000",
  prior_year_agi_over_150k: true,
  withholding_annual: "12000",
  reserve_account: "acct.bank.savings",
};

function bankAccounts(night: 1 | 2, asOfOverride?: string): SnapshotAccount[] {
  const asOf = asOfOverride ?? (night === 1 ? "2026-08-09T00:00:00.000Z" : "2026-09-14T00:00:00.000Z");
  const payroll = (id: string, date: string, amount: string) => ({
    txn_id: id,
    posted_at: `${date}T00:00:00.000Z`,
    amount,
    type: "credit" as const,
    description: "PAYROLL ACME CORP",
    raw_category: "Income",
  });
  const transactions = [
    payroll("pay-01", "2026-01-15", "8000"),
    payroll("pay-02", "2026-02-15", "8000"),
    payroll("pay-03", "2026-03-15", "8000"),
    payroll("pay-04", "2026-04-15", "8000"),
    payroll("pay-05", "2026-05-15", "8000"),
    payroll("pay-06", "2026-06-15", "8000"),
    payroll("pay-07", "2026-07-15", "14000"),
    { txn_id: "est-q1", posted_at: "2026-04-10T00:00:00.000Z", amount: "-2200", type: "tax" as const, description: "IRS ES PAYMENT" },
    { txn_id: "est-q2", posted_at: "2026-06-10T00:00:00.000Z", amount: "-2200", type: "tax" as const, description: "IRS ES PAYMENT" },
  ];
  if (night === 2) transactions.push(payroll("pay-08", "2026-08-15", "14000"));
  return [
    {
      account_id: "acct.bank.checking",
      name: "Checking",
      type: "checking",
      currency: "USD",
      as_of: asOf,
      balances: [{ balance_type: "total", amount: night === 1 ? "9000" : "23000" }],
      transactions,
    },
    {
      account_id: "acct.bank.savings",
      name: "Tax Reserve Savings",
      type: "savings",
      currency: "USD",
      as_of: asOf,
      // The operator funds the reserve between the pre-stage check and the deadline.
      balances: [{ balance_type: "total", amount: night === 1 ? "2500" : "8500" }],
      transactions: [],
    },
  ];
}

function brokerAccounts(night: 1 | 2, asOfOverride?: string): SnapshotAccount[] {
  const asOf = asOfOverride ?? (night === 1 ? "2026-08-09T00:00:00.000Z" : "2026-09-14T00:00:00.000Z");
  return [
    {
      account_id: "acct.broker.taxable",
      name: "Taxable Brokerage",
      type: "brokerage",
      currency: "USD",
      as_of: asOf,
      balances: [{ balance_type: "total", amount: "37000" }, { balance_type: "cash", amount: "20000" }],
      positions: [
        {
          instrument: { symbol: "VTI", asset_class: "etf" },
          quantity: "20",
          price: "250",
          market_value: "5000",
          cost_basis: "3800",
          // Tax-lot history including the shares sold this year (the
          // engine matches sales FIFO against these; see D-016).
          lots: [
            { lot_id: "vti-a", quantity: "80", acquired_at: "2021-03-10", cost_basis: "15200" },
            { lot_id: "vti-b", quantity: "40", acquired_at: "2025-10-01", cost_basis: "9100" },
          ],
        },
        {
          instrument: { symbol: "SNAP", asset_class: "equity" },
          quantity: "80",
          price: "150",
          market_value: "12000",
          cost_basis: "16000",
          lots: [{ lot_id: "snap-l", quantity: "100", acquired_at: "2024-01-10", cost_basis: "20000" }],
        },
      ],
      transactions: [
        { txn_id: "sell-vti", posted_at: "2026-05-01T00:00:00.000Z", amount: "25000", type: "sell", description: "SOLD 100 VTI", instrument: { symbol: "VTI", asset_class: "etf" }, quantity: "100" },
        { txn_id: "sell-snap", posted_at: "2026-03-10T00:00:00.000Z", amount: "7500", type: "sell", description: "SOLD 50 SNAP", instrument: { symbol: "SNAP", asset_class: "equity" }, quantity: "50" },
        { txn_id: "buy-snap", posted_at: "2026-03-25T00:00:00.000Z", amount: "-4500", type: "buy", description: "BOUGHT 30 SNAP", instrument: { symbol: "SNAP", asset_class: "equity" }, quantity: "30" },
      ],
    },
  ];
}

function seedNight(h: Harness, night: 1 | 2, asOf?: string): void {
  h.setAdapters([
    fixtureAdapter("inst.bank", { accounts: bankAccounts(night, asOf) }),
    fixtureAdapter("inst.broker", { accounts: brokerAccounts(night, asOf) }),
  ]);
}

const est = (r: { outputs: Record<string, unknown> }, step = "est_check"): QuarterEstimate => r.outputs[step] as QuarterEstimate;

describe("phase 2 acceptance: a simulated Q3 with a mid-year income change", () => {
  test("pre-stage flags the shortfall; the deadline check corrects the estimate and funds it from reserve", async () => {
    const h = harness();
    h.setTaxProfile(PROFILE);
    seedNight(h, 1);
    const n1 = await h.run(NIGHTLY, {}, { now: "2026-08-09T06:00:00.000Z" });
    expect(n1.terminalStatus).toBe("completed");
    expect((n1.outputs["gate"] as { branch: string }).branch).toBe("notify");

    // --- Q3 pre-stage, 30+ days out: park the estimate before the deadline.
    const pre = await h.run(TAXCHECK, { tax_year: 2026, quarter: 3, stage: "pre" }, { now: "2026-08-10T06:00:00.000Z" });
    expect(pre.terminalStatus).toBe("completed");
    const preEst = est(pre);
    expect(preEst.figures?.ordinary_income).toBe("62000.00"); // Aug payroll not yet posted
    expect(preEst.figures?.st_gains).toBe("450.00");
    expect(preEst.figures?.lt_gains).toBe("2300.00"); // +4,800 VTI - 2,500 SNAP
    expect(preEst.figures?.installment_due).toBe("5918.50");
    expect(preEst.reserve_ok).toBe(false);
    expect(preEst.reserve?.shortfall).toBe("3418.50");
    // The refusal is a branch: coverage gate escalated, confirm skipped.
    const preSteps = stepOutcomes(pre.events);
    expect(preSteps["esc_check"]).toEqual({ status: "completed" });
    expect(preSteps["ok_check"]?.status).toBe("skipped");
    // The obligation is parked in the ledger.
    const ob1 = views.obligations(h.ledger).find((o) => o.key === "q3");
    expect(ob1?.amount).toBe("5918.50");
    expect(ob1?.due).toBe("2026-09-15");
    // Queue: reserve shortfall + the two past-quarter safe-harbour misses.
    const queued = h.ledger.openFindings({ requiresHuman: true }).map((f) => f.code).sort();
    expect(queued).toEqual(["reserve_shortfall", "safe_harbor_shortfall", "safe_harbor_shortfall"]);
    // The wash sale is on record (informational, not a queue item).
    const wash = h.ledger.allFindings().find((f) => f.code === "wash_sale_risk");
    expect(wash?.detail["sale_txn_id"]).toBe("sell-snap");
    expect(wash?.detail["disallowed_estimate"]).toBe("-1500.00");
    expect(preEst.wash_sales).toHaveLength(1);

    // --- The operator funds the reserve; the Aug payroll lands (mid-year change).
    seedNight(h, 2);
    const n2 = await h.run(NIGHTLY, {}, { now: "2026-09-14T06:00:00.000Z" });
    expect(n2.terminalStatus).toBe("completed");
    expect((n2.outputs["gate"] as { branch: string }).branch).toBe("notify");

    // --- Q3 due: corrected estimate, funded from reserve, no forced sale.
    const due = await h.run(TAXCHECK, { tax_year: 2026, quarter: 3, stage: "due" }, { now: "2026-09-15T06:00:00.000Z" });
    expect(due.terminalStatus).toBe("completed");
    const dueEst = est(due);
    expect(dueEst.figures?.ordinary_income).toBe("76000.00");
    expect(dueEst.figures?.installment_due).toBe("8050.00"); // corrected upward
    expect(dueEst.reserve_ok).toBe(true);
    const dueSteps = stepOutcomes(due.events);
    expect(dueSteps["ok_check"]).toEqual({ status: "completed" });
    expect(dueSteps["esc_check"]?.status).toBe("skipped"); // no escalation, no sale
    // The obligation was superseded, not overwritten.
    const ob2 = views.obligations(h.ledger).find((o) => o.key === "q3");
    expect(ob2?.amount).toBe("8050.00");
    expect(ob2?.supersedes).toBe(ob1!.fact_id);
    expect(h.ledger.history(ob2!.fact_id).map((f) => (f.payload as { payment_amount: string }).payment_amount)).toEqual(["5918.50", "8050.00"]);
    // Bitemporal: what did we believe on Aug 11? The pre-stage figure.
    const asOfAug11 = h.ledger.asOf({ kind: "obligation", subject: "household.tax.2026", key: "q3", observedAt: "2026-08-11T00:00:00.000Z" });
    expect((asOfAug11[0]?.payload as { payment_amount: string }).payment_amount).toBe("5918.50");
    // The deadline item is queued, marked covered by reserve.
    const dueFinding = h.ledger.openFindings({ requiresHuman: true }).find((f) => f.code === "estimated_tax_due");
    expect(dueFinding?.detail["amount"]).toBe("8050.00");
    expect(dueFinding?.detail["covered"]).toBe(true);
    // The journal narrates the funding; nothing anywhere proposes a sale.
    const journal = h.ledger.listJournal().map((j) => j.summary).join("\n");
    expect(journal).toContain("covered by reserve");
    expect(journal).toContain("pay it from reserve; no sale required");

    // --- Idempotency: re-running the same check changes nothing.
    const again = await h.run(TAXCHECK, { tax_year: 2026, quarter: 3, stage: "due" }, { now: "2026-09-15T06:30:00.000Z" });
    expect(again.terminalStatus).toBe("completed");
    expect((again.outputs["obl_check"] as { changed: boolean; reason?: string }).changed).toBe(false);
    expect(h.ledger.history(ob2!.fact_id)).toHaveLength(2);
    expect(h.ledger.openFindings({ requiresHuman: true }).filter((f) => f.code === "estimated_tax_due")).toHaveLength(1);
    expect((again.outputs["rec_check"] as { suppressed: number }).suppressed).toBeGreaterThan(0);

    // Every effect ran under the right principal, none denied.
    expect(h.decisions.some((d) => d.effect === "deny")).toBe(false);
    expect(h.decisions.find((d) => d.stepId === "obl_check")?.principal).toBe("liabilities");
    expect(h.decisions.find((d) => d.stepId === "est_check")?.principal).toBe("tax_engine");
  });

  test("the estimate refuses to run over provisional data: blocked, escalated, no obligation", async () => {
    const h = harness();
    h.setTaxProfile(PROFILE);
    // Night 1 books a transfer; night 2 books it twice -> checking is held.
    const xfer = { txn_id: "w-1", posted_at: "2026-08-22T00:00:00.000Z", amount: "-2000", type: "debit" as const, description: "TRANSFER TO BROKERAGE" };
    const bank = (tx: (typeof xfer)[]): SnapshotAccount[] => [
      { account_id: "acct.bank.checking", name: "Checking", type: "checking", currency: "USD", as_of: "2026-08-23T00:00:00.000Z", balances: [{ balance_type: "total", amount: "5000" }], transactions: tx },
      { account_id: "acct.bank.savings", name: "Savings", type: "savings", currency: "USD", as_of: "2026-08-23T00:00:00.000Z", balances: [{ balance_type: "total", amount: "9000" }], transactions: [] },
    ];
    h.setAdapters([fixtureAdapter("inst.bank", { accounts: bank([xfer]) })]);
    await h.run(NIGHTLY, {}, { now: "2026-08-23T06:00:00.000Z" });
    h.setAdapters([fixtureAdapter("inst.bank", { accounts: bank([xfer, { ...xfer, txn_id: "w-1-again" }]) })]);
    const n2 = await h.run(NIGHTLY, {}, { now: "2026-08-24T06:00:00.000Z" });
    expect((n2.outputs["gate"] as { branch: string }).branch).toBe("hold");
    expect(h.ledger.isProvisional("acct.bank.checking")).toBe(true);

    const r = await h.run(TAXCHECK, { tax_year: 2026, quarter: 3, stage: "pre" }, { now: "2026-08-25T06:00:00.000Z" });
    expect(r.terminalStatus).toBe("completed");
    const e = est(r);
    expect(e.blocked).toEqual(["acct.bank.checking"]);
    expect(e.figures).toBeNull();
    expect(e.reserve_ok).toBe(false);
    expect(stepOutcomes(r.events)["esc_check"]).toEqual({ status: "completed" });
    expect((r.outputs["obl_check"] as { reason: string }).reason).toBe("blocked");
    expect(views.obligations(h.ledger)).toEqual([]);
    const blockedFinding = h.ledger.openFindings({ requiresHuman: true }).find((f) => f.code === "tax_estimate_blocked");
    expect(blockedFinding?.detail["blocked"]).toEqual(["acct.bank.checking"]);
  });

  test("the standing tax-year run: past deadlines catch up in one launch, future gates park, skips journal once", async () => {
    const h = harness();
    h.setTaxProfile(PROFILE);
    seedNight(h, 2, "2026-09-20T00:00:00.000Z");
    await h.run(NIGHTLY, {}, { now: "2026-09-20T06:00:00.000Z" });

    // Build for Sep 20: q1-q3 gates (pre and due) are past -> timeout 0,
    // fire at launch; q4 gates are pinned a few days out (inside the
    // setTimeout clamp -- runLocal's scheduler does not chunk; fin-host's
    // does) and are skipped by signal.
    const built = buildTaxYearWorkflow({
      taxYear: 2026,
      now: new Date("2026-09-20T06:00:00.000Z"),
      fireAt: { q4: "2026-09-27T06:00:00.000Z", q4_pre: "2026-09-26T06:00:00.000Z" },
      catchupStaggerMs: 100,
    });
    expect(built.definition.id).toBe("tax-year-2026");
    expect(built.deadlines).toHaveLength(8);

    const run = h.start({ definition: built.definition, stepPrincipals: built.stepPrincipals }, { tax_year: 2026 }, { runId: "taxyear-local" });
    // The operator skips Q4 (handled elsewhere); the duplicate delivery is
    // deduped by signalId -- a double-click cannot double-journal.
    await run.signal(deadlineSignal(4, "pre"), { note: "handled offline", decided_by: "test" }, skipSignalId(2026, 4, "pre"));
    await run.signal(deadlineSignal(4, "pre"), { note: "handled offline", decided_by: "test" }, skipSignalId(2026, 4, "pre"));
    await run.signal(deadlineSignal(4, "due"), { note: "paid manually", decided_by: "test" }, skipSignalId(2026, 4, "due"));
    const r = await run.complete;
    expect(r.terminalStatus).toBe("completed");

    const steps = stepOutcomes(r.events);
    // Catch-up: all six past gates fired their check chains.
    for (const sfx of ["q1_pre", "q1_due", "q2_pre", "q2_due", "q3_pre", "q3_due"]) {
      expect(steps[`est_${sfx}`]?.status).toBe("completed");
      expect(steps[`skip_${sfx}`]?.status).toBe("skipped");
    }
    // Q4: skipped by signal; the check chain never ran.
    for (const sfx of ["q4_pre", "q4_due"]) {
      expect(steps[`skip_${sfx}`]?.status).toBe("completed");
      expect(steps[`est_${sfx}`]?.status).toBe("skipped");
    }
    // One obligation per quarter with something due -- the pre and due
    // chains agreed, so the second write was an idempotent no-op.
    const obs = views.obligations(h.ledger).sort((a, b) => a.key.localeCompare(b.key));
    expect(obs.map((o) => [o.key, o.amount])).toEqual([
      ["q1", "1280.00"],
      ["q2", "3078.40"],
      ["q3", "8050.00"],
    ]);
    for (const o of obs) expect(h.ledger.history(o.fact_id)).toHaveLength(1);
    // Reserve (8,500) covers Q3 (8,050): funded from reserve, no sale.
    expect(decimal.cmp("8500", obs[2]!.amount as string)).toBeGreaterThanOrEqual(0);
    // The two skips journaled exactly once each (the duplicate delivery
    // was deduped by signalId before the handler ever ran).
    const skips = h.ledger.listJournal().filter((j) => j.summary.includes("deadline check skipped"));
    expect(skips).toHaveLength(2);
  });
});
