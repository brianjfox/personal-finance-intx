// Deterministic tax arithmetic (deck slide 7: "Arithmetic never happens
// in a language model"). Pure functions over ledger fact payloads --
// no clock, no ledger handle, no effects -- so the Auditor can re-run
// every figure from the cited facts alone.
//
// Model (an estimator, not advice -- rates come from the operator's
// TaxProfile):
//   - Quarter periods and dues follow the IRS estimated-tax calendar.
//   - Required cumulative payment through quarter q =
//       min( annualized_share[q] x tax(annualized income through period q),
//            safe_harbor_share[q] x {110%|100%} x prior-year tax )
//     -- the annualized-income installment method against the prior-year
//     safe harbour, per Form 2210's structure.
//   - Withholding counts as paid evenly across quarters; estimated
//     payments count by their posted date.
//   - Net capital losses are NOT offset against income (the estimate
//     stays conservative-high; the accountant trues it up).

import {
  decimal,
  type Decimal,
  type IsoDate,
  type LotPayload,
  type TaxProfile,
  type TransactionPayload,
  type WashSale,
} from "@fin/contracts";

export interface QuarterSpec {
  quarter: 1 | 2 | 3 | 4;
  /** Last day of the income period (income through here is annualized). */
  periodEnd: IsoDate;
  /** The payment deadline. */
  due: IsoDate;
  /** 12 / months in period. */
  factor: Decimal;
  /** Cumulative share of annualized tax required by this installment. */
  annualizedShare: Decimal;
  /** Cumulative share of the safe-harbour cap required by this installment. */
  safeHarborShare: Decimal;
}

export function quarterSpec(taxYear: number, quarter: 1 | 2 | 3 | 4): QuarterSpec {
  const y = String(taxYear);
  const table = {
    1: { periodEnd: `${y}-03-31`, due: `${y}-04-15`, factor: "4", annualizedShare: "0.225", safeHarborShare: "0.25" },
    2: { periodEnd: `${y}-05-31`, due: `${y}-06-15`, factor: "2.4", annualizedShare: "0.45", safeHarborShare: "0.5" },
    3: { periodEnd: `${y}-08-31`, due: `${y}-09-15`, factor: "1.5", annualizedShare: "0.675", safeHarborShare: "0.75" },
    4: { periodEnd: `${y}-12-31`, due: `${String(taxYear + 1)}-01-15`, factor: "1", annualizedShare: "0.9", safeHarborShare: "1" },
  } as const;
  return { quarter, ...table[quarter] };
}

const day = (isoDateTime: string): string => isoDateTime.slice(0, 10);

/** `date` plus `years`, calendar-wise (2024-02-29 + 1y -> 2025-02-28). */
export function addYears(date: IsoDate, years: number): IsoDate {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y + years, m - 1, 1));
  const last = new Date(Date.UTC(y + years, m, 0)).getUTCDate();
  dt.setUTCDate(Math.min(d, last));
  return dt.toISOString().slice(0, 10);
}

export function addDays(date: IsoDate, days: number): IsoDate {
  const t = Date.parse(`${date}T00:00:00.000Z`) + days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

export interface DatedTransaction {
  factId: string;
  subject: string;
  payload: TransactionPayload;
}

/**
 * Ordinary income posted in the tax year through `periodEnd`: income,
 * dividend and interest transactions, plus credits the institution
 * categorised as income -- excluding anything normalisation matched as
 * an internal transfer.
 */
export function ordinaryIncome(txns: readonly DatedTransaction[], taxYear: number, periodEnd: IsoDate): { total: Decimal; factIds: string[] } {
  const factIds: string[] = [];
  const amounts: string[] = [];
  for (const t of txns) {
    const p = t.payload;
    if (p.transfer_group !== null && p.transfer_group !== undefined) continue;
    const d = day(p.posted_at);
    if (!d.startsWith(String(taxYear)) || d > periodEnd) continue;
    const isIncome =
      p.type === "income" ||
      p.type === "dividend" ||
      p.type === "interest" ||
      (p.type === "credit" && /income|payroll|salary/i.test(p.raw_category ?? ""));
    if (!isIncome) continue;
    if (decimal.cmp(p.amount, "0") <= 0) continue;
    amounts.push(p.amount);
    factIds.push(t.factId);
  }
  return { total: decimal.sum(amounts), factIds };
}

export interface DatedLot {
  factId: string;
  subject: string;
  payload: LotPayload;
}

export interface SaleResult {
  txnId: string;
  subject: string;
  symbol: string;
  saleDate: IsoDate;
  proceeds: Decimal;
  quantity: Decimal;
  /** Null when any consumed lot had an unknown basis. */
  stGain: Decimal | null;
  ltGain: Decimal | null;
  basisIncomplete: boolean;
  lotFactIds: string[];
}

export interface GainsResult {
  stTotal: Decimal;
  ltTotal: Decimal;
  basisIncomplete: boolean;
  sales: SaleResult[];
  factIds: string[];
}

/**
 * Realized gains for the year through `periodEnd`, FIFO against the
 * ledger's lots per (account, symbol). A sale that consumes a lot with
 * an unknown basis contributes NOTHING to the totals -- the gap is
 * already a `missing_cost_basis` finding; it is never a zero basis.
 */
export function realizedGains(
  txns: readonly DatedTransaction[],
  lots: readonly DatedLot[],
  taxYear: number,
  periodEnd: IsoDate,
): GainsResult {
  const lotsByKey = new Map<string, { qty: bigint; basisPerShare: string | null; acquired: IsoDate; factId: string }[]>();
  const key = (subject: string, symbol: string): string => `${subject}|${symbol.toUpperCase()}`;
  for (const l of [...lots].sort((a, b) => a.payload.acquired_at.localeCompare(b.payload.acquired_at))) {
    const p = l.payload;
    const k = key(l.subject, p.instrument.symbol);
    const list = lotsByKey.get(k) ?? [];
    list.push({
      qty: decimal.parseDecimal(p.quantity),
      basisPerShare: p.cost_basis === null ? null : decimal.div(p.cost_basis, p.quantity),
      acquired: p.acquired_at,
      factId: l.factId,
    });
    lotsByKey.set(k, list);
  }

  const sales: SaleResult[] = [];
  const st: string[] = [];
  const lt: string[] = [];
  const factIds: string[] = [];
  let anyIncomplete = false;

  const sells = txns
    .filter((t) => t.payload.type === "sell" && t.payload.instrument != null && t.payload.quantity != null)
    .filter((t) => day(t.payload.posted_at).startsWith(String(taxYear)) && day(t.payload.posted_at) <= periodEnd)
    .sort((a, b) => a.payload.posted_at.localeCompare(b.payload.posted_at));

  for (const s of sells) {
    const p = s.payload;
    const symbol = p.instrument?.symbol ?? "";
    const saleDate = day(p.posted_at);
    const qty = decimal.abs(p.quantity as string);
    const proceeds = decimal.abs(p.amount);
    const perShare = decimal.div(proceeds, qty);
    const fifo = lotsByKey.get(key(s.subject, symbol)) ?? [];
    let remaining = decimal.parseDecimal(qty);
    let stGain = "0";
    let ltGain = "0";
    let incomplete = fifo.length === 0; // no lots at all: basis unknown
    const lotFactIds: string[] = [];
    while (remaining > 0n && fifo.length > 0) {
      const lot = fifo[0] as (typeof fifo)[0];
      const take = lot.qty < remaining ? lot.qty : remaining;
      const takeDec = decimal.formatDecimal(take);
      lotFactIds.push(lot.factId);
      if (lot.basisPerShare === null) {
        incomplete = true;
      } else {
        const gain = decimal.mul(takeDec, decimal.sub(perShare, lot.basisPerShare));
        const longTerm = saleDate > addYears(lot.acquired, 1);
        if (longTerm) ltGain = decimal.add(ltGain, gain);
        else stGain = decimal.add(stGain, gain);
      }
      lot.qty -= take;
      remaining -= take;
      if (lot.qty === 0n) fifo.shift();
    }
    if (remaining > 0n) incomplete = true; // sold more than the lots cover
    anyIncomplete = anyIncomplete || incomplete;
    if (!incomplete) {
      st.push(stGain);
      lt.push(ltGain);
    }
    factIds.push(s.factId, ...lotFactIds);
    sales.push({
      txnId: p.txn_id,
      subject: s.subject,
      symbol,
      saleDate,
      proceeds,
      quantity: qty,
      stGain: incomplete ? null : stGain,
      ltGain: incomplete ? null : ltGain,
      basisIncomplete: incomplete,
      lotFactIds,
    });
  }
  return { stTotal: decimal.sum(st), ltTotal: decimal.sum(lt), basisIncomplete: anyIncomplete, sales, factIds };
}

/**
 * Wash-sale watch: a sale that realized a loss, with a buy of the same
 * symbol in the same account within 30 days either side. Reported per
 * sale with an estimate of the disallowed portion.
 */
export function washSales(txns: readonly DatedTransaction[], sales: readonly SaleResult[]): WashSale[] {
  const out: WashSale[] = [];
  for (const s of sales) {
    if (s.basisIncomplete) continue;
    const loss = decimal.add(s.stGain as string, s.ltGain as string);
    if (decimal.cmp(loss, "0") >= 0) continue;
    for (const t of txns) {
      const p = t.payload;
      if (t.subject !== s.subject) continue;
      if (p.type !== "buy" || p.instrument?.symbol?.toUpperCase() !== s.symbol.toUpperCase()) continue;
      const d = day(p.posted_at);
      if (d < addDays(s.saleDate, -30) || d > addDays(s.saleDate, 30)) continue;
      const buyQty = decimal.abs(p.quantity ?? "0");
      const ratio = decimal.cmp(buyQty, s.quantity) >= 0 ? "1" : decimal.div(buyQty, s.quantity);
      out.push({
        account_id: s.subject,
        symbol: s.symbol,
        sale_txn_id: s.txnId,
        sale_date: s.saleDate,
        loss: decimal.round(loss, 2),
        repurchase_txn_id: p.txn_id,
        repurchase_date: d,
        disallowed_estimate: decimal.round(decimal.mul(loss, ratio), 2),
      });
      break; // one watch item per sale is enough for the queue
    }
  }
  return out;
}

const posOnly = (v: string): string => (decimal.cmp(v, "0") > 0 ? v : "0");

/** Tax on the annualized income at the profile's effective rates. */
export function annualizedTax(profile: TaxProfile, ordinary: Decimal, stGains: Decimal, ltGains: Decimal, factor: Decimal): Decimal {
  const ordAnnual = decimal.mul(decimal.add(posOnly(ordinary), posOnly(stGains)), factor);
  const ltAnnual = decimal.mul(posOnly(ltGains), factor);
  const tax = decimal.add(decimal.mul(ordAnnual, profile.ordinary_rate), decimal.mul(ltAnnual, profile.ltcg_rate));
  return decimal.round(tax, 2);
}

export function safeHarborCap(profile: TaxProfile): Decimal {
  return decimal.round(decimal.mul(profile.prior_year_tax, profile.prior_year_agi_over_150k ? "1.1" : "1"), 2);
}

export function requiredCumulative(spec: QuarterSpec, annualized: Decimal, cap: Decimal): Decimal {
  const byAnnualized = decimal.mul(spec.annualizedShare, annualized);
  const byHarbor = decimal.mul(spec.safeHarborShare, cap);
  return decimal.round(decimal.cmp(byAnnualized, byHarbor) <= 0 ? byAnnualized : byHarbor, 2);
}

/**
 * Payments credited through quarter `q`'s installment: the even
 * withholding share plus estimated payments (type `tax`, money out)
 * posted on or before the due date.
 */
export function paymentsCumulative(
  profile: TaxProfile,
  txns: readonly DatedTransaction[],
  spec: QuarterSpec,
  taxYear: number,
): { total: Decimal; factIds: string[] } {
  const withheld = decimal.mul(profile.withholding_annual, spec.safeHarborShare);
  const factIds: string[] = [];
  const paid: string[] = [];
  for (const t of txns) {
    const p = t.payload;
    if (p.type !== "tax" || decimal.cmp(p.amount, "0") >= 0) continue;
    const d = day(p.posted_at);
    if (d < `${String(taxYear)}-01-01` || d > spec.due) continue;
    paid.push(decimal.abs(p.amount));
    factIds.push(t.factId);
  }
  return { total: decimal.round(decimal.add(withheld, decimal.sum(paid)), 2), factIds };
}
