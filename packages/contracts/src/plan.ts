// The written investment plan (Phase 4, deck slides 8, 13 and 16): the
// operator's target allocation and standing constraints, maintained at
// `<dataDir>/plan.json`. Configuration, never a fact -- the same rule as
// the tax profile and the estate plan. The Market Manager reads it to
// find drift ("read_plan_targets"); the Auditor blocks any proposal that
// conflicts with it (slide-16 condition 3).

import { type } from "arktype";

import { AssetClass } from "./fact";
import { Decimal, Id, IsoDate, IsoDateTime, Subject } from "./scalars";

export const PlanTarget = type({
  asset_class: AssetClass,
  /** Target weight as a fraction of the invested portfolio, e.g. "0.6". */
  weight: Decimal,
});
export type PlanTarget = typeof PlanTarget.infer;

export const PlanConstraints = type({
  /** No single position may exceed this fraction of the portfolio. */
  "max_position_weight?": Decimal.or("null"),
  /** Symbols that must never appear in a SELL proposal. */
  "do_not_sell?": "string[]",
  /** No single proposed order above this value. */
  "max_order_value?": Decimal.or("null"),
  /**
   * Days of look-ahead for the slide-16 tax-cash check: a proposal that
   * consumes cash needed for a tax obligation due inside this horizon is
   * blocked. Default 60.
   */
  "tax_cash_horizon_days?": "1 <= number.integer <= 365",
});
export type PlanConstraints = typeof PlanConstraints.infer;

/** `<dataDir>/plan.json` -- the written plan the deck's slide 16 refers to. */
export const InvestmentPlan = type({
  as_of: IsoDate,
  /** Drift tolerance in weight points, e.g. "0.05" = 5pp band per class. */
  band: Decimal,
  targets: PlanTarget.array().atLeastLength(1),
  constraints: PlanConstraints,
  "notes?": "string",
});
export type InvestmentPlan = typeof InvestmentPlan.infer;

// --- the deterministic drift report ------------------------------------

export const CandidateOrder = type({
  index: "number.integer >= 0",
  side: "'BUY' | 'SELL'",
  account: Subject,
  symbol: "string",
  quantity: Decimal,
  est_price: Decimal,
  est_value: Decimal,
  /** Deterministic one-line rationale ("equity 6.2pp over target"). */
  rationale: "string",
  "tax_lots?": type({ lot_id: "string", treatment: "'LTCG' | 'STCG' | 'none' | 'unknown'" }).array(),
});
export type CandidateOrder = typeof CandidateOrder.infer;

export const DriftLine = type({
  asset_class: AssetClass,
  value: Decimal,
  weight: Decimal,
  target: Decimal,
  /** weight - target, in weight points. */
  drift: Decimal,
});
export type DriftLine = typeof DriftLine.infer;

export const DriftReport = type({
  run_key: "string",
  as_of: IsoDateTime,
  portfolio_value: Decimal,
  cash_value: Decimal,
  by_class: DriftLine.array(),
  /** Deterministic candidate orders, largest drift first. Empty = in band. */
  candidates: CandidateOrder.array(),
  /** Position/balance fact ids every figure above came from. */
  evidence: Id.array(),
});
export type DriftReport = typeof DriftReport.infer;

// --- the proposal draft and the audit verdict ---------------------------

/**
 * What the Market Manager's reply must parse as (BUILD_PLAN §8.1 bridge):
 * a full Recommendation minus the ledger-assigned id and provenance,
 * plus the candidate index it canonicalizes. `emit_proposal` builds this
 * FROM the drift report, so the model never types a figure.
 */
export const ProposalDraft = type({
  from: "'market_manager'",
  subject: Subject,
  candidate_index: "number.integer >= 0",
  action: type({
    verb: "'BUY' | 'SELL'",
    instrument: "string",
    quantity: Decimal,
    amount: type({ amount: Decimal, currency: "'USD'" }),
    detail: "string",
  }),
  thesis: "string > 0",
  evidence: Id.array().atLeastLength(1),
  "tax_lots?": type({ lot_id: "string", treatment: "'LTCG' | 'STCG' | 'none' | 'unknown'" }).array(),
  confidence: "0 <= number <= 1",
  requires: "string[]",
  expires: IsoDateTime,
  as_of: IsoDateTime,
});
export type ProposalDraft = typeof ProposalDraft.infer;

export const AUDIT_CONDITIONS = ["unreproducible", "wash_sale", "plan_conflict", "tax_cash"] as const;
export type AuditCondition = (typeof AUDIT_CONDITIONS)[number];
export const AuditCondition = type("'unreproducible' | 'wash_sale' | 'plan_conflict' | 'tax_cash'");

export const AuditBlock = type({
  condition: AuditCondition,
  detail: "string",
});
export type AuditBlock = typeof AuditBlock.infer;

/** The Auditor's deterministic verdict on one recommendation attempt. */
export const AuditVerdict = type({
  recommendation_id: Id,
  attempt: "number.integer >= 1",
  cleared: "boolean",
  blocks: AuditBlock.array(),
  as_of: IsoDateTime,
  /** The re-run's figures, for the queue's "Auditor: cleared · LTCG $x" line. */
  figures: "Record<string, unknown>",
});
export type AuditVerdict = typeof AuditVerdict.infer;
