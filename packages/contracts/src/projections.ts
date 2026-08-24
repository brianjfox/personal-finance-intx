// Projections vocabulary (Phase 3, deck slide 7): "Scenario and Monte
// Carlo engine ... Deterministic maths in code, narrated by a model."
//
// Both requests resolve to figures computed by `@fin/actions`'
// deterministic engines; the model only ever quotes them. Every result
// carries the ledger fact ids it was computed from, so the GUI can make
// each figure clickable and the Auditor (Phase 4) can re-run it.

import { type } from "arktype";

import { Decimal, Id, IsoDate, IsoDateTime, Subject } from "./scalars";

// --- Monte Carlo -------------------------------------------------------

export const ProjectionRequest = type({
  /** Starting portfolio value; absent -> computed from the ledger's current net worth. */
  "start_value?": Decimal.or("null"),
  years: "1 <= number.integer <= 60",
  /** Simulated paths. Deterministic given the seed. */
  "paths?": "100 <= number.integer <= 20000",
  /** Expected annual real return, e.g. "0.05". */
  "mu?": Decimal,
  /** Annual volatility, e.g. "0.15". */
  "sigma?": Decimal,
  /** Annual contribution (negative = withdrawal), applied at each year end. */
  "annual_flow?": Decimal,
  /** PRNG seed; the same seed and inputs reproduce the same figures exactly. */
  "seed?": "string",
});
export type ProjectionRequest = typeof ProjectionRequest.infer;

export const ProjectionYear = type({
  year: "number.integer >= 1",
  p10: Decimal,
  p50: Decimal,
  p90: Decimal,
});
export type ProjectionYear = typeof ProjectionYear.infer;

export const ProjectionResult = type({
  as_of: IsoDateTime,
  start_value: Decimal,
  years: "number.integer",
  paths: "number.integer",
  mu: Decimal,
  sigma: Decimal,
  annual_flow: Decimal,
  seed: "string",
  by_year: ProjectionYear.array(),
  /** Fraction of paths that ever touch zero (ruin), as a decimal string. */
  ruin_probability: Decimal,
  /** Ledger fact ids the start value was computed from (empty when supplied). */
  evidence: Id.array(),
});
export type ProjectionResult = typeof ProjectionResult.infer;

// --- Scenario: sell an asset (the slide-19 question) -------------------

export const ScenarioRequest = type({
  kind: "'sell_asset'",
  /** The account/property being sold (a ledger account subject). */
  subject: Subject,
  sale_date: IsoDate,
  /** Expected sale price; absent -> the asset's current ledger value. */
  "sale_price?": Decimal.or("null"),
  /** Cost basis; required for a property the ledger has no lots for. */
  "cost_basis?": Decimal.or("null"),
  /** Depreciation taken (rental property); recaptured at min(ordinary, 25%). */
  "depreciation_taken?": Decimal.or("null"),
});
export type ScenarioRequest = typeof ScenarioRequest.infer;

export const ScenarioTaxImpact = type({
  /** The estimated-tax quarter the sale date falls in. */
  quarter: "1 <= number.integer <= 4",
  due: IsoDate,
  /** Capital gain above recaptured depreciation, taxed at the LTCG rate. */
  ltcg_gain: Decimal,
  ltcg_tax: Decimal,
  /** Depreciation recapture, taxed at min(ordinary rate, 25%). */
  recapture: Decimal,
  recapture_tax: Decimal,
  total_tax: Decimal,
  /** That quarter's installment before and after the sale. */
  installment_before: Decimal,
  installment_after: Decimal,
  installment_delta: Decimal,
});
export type ScenarioTaxImpact = typeof ScenarioTaxImpact.infer;

export const ScenarioTrustImpact = type({
  /** Whether the asset sits in a trust today (observed titling). */
  in_trust: "boolean",
  trust: Subject.or("null"),
  /** What the estate plan/registry must do if the sale happens (slide 18). */
  actions: "string[]",
});
export type ScenarioTrustImpact = typeof ScenarioTrustImpact.infer;

export const ScenarioResult = type({
  kind: "'sell_asset'",
  as_of: IsoDateTime,
  subject: Subject,
  sale_date: IsoDate,
  sale_price: Decimal,
  cost_basis: Decimal.or("null"),
  tax: ScenarioTaxImpact.or("null"),
  trust: ScenarioTrustImpact,
  /** Ledger fact ids every figure above was computed from. */
  evidence: Id.array(),
  /** Non-fatal gaps (e.g. "no cost basis supplied or on record; tax impact not computed"). */
  caveats: "string[]",
});
export type ScenarioResult = typeof ScenarioResult.infer;
