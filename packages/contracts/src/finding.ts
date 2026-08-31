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
 * then the cheap extra checks that fall out of the same pass; then the
 * Phase 2 Tax Engine codes.
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
  "account_relinked", //                   a reconnect re-observed a known account under a new provider id
  "account_gone", //                       a complete feed stopped reporting an open account; it was closed
  // Phase 2 -- Tax Engine (deck slide 17: "nothing surprises you")
  "estimated_tax_due", //                  a quarterly estimated payment is due: pay it from reserve
  "reserve_shortfall", //                  the tax reserve does not cover the upcoming installment
  "safe_harbor_shortfall", //              cumulative payments fell short of a past installment
  "wash_sale_risk", //                     a loss sale with a replacement buy inside the 30-day window
  "tax_estimate_blocked", //               the estimate refused to compute over provisional data
  // Phase 3 -- Estate hygiene (deck slide 8: plan on paper vs plan in reality)
  "titling_gap", //                        an account with no titling record, or plan/ledger disagree on existence
  "beneficiary_mismatch", //               observed titling/beneficiaries differ from the estate plan
  "estate_doc_missing", //                 a document the plan expects (will, trust, POA) is not in the vault
  "executor_gap", //                       no executor or digital-access path recorded -- break-glass fails
  "advisory_note", //                      a model-flagged concern, cited to facts; never a computed figure
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

/**
 * A finding drafted by an interpretation pass before the facts it points
 * at have ledger ids: `after_refs` are proposed-fact refs a later commit
 * step resolves to ids, `fingerprint` is the stable identity used to
 * suppress re-raising a known condition (deck slide 21), and `holds`
 * says whether the finding marks its subject's night provisional.
 * Emitted by Reconciliation (Phase 1) and the Tax Engine (Phase 2).
 */
export interface FindingDraft extends Omit<FindingInput, "after" | "evidence"> {
  /** Ledger fact ids already known. */
  evidence: string[];
  fingerprint: string;
  /** Refs of proposed facts (not yet committed); resolved to ids after commit. */
  after_refs: string[];
  /** Whether this finding holds its subject's data provisional. */
  holds: boolean;
}

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
