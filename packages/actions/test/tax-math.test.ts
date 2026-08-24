// Unit tests for the deterministic tax arithmetic. Every expected value
// here is hand-computed; if one of these moves, a figure the operator
// saw changed meaning.

import { describe, expect, test } from "bun:test";

import { decimal, type TaxProfile, type TransactionPayload } from "@fin/contracts";

import {
  addYears,
  annualizedTax,
  ordinaryIncome,
  paymentsCumulative,
  quarterSpec,
  realizedGains,
  requiredCumulative,
  safeHarborCap,
  washSales,
  type DatedLot,
  type DatedTransaction,
} from "../src/tax/math";

const PROFILE: TaxProfile = {
  tax_year: 2026,
  ordinary_rate: "0.30",
  ltcg_rate: "0.15",
  prior_year_tax: "40000",
  prior_year_agi_over_150k: true,
  withholding_annual: "20000",
  reserve_account: "acct.bank.savings",
};

const txn = (over: Partial<TransactionPayload> & { txn_id: string; posted_at: string; amount: string; type: TransactionPayload["type"] }, subject = "acct.bank.checking", factId = `fact_${over.txn_id}`): DatedTransaction => ({
  factId,
  subject,
  payload: {
    account_id: subject,
    description: over.txn_id,
    currency: "USD",
    ...over,
  } as TransactionPayload,
});

describe("quarter calendar", () => {
  test("periods, dues, factors and shares follow the IRS estimated-tax structure", () => {
    expect(quarterSpec(2026, 1)).toMatchObject({ periodEnd: "2026-03-31", due: "2026-04-15", factor: "4", annualizedShare: "0.225", safeHarborShare: "0.25" });
    expect(quarterSpec(2026, 3)).toMatchObject({ periodEnd: "2026-08-31", due: "2026-09-15", factor: "1.5" });
    expect(quarterSpec(2026, 4)).toMatchObject({ periodEnd: "2026-12-31", due: "2027-01-15", factor: "1", annualizedShare: "0.9", safeHarborShare: "1" });
  });
  test("addYears is calendar-aware (leap day)", () => {
    expect(addYears("2024-02-29", 1)).toBe("2025-02-28");
    expect(addYears("2021-03-10", 1)).toBe("2022-03-10");
  });
});

describe("ordinary income", () => {
  test("income/dividend/interest and income-categorised credits count; transfers and spends do not", () => {
    const txns = [
      txn({ txn_id: "pay1", posted_at: "2026-02-01T00:00:00.000Z", amount: "6000", type: "credit", raw_category: "Income" }),
      txn({ txn_id: "div1", posted_at: "2026-03-01T00:00:00.000Z", amount: "150.25", type: "dividend" }),
      txn({ txn_id: "int1", posted_at: "2026-04-01T00:00:00.000Z", amount: "10", type: "interest" }),
      // excluded: a matched internal transfer typed income by the feed
      txn({ txn_id: "xfer", posted_at: "2026-03-05T00:00:00.000Z", amount: "5000", type: "income", transfer_group: "g1" }),
      // excluded: plain spending
      txn({ txn_id: "spend", posted_at: "2026-03-06T00:00:00.000Z", amount: "-84.12", type: "debit" }),
      // excluded: outside the period end
      txn({ txn_id: "late", posted_at: "2026-06-01T00:00:00.000Z", amount: "6000", type: "credit", raw_category: "Income" }),
      // excluded: prior year
      txn({ txn_id: "old", posted_at: "2025-12-31T00:00:00.000Z", amount: "6000", type: "income" }),
    ];
    const r = ordinaryIncome(txns, 2026, "2026-05-31");
    expect(r.total).toBe("6160.25");
    expect(r.factIds).toEqual(["fact_pay1", "fact_div1", "fact_int1"]);
  });
});

describe("realized gains, FIFO over lots", () => {
  const lots: DatedLot[] = [
    { factId: "fact_lotA", subject: "acct.broker.taxable", payload: { account_id: "acct.broker.taxable", lot_id: "A", instrument: { symbol: "VTI", asset_class: "etf" }, quantity: "80", acquired_at: "2021-03-10", cost_basis: "15200", basis_known: true, transferred_in: false, currency: "USD" } },
    { factId: "fact_lotB", subject: "acct.broker.taxable", payload: { account_id: "acct.broker.taxable", lot_id: "B", instrument: { symbol: "VTI", asset_class: "etf" }, quantity: "40", acquired_at: "2025-10-01", cost_basis: "9100", basis_known: true, transferred_in: false, currency: "USD" } },
  ];
  test("a sale spanning two lots splits long/short by holding period", () => {
    const sell = txn({ txn_id: "s1", posted_at: "2026-05-01T00:00:00.000Z", amount: "25000", type: "sell", instrument: { symbol: "VTI", asset_class: "etf" }, quantity: "100" }, "acct.broker.taxable");
    const r = realizedGains([sell], lots, 2026, "2026-08-31");
    // 80 sh from lot A: 80 x (250 - 190) = 4800 long-term (2021 -> 2026)
    // 20 sh from lot B: 20 x (250 - 227.50) = 450 short-term (held < 1y)
    expect(r.ltTotal).toBe("4800");
    expect(r.stTotal).toBe("450");
    expect(r.basisIncomplete).toBe(false);
    expect(r.sales[0]!.lotFactIds).toEqual(["fact_lotA", "fact_lotB"]);
  });
  test("a sale against an unknown-basis lot contributes NOTHING (never a zero basis)", () => {
    const badLots: DatedLot[] = [{ ...lots[0]!, payload: { ...lots[0]!.payload, cost_basis: null, basis_known: false } }];
    const sell = txn({ txn_id: "s2", posted_at: "2026-05-01T00:00:00.000Z", amount: "5000", type: "sell", instrument: { symbol: "VTI", asset_class: "etf" }, quantity: "20" }, "acct.broker.taxable");
    const r = realizedGains([sell], badLots, 2026, "2026-08-31");
    expect(r.basisIncomplete).toBe(true);
    expect(r.stTotal).toBe("0");
    expect(r.ltTotal).toBe("0");
    expect(r.sales[0]!.stGain).toBeNull();
  });
  test("selling more than the lots cover is incomplete, not invented", () => {
    const sell = txn({ txn_id: "s3", posted_at: "2026-05-01T00:00:00.000Z", amount: "50000", type: "sell", instrument: { symbol: "VTI", asset_class: "etf" }, quantity: "200" }, "acct.broker.taxable");
    const r = realizedGains([sell], lots, 2026, "2026-08-31");
    expect(r.basisIncomplete).toBe(true);
  });
});

describe("wash-sale watch", () => {
  test("a loss sale with a partial repurchase 15 days later is flagged with a proportional disallowance", () => {
    const lots: DatedLot[] = [{ factId: "fact_l", subject: "acct.broker.taxable", payload: { account_id: "acct.broker.taxable", lot_id: "L", instrument: { symbol: "SNAP", asset_class: "equity" }, quantity: "100", acquired_at: "2024-01-10", cost_basis: "20000", basis_known: true, transferred_in: false, currency: "USD" } }];
    const sell = txn({ txn_id: "loss1", posted_at: "2026-03-10T00:00:00.000Z", amount: "7500", type: "sell", instrument: { symbol: "SNAP", asset_class: "equity" }, quantity: "50" }, "acct.broker.taxable");
    const buy = txn({ txn_id: "rebuy", posted_at: "2026-03-25T00:00:00.000Z", amount: "-4500", type: "buy", instrument: { symbol: "SNAP", asset_class: "equity" }, quantity: "30" }, "acct.broker.taxable");
    const gains = realizedGains([sell, buy], lots, 2026, "2026-08-31");
    // 50 sh: proceeds 150/sh vs basis 200/sh -> loss -2500 (long-term)
    expect(gains.ltTotal).toBe("-2500");
    const w = washSales([sell, buy], gains.sales);
    expect(w).toHaveLength(1);
    expect(w[0]!.loss).toBe("-2500.00");
    expect(w[0]!.disallowed_estimate).toBe("-1500.00"); // 30/50 of the loss
    expect(w[0]!.repurchase_txn_id).toBe("rebuy");
  });
  test("a repurchase outside the 30-day window is not a wash sale", () => {
    const lots: DatedLot[] = [{ factId: "fact_l", subject: "acct.broker.taxable", payload: { account_id: "acct.broker.taxable", lot_id: "L", instrument: { symbol: "SNAP", asset_class: "equity" }, quantity: "100", acquired_at: "2024-01-10", cost_basis: "20000", basis_known: true, transferred_in: false, currency: "USD" } }];
    const sell = txn({ txn_id: "loss2", posted_at: "2026-03-10T00:00:00.000Z", amount: "7500", type: "sell", instrument: { symbol: "SNAP", asset_class: "equity" }, quantity: "50" }, "acct.broker.taxable");
    const buy = txn({ txn_id: "rebuy2", posted_at: "2026-04-30T00:00:00.000Z", amount: "-4500", type: "buy", instrument: { symbol: "SNAP", asset_class: "equity" }, quantity: "30" }, "acct.broker.taxable");
    const gains = realizedGains([sell, buy], lots, 2026, "2026-08-31");
    expect(washSales([sell, buy], gains.sales)).toEqual([]);
  });
});

describe("annualized estimate and safe harbour", () => {
  test("Q3: min(annualized share, safe-harbour share) picks the smaller leg", () => {
    const q3 = quarterSpec(2026, 3);
    // 80,000 ordinary + 10,000 LT through Aug 31, factor 1.5:
    // annualized tax = 120,000 x 0.30 + 15,000 x 0.15 = 38,250
    const at = annualizedTax(PROFILE, "80000", "0", "10000", q3.factor);
    expect(at).toBe("38250.00");
    const cap = safeHarborCap(PROFILE);
    expect(cap).toBe("44000.00"); // 110% of 40,000
    // required cum = min(0.675 x 38,250 = 25,818.75 ; 0.75 x 44,000 = 33,000)
    expect(requiredCumulative(q3, at, cap)).toBe("25818.75");
  });
  test("net capital losses do not reduce the estimate (conservative-high)", () => {
    expect(annualizedTax(PROFILE, "100000", "-5000", "-10000", "1")).toBe("30000.00");
  });
  test("payments = even withholding share + estimated payments posted by the due date", () => {
    const q3 = quarterSpec(2026, 3);
    const txns = [
      txn({ txn_id: "est1", posted_at: "2026-04-10T00:00:00.000Z", amount: "-3000", type: "tax" }),
      txn({ txn_id: "est2", posted_at: "2026-09-15T00:00:00.000Z", amount: "-2000", type: "tax" }),
      // after the Q3 due date: not credited yet
      txn({ txn_id: "est3", posted_at: "2026-09-16T00:00:00.000Z", amount: "-2000", type: "tax" }),
      // a refund (money in) is not a payment
      txn({ txn_id: "refund", posted_at: "2026-05-01T00:00:00.000Z", amount: "800", type: "tax" }),
    ];
    const r = paymentsCumulative(PROFILE, txns, q3, 2026);
    // 20,000 x 0.75 + 3,000 + 2,000
    expect(r.total).toBe("20000.00");
    expect(r.factIds).toEqual(["fact_est1", "fact_est2"]);
  });
});

describe("decimal.div", () => {
  test("truncates toward zero at scale and refuses zero divisors", () => {
    expect(decimal.div("1", "3")).toBe("0.3333333333");
    expect(decimal.div("-1", "3")).toBe("-0.3333333333");
    expect(decimal.div("25000", "100")).toBe("250");
    expect(() => decimal.div("1", "0")).toThrow();
  });
});
