// Finding: an interpretation -- a break, a risk, a gap. Carries severity.
// Emitted by the interpretation tier (Reconciliation, Tax Engine, Risk).
// The morning exception queue is the set of open findings that require a
// human, shown with "both versions side by side" (`before` / `after`).

import { type } from "arktype";

import { Principal } from "./principals";
import { Provenance } from "./provenance";
import { Id, IsoDateTime, Severity, Subject } from "./scalars";

export const FindingKind = type(
  "'break' | 'staleness' | 'correction' | 'gap' | 'tax_event' | 'risk' | 'mismatch' | 'info'",
);
export type FindingKind = typeof FindingKind.infer;

/**
 * Stable codes. The five silent errors of deck slide 10 are the first five;
 * the rest are the cheap extra checks that fall out of the same pass.
 */
export const FINDING_CODES = [
  "internal_transfer_booked_as_income", // 1. transfer between own accounts booked as income
  "duplicate_transaction", //              1. same movement booked twice
  "stale_balance", //                      2. balance stopped updating but looks live
  "corrected_tax_document", //             3. corrected 1099 silently changes last year's answer
  "missing_cost_basis", //                 4. cost basis missing on transferred lots
  "crypto_swap_taxable_event", //          5. crypto swap the feed does not call a sale
  "position_balance_mismatch", //          sum(positions) != stated total
  "fetch_failed", //                       an institution did not answer
  "unknown_account", //                    an account appeared that the registry has not seen
] as const;
export type FindingCode = (typeof FINDING_CODES)[number];
export const FindingCode = type.enumerated(...FINDING_CODES);

export const Finding = type({
  id: Id,
  kind: FindingKind,
  code: FindingCode,
  severity: Severity,
  subject: Subject,
  summary: "string",
  /** Structured detail for the GUI and for tests; shape depends on `code`. */
  detail: "Record<string, unknown>",
  /** Ledger fact ids this finding is grounded in. "Cite or stay quiet." */
  evidence: Id.array(),
  /** Prior facts (what the ledger believed). */
  before: Id.array(),
  /** Incoming facts (what the feed now says). */
  after: Id.array(),
  /** True when a human must decide; false for informational findings. */
  requires_human: "boolean",
  emitted_by: Principal,
  as_of: IsoDateTime,
  provenance: Provenance,
});
export type Finding = typeof Finding.infer;
export const FindingInput = Finding.omit("id");
export type FindingInput = typeof FindingInput.infer;

export const ResolutionDecision = type(
  "'accept_incoming' | 'keep_prior' | 'both' | 'dismiss' | 'custom'",
);
export type ResolutionDecision = typeof ResolutionDecision.infer;

/** The operator's answer to a finding. Appended and dated; the history stays intact. */
export const Resolution = type({
  id: Id,
  finding_id: Id,
  decision: ResolutionDecision,
  note: "string",
  decided_by: "string",
  decided_at: IsoDateTime,
  /** Facts appended as a consequence (e.g. the de-provisionalised rows). */
  resulting_facts: Id.array(),
});
export type Resolution = typeof Resolution.infer;
export const ResolutionInput = Resolution.omit("id");
export type ResolutionInput = typeof ResolutionInput.infer;
