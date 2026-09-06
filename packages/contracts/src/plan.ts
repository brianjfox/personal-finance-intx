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
  /**
   * Wake the Market Manager after a clean nightly when a class is out of
   * band (issue #97). Absent = off: a plan written before the option
   * keeps proposing only on the operator's press.
   */
  "auto_propose?": "boolean",
});
export type InvestmentPlan = typeof InvestmentPlan.infer;

// --- the deterministic drift report ------------------------------------

/**
 * One lot a SELL would consume -- or, for planning, one CONCEPTUAL lot:
 * an exchange fills an order in pieces, and each fill arrives as its own
 * lot, so same-day fills of one instrument in one account with the same
 * treatment collapse into a single reference (issue #101). `lot_id` is
 * then the first fill's, `fills` how many were folded in, `quantity` the
 * total, `acquired_at` the day.
 */
export const TaxLotRef = type({
  lot_id: "string",
  treatment: "'LTCG' | 'STCG' | 'none' | 'unknown'",
  "fills?": "number.integer >= 1",
  "quantity?": Decimal,
  "acquired_at?": "string",
});
export type TaxLotRef = typeof TaxLotRef.infer;

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
  "tax_lots?": TaxLotRef.array(),
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
  /** Cash in the plan's currency: cash-class positions plus open cash-account and sweep balances (issue #55). */
  cash_value: Decimal,
  /** Cash held in other currencies, left out of cash_value rather than face-value-summed. */
  "cash_excluded?": type({ currency: "string", amount: Decimal }).array(),
  by_class: DriftLine.array(),
  /** Deterministic candidate orders, largest drift first. Empty = in band. */
  candidates: CandidateOrder.array(),
  /** Position/balance fact ids every figure above came from. */
  evidence: Id.array(),
});
export type DriftReport = typeof DriftReport.infer;

// --- the proposal draft and the audit verdict ---------------------------

/** What a draft may acknowledge explicitly (issue #51). */
export const ACKNOWLEDGEMENTS = ["short_term_lots"] as const;
export type Acknowledgement = (typeof ACKNOWLEDGEMENTS)[number];
export const Acknowledgement = type("'short_term_lots'");

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
  "tax_lots?": TaxLotRef.array(),
  /** Conditions the Market Manager accepts on the record (issue #51): e.g. `short_term_lots` turns the Auditor's short-term-lot block into a caveat. */
  "acknowledgements?": Acknowledgement.array(),
  confidence: "0 <= number <= 1",
  requires: "string[]",
  expires: IsoDateTime,
  as_of: IsoDateTime,
});
export type ProposalDraft = typeof ProposalDraft.infer;

/**
 * What the Market Manager's reply carries (issue #101): its CHOICE, not
 * the draft. A draft can run to tens of thousands of characters (one
 * lot per exchange fill, one evidence id per position), which no model
 * can retype verbatim; the intake rebuilds the draft from this choice
 * with the same deterministic engine `emit_proposal` used, so the
 * figures are the engine's either way.
 */
export const ProposalChoice = type({
  candidate_index: "number.integer >= 0",
  thesis: "string > 0",
  confidence: "0 <= number <= 1",
  "acknowledgements?": Acknowledgement.array(),
});
export type ProposalChoice = typeof ProposalChoice.infer;

export const AUDIT_CONDITIONS = ["unreproducible", "wash_sale", "plan_conflict", "tax_cash"] as const;
export type AuditCondition = (typeof AUDIT_CONDITIONS)[number];
export const AuditCondition = type("'unreproducible' | 'wash_sale' | 'plan_conflict' | 'tax_cash'");

export const AuditBlock = type({
  condition: AuditCondition,
  detail: "string",
});
export type AuditBlock = typeof AuditBlock.infer;

/**
 * Something the operator must know before signing that is NOT a reason to
 * withhold the proposal (issue #51): an unverifiable lot, or a short-term
 * treatment the Market Manager acknowledged on the record.
 */
export const AuditCaveat = type({
  condition: "'lot_basis_unknown' | 'short_term_lots'",
  detail: "string",
});
export type AuditCaveat = typeof AuditCaveat.infer;

/** The Auditor's deterministic verdict on one recommendation attempt. */
export const AuditVerdict = type({
  recommendation_id: Id,
  attempt: "number.integer >= 1",
  cleared: "boolean",
  blocks: AuditBlock.array(),
  /** Shown on the approval card; optional only so verdicts stored before migration 3 still validate. */
  "caveats?": AuditCaveat.array(),
  as_of: IsoDateTime,
  /** The re-run's figures, for the queue's "Auditor: cleared · LTCG $x" line. */
  figures: "Record<string, unknown>",
});
export type AuditVerdict = typeof AuditVerdict.infer;
