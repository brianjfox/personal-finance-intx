// The Ledger Analyst's views (D-044): filtered transaction lines with
// totals, grouped summaries, and deterministic recurring-charge
// detection. Figures are decimal-string arithmetic over facts; every
// row and bucket carries the fact ids it rests on.

import { describe, expect, test } from "bun:test";

import type { FactInput } from "@fin/contracts";
import { openLedger, views } from "../src/index";

const T1 = "2026-03-02T00:00:00.000Z";

function acct(id: string, name: string): FactInput {
  return {
    kind: "account",
    subject: id,
    key: "account",
    payload: { account_id: id, institution_id: "inst.demo", name, type: "checking", currency: "USD", masked_number: "****1234" },
    observed_at: T1,
    effective_at: T1,
    source_id: "inst.demo",
    source_doc_id: null,
    supersedes: null,
    writer: "assets_manager",
    provisional: false,
  };
}

function txn(id: string, amount: string, posted: string, description: string, extra: Record<string, unknown> = {}, subject = "acct.demo.checking"): FactInput {
  return {
    kind: "transaction",
    subject,
    key: `txn:${id}`,
    payload: { account_id: subject, txn_id: id, posted_at: posted, amount, currency: "USD", type: amount.startsWith("-") ? "debit" : "credit", description, ...extra },
    observed_at: T1,
    effective_at: posted,
    source_id: "inst.demo",
    source_doc_id: null,
    supersedes: null,
    writer: "cash_flow",
    provisional: false,
  };
}

const day = (m: number, d: number, y = 2026): string => `${String(y)}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}T12:00:00.000Z`;

function seeded() {
  const l = openLedger(":memory:");
  l.commit({ batchId: "a", writer: "assets_manager", facts: [acct("acct.demo.checking", "Checking"), acct("acct.demo.card", "Visa")] });
  l.commit({
    batchId: "t",
    writer: "cash_flow",
    facts: [
      // payroll, biweekly-ish? no: monthly on the 15th, four months
      txn("p1", "8000", day(1, 15), "ACME PAYROLL 0001", { type: "income", raw_category: "Income" }),
      txn("p2", "8000", day(2, 15), "ACME PAYROLL 0002", { type: "income", raw_category: "Income" }),
      txn("p3", "8000", day(3, 15), "ACME PAYROLL 0003", { type: "income", raw_category: "Income" }),
      txn("p4", "8000", day(4, 15), "ACME PAYROLL 0004", { type: "income", raw_category: "Income" }),
      // a streaming subscription on the card, monthly, price rose once
      txn("n1", "-15.49", day(1, 3), "NETFLIX.COM 8831", { raw_category: "Entertainment" }, "acct.demo.card"),
      txn("n2", "-15.49", day(2, 3), "NETFLIX.COM 8832", { raw_category: "Entertainment" }, "acct.demo.card"),
      txn("n3", "-17.99", day(3, 3), "NETFLIX.COM 8833", { raw_category: "Entertainment" }, "acct.demo.card"),
      txn("n4", "-17.99", day(4, 3), "NETFLIX.COM 8834", { raw_category: "Entertainment" }, "acct.demo.card"),
      // groceries: frequent, irregular amounts and gaps -- not recurring
      txn("g1", "-120.10", day(1, 4), "WHOLE FOODS", { raw_category: "Groceries" }, "acct.demo.card"),
      txn("g2", "-84.00", day(1, 19), "WHOLE FOODS", { raw_category: "Groceries" }, "acct.demo.card"),
      txn("g3", "-230.75", day(2, 2), "WHOLE FOODS", { raw_category: "Groceries" }, "acct.demo.card"),
      txn("g4", "-61.30", day(2, 27), "WHOLE FOODS", { raw_category: "Groceries" }, "acct.demo.card"),
      // internal: card payment legs, and a buy inside the account
      txn("x1", "-500", day(2, 20), "PAYMENT TO VISA", { type: "transfer_out", transfer_group: "grp1" }),
      txn("x2", "500", day(2, 20), "PAYMENT FROM CHECKING", { type: "transfer_in", transfer_group: "grp1" }, "acct.demo.card"),
      txn("b1", "-1000", day(3, 10), "BUY VTI", { type: "buy" }),
      // voided by a merge: history, not activity
      txn("v1", "-9999", day(3, 11), "GHOST", { voided: true }),
    ],
  });
  return l;
}

describe("transactionRows", () => {
  test("filters, pages newest-first, totals over the whole match, names accounts, drops internal and voided", () => {
    const l = seeded();
    const all = views.transactionRows(l);
    expect(all.matched).toBe(12); // 4 payroll + 4 netflix + 4 groceries
    expect(all.excluded_internal).toBe(3);
    expect(all.rows[0]!.description).toBe("ACME PAYROLL 0004");
    expect(all.rows.some((r) => r.description === "GHOST")).toBe(false);
    expect(all.rows.every((r) => !("masked_number" in r))).toBe(true);
    expect(all.rows.find((r) => r.subject === "acct.demo.card")!.account).toBe("Visa");
    expect(all.totals_by_currency["USD"]).toEqual({ count: 12, inflow: "32000", outflow: "563.11", net: "31436.89" });

    const page = views.transactionRows(l, { limit: 5, offset: 5 });
    expect(page.rows).toHaveLength(5);
    expect(page.truncated).toBe(true);
    expect(page.matched).toBe(12);

    const feb = views.transactionRows(l, { from: "2026-02-01", to: "2026-02-28", description_contains: "whole" });
    expect(feb.rows.map((r) => r.amount)).toEqual(["-61.30", "-230.75"]); // amounts verbatim from the fact
    expect(feb.totals_by_currency["USD"]!.outflow).toBe("292.05");

    const big = views.transactionRows(l, { min_abs_amount: "1000", include_internal: true });
    expect(big.rows.map((r) => r.description).sort()).toEqual(["ACME PAYROLL 0001", "ACME PAYROLL 0002", "ACME PAYROLL 0003", "ACME PAYROLL 0004", "BUY VTI"]);
    expect(big.rows.find((r) => r.description === "BUY VTI")!.internal).toBe(true);

    const cat = views.transactionRows(l, { description_contains: "groceries" });
    expect(cat.matched).toBe(4);
    const typed = views.transactionRows(l, { types: ["income"], subject: "acct.demo.checking" });
    expect(typed.matched).toBe(4);
  });
});

describe("transactionSummary", () => {
  test("buckets by month, category, merchant, account, and type; largest outflow first; fact ids attached", () => {
    const l = seeded();
    const byMonth = views.transactionSummary(l, { group_by: "month" });
    expect(byMonth.buckets.map((b) => b.key)).toEqual(["2026-02", "2026-01", "2026-03", "2026-04"]);
    const feb = byMonth.buckets[0]!;
    expect(feb).toMatchObject({ currency: "USD", count: 4, inflow: "8000", outflow: "307.54", net: "7692.46" });
    expect(feb.fact_ids).toHaveLength(4);

    const byCat = views.transactionSummary(l, { group_by: "category", from: "2026-01-01", to: "2026-02-28" });
    expect(byCat.buckets.map((b) => [b.key, b.outflow])).toEqual([
      ["Groceries", "496.15"],
      ["Entertainment", "30.98"],
      ["Income", "0"],
    ]);

    const byMerchant = views.transactionSummary(l, { group_by: "description" });
    expect(byMerchant.buckets[0]!.key).toBe("whole foods");
    expect(byMerchant.buckets[1]).toMatchObject({ key: "netflix com", count: 4, outflow: "66.96" });

    const byAccount = views.transactionSummary(l, { group_by: "account" });
    expect(byAccount.buckets.map((b) => b.label)).toEqual(["Visa", "Checking"]);

    const byType = views.transactionSummary(l, { group_by: "type", include_internal: true });
    expect(byType.buckets.find((b) => b.key === "buy")).toMatchObject({ outflow: "1000" });
    expect(byType.excluded_internal).toBe(3);
  });
});

describe("recurringCharges", () => {
  test("finds monthly payroll and the subscription (through a price change); groceries are not recurring", () => {
    const l = seeded();
    const v = views.recurringCharges(l);
    expect(v.considered).toBe(12);
    expect(v.charges.map((c) => [c.normalized, c.direction, c.cadence, c.occurrences])).toEqual([
      ["acme payroll", "inflow", "monthly", 4],
      ["netflix com", "outflow", "monthly", 4],
    ]);
    const pay = v.charges[0]!;
    expect(pay).toMatchObject({ typical_amount: "8000", latest_amount: "8000", monthly_equivalent: "8000.00", currency: "USD", accounts: ["Checking"], interval_days: 31 });
    expect(pay.first_at).toBe(day(1, 15));
    expect(pay.last_at).toBe(day(4, 15));
    expect(pay.next_expected).toBe("2026-05-15");
    expect(pay.fact_ids).toHaveLength(4);
    const nf = v.charges[1]!;
    // median of [15.49, 15.49, 17.99, 17.99] is the lower middle; latest is the new price
    expect(nf).toMatchObject({ typical_amount: "15.49", latest_amount: "17.99", description: "NETFLIX.COM 8834", accounts: ["Visa"] });
    expect(v.monthly_equivalent_by_currency).toEqual({ USD: { inflow: "8000.00", outflow: "15.49" } });
  });

  test("cadence bands: weekly and quarterly are recognised; an irregular series is not; too few occurrences are not", () => {
    const l = openLedger(":memory:");
    const facts: FactInput[] = [];
    for (let i = 0; i < 6; i++) facts.push(txn(`w${String(i)}`, "-12", new Date(Date.UTC(2026, 0, 5) + i * 7 * 86_400_000).toISOString(), "GYM WEEKLY"));
    for (const [i, d] of ["2025-01-10", "2025-04-10", "2025-07-11", "2025-10-09"].entries()) facts.push(txn(`q${String(i)}`, "-300", `${d}T00:00:00.000Z`, "INSURANCE QTR"));
    for (const [i, d] of ["2026-01-01", "2026-01-09", "2026-02-20", "2026-02-22"].entries()) facts.push(txn(`r${String(i)}`, "-50", `${d}T00:00:00.000Z`, "RANDOM SHOP"));
    for (const [i, d] of ["2026-01-01", "2026-02-01"].entries()) facts.push(txn(`f${String(i)}`, "-9", `${d}T00:00:00.000Z`, "TWO ONLY"));
    l.commit({ batchId: "c", writer: "cash_flow", facts });
    const v = views.recurringCharges(l);
    expect(v.charges.map((c) => [c.normalized, c.cadence, c.monthly_equivalent])).toEqual([
      ["insurance qtr", "quarterly", "100.00"],
      ["gym weekly", "weekly", "52.00"],
    ]);
    // Lowering the bar admits the two-occurrence series.
    const loose = views.recurringCharges(l, { min_occurrences: 2 });
    expect(loose.charges.some((c) => c.normalized === "two only" && c.cadence === "monthly")).toBe(true);
  });
});

describe("finding summary_parts (migration 4)", () => {
  test("round-trips through append and read; absent when not supplied", () => {
    const l = openLedger(":memory:");
    const base = {
      kind: "mismatch" as const,
      code: "position_balance_mismatch" as const,
      severity: "medium" as const,
      subject: "acct.demo.checking",
      summary: "sum to 1 USD",
      detail: {},
      evidence: [],
      before: [],
      after: [],
      requires_human: true,
      emitted_by: "reconciliation" as const,
      as_of: T1,
      provenance: { source_id: "reconcile", source_doc_id: null, observed_at: T1, via: "test@1" },
    };
    const withParts = l.appendFinding({ ...base, summary_parts: ["sum to ", { amount: "1", currency: "USD" }] });
    const plain = l.appendFinding(base);
    expect(l.getFinding(withParts)?.summary_parts).toEqual(["sum to ", { amount: "1", currency: "USD" }]);
    expect(l.getFinding(plain)).not.toHaveProperty("summary_parts");
    expect(l.openFindings({ requiresHuman: true }).map((f) => f.summary_parts !== undefined)).toEqual([false, true]);
  });
});
