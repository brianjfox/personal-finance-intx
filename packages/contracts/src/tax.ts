// Tax vocabulary: the operator's tax profile and the Tax Engine's typed
// output (Phase 2, deck slide 17 "the tax calendar is a workflow").
//
// The engine is an ESTIMATOR, not tax advice: every rate and prior-year
// figure is operator-supplied configuration, every computed figure is
// deterministic over ledger facts and cites them, and the specifics
// belong with an accountant (BUILD_PLAN closing note). The quarter
// structure follows the IRS estimated-tax calendar: periods ending
// Mar 31 / May 31 / Aug 31 / Dec 31, due Apr 15 / Jun 15 / Sep 15 /
// Jan 15, with the annualized-income installment shares and the
// 110%-of-prior-year safe harbour. Statutory weekend/holiday shifts are
// not modelled; the dates here are the planning deadlines.

import { type } from "arktype";

import { Decimal, Id, IsoDate, IsoDateTime, Subject } from "./scalars";

export const TAX_QUARTERS = [1, 2, 3, 4] as const;
export type TaxQuarter = (typeof TAX_QUARTERS)[number];

/** `pre` = the reserve pre-stage check (lead days before the deadline); `due` = the deadline itself. */
export const TAX_STAGES = ["pre", "due"] as const;
export type TaxStage = (typeof TAX_STAGES)[number];
export const TaxStage = type("'pre' | 'due'");

/**
 * Operator-supplied tax configuration, one per tax year. Lives at
 * `<dataDir>/tax-profile.json` on Track A. Rates are EFFECTIVE marginal
 * rates chosen with an accountant; the engine never derives a bracket.
 */
export const TaxProfile = type({
  tax_year: "number.integer >= 1990",
  /** Effective marginal rate on ordinary income and short-term gains, e.g. "0.32". */
  ordinary_rate: Decimal,
  /** Effective rate on long-term capital gains. */
  ltcg_rate: Decimal,
  /** Total federal tax for the prior year (the safe-harbour base). */
  prior_year_tax: Decimal,
  /** True -> the safe harbour is 110% of prior-year tax, else 100%. */
  prior_year_agi_over_150k: "boolean",
  /** Expected annual withholding; the IRS treats it as paid evenly across quarters. */
  withholding_annual: Decimal,
  /** The designated tax-reserve account. Coverage = this account's ledger balance. */
  reserve_account: Subject,
  /** Days before each deadline the reserve pre-stage check runs. */
  "prestage_lead_days?": "1 <= number.integer <= 90",
});
export type TaxProfile = typeof TaxProfile.infer;

export const DEFAULT_PRESTAGE_LEAD_DAYS = 30;

/** A wash-sale watch item: a loss sale with a replacement buy within the +/-30-day window. */
export const WashSale = type({
  account_id: Subject,
  symbol: "string",
  sale_txn_id: "string",
  sale_date: IsoDate,
  loss: Decimal,
  repurchase_txn_id: "string",
  repurchase_date: IsoDate,
  /** loss x min(1, repurchased/sold) -- an estimate of the disallowed portion. */
  disallowed_estimate: Decimal,
});
export type WashSale = typeof WashSale.infer;

export const QuarterFigures = type({
  /** Ordinary income (incl. short-term gains are separate) posted through the period end. */
  ordinary_income: Decimal,
  st_gains: Decimal,
  lt_gains: Decimal,
  /** Sales excluded from the gain figures because a lot basis was unknown. */
  basis_incomplete: "boolean",
  /** 12 / months-in-period: 4, 2.4, 1.5, 1. */
  annualization_factor: Decimal,
  /** Tax on the annualized income at the profile's effective rates. */
  annualized_tax: Decimal,
  /** 110% (or 100%) of prior-year tax. */
  safe_harbor_cap: Decimal,
  /** Required cumulative payment through this quarter: min(annualized share, safe-harbour share). */
  required_cum: Decimal,
  /** Withholding share plus estimated payments posted by this quarter's due date. */
  payments_cum: Decimal,
  /** max(0, required_cum - payments_cum) -- the installment to fund and pay. */
  installment_due: Decimal,
});
export type QuarterFigures = typeof QuarterFigures.infer;

/**
 * The Tax Engine's output for one (quarter, stage) check: the typed
 * message every downstream step of the tax workflows consumes. `blocked`
 * non-empty means the estimate REFUSED to compute over provisional data
 * (deck slide 15); `figures`/`obligation` are then null and `reserve_ok`
 * is false so the coverage gate routes to escalation, not to "covered".
 */
export const QuarterEstimate = type({
  run_key: "string",
  tax_year: "number.integer >= 1990",
  quarter: "1 <= number.integer <= 4",
  stage: TaxStage,
  as_of: IsoDateTime,
  period_end: IsoDate,
  due: IsoDate,
  /** Provisional subjects that blocked the estimate; empty = computed. */
  blocked: Subject.array(),
  figures: QuarterFigures.or("null"),
  reserve: type({
    account: Subject,
    balance: Decimal.or("null"),
    balance_fact: Id.or("null"),
    required: Decimal,
    shortfall: Decimal,
  }).or("null"),
  /** The coverage gate's selector: reserve balance covers the installment. */
  reserve_ok: "boolean",
  obligation: type({
    subject: Subject,
    key: "string",
    obligation_id: "string",
    amount: Decimal,
    due: IsoDate,
    description: "string",
  }).or("null"),
  wash_sales: WashSale.array(),
  /** Ledger fact ids every figure was computed from. "Cite or stay quiet." */
  evidence: Id.array(),
});
export type QuarterEstimate = typeof QuarterEstimate.infer;
