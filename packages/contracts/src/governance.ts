// The governance chain: Recommendation -> Approval -> Instruction -> Receipt.
//
//   Fact -> Finding -> Recommendation -> Approval -> Instruction -> Receipt
//                                            ^
//                                  awaitSignal -- the only path
//
// Defined in Phase 1 (schema before agents); produced from Phase 4 on.
// The chain is enforced in workflow topology (the topology test), not here.

import { type } from "arktype";

import { Principal } from "./principals";
import { Provenance } from "./provenance";
import { Decimal, Id, IsoDateTime, Money, Subject } from "./scalars";

export const ProposedAction = type({
  verb: "'BUY' | 'SELL' | 'HOLD' | 'REBALANCE' | 'TRANSFER' | 'PAY' | 'HARVEST' | 'REVIEW' | 'OTHER'",
  "instrument?": "string | null",
  "quantity?": Decimal.or("null"),
  "amount?": Money.or("null"),
  "detail?": "string",
});
export type ProposedAction = typeof ProposedAction.infer;

export const TaxLotRef = type({
  lot_id: "string",
  treatment: "'LTCG' | 'STCG' | 'none' | 'unknown'",
});

/** A proposed action with a thesis, evidence and an expiry (deck slide 12). */
export const Recommendation = type({
  id: Id,
  from: Principal,
  subject: Subject,
  action: ProposedAction,
  thesis: "string",
  /** "No evidence, no proposal." At least one ledger id. */
  evidence: Id.array().atLeastLength(1),
  as_of: IsoDateTime,
  "tax_lots?": TaxLotRef.array(),
  confidence: "0 <= number <= 1",
  /** Gates this must pass: e.g. `auditor.review`, `human.approve`. */
  requires: "string[]",
  /** "A recommendation older than its window is dead, not stale advice." */
  expires: IsoDateTime,
  provenance: Provenance,
});
export type Recommendation = typeof Recommendation.infer;

export const ApprovalBound = type({
  "max_quantity?": Decimal.or("null"),
  "max_amount?": Money.or("null"),
  "limit_price?": Decimal.or("null"),
});

/** Your signature on a specific proposal id. Scoped and time-boxed. */
export const Approval = type({
  id: Id,
  recommendation_id: Id,
  subject: Subject,
  /** Copied from the recommendation at signing time so the approval is self-describing. */
  action: ProposedAction,
  bound: ApprovalBound,
  /** Revocable until the instruction is sent; expires on its own clock. */
  expires: IsoDateTime,
  signed_by: "string",
  signed_at: IsoDateTime,
  /** The deterministic `awaitSignal` signalId derived from the recommendation id. */
  signal_id: "string",
  as_of: IsoDateTime,
  provenance: Provenance,
});
export type Approval = typeof Approval.infer;

/** What Execution is permitted to do. Derived only from an Approval. */
export const Instruction = type({
  id: Id,
  approval_id: Id,
  recommendation_id: Id,
  subject: Subject,
  action: ProposedAction,
  bound: ApprovalBound,
  issued_at: IsoDateTime,
  expires: IsoDateTime,
  /** Phase 4 ships with execution disabled: instructions are `prepared`, never `sent`. */
  status: "'prepared' | 'sent' | 'revoked' | 'expired'",
  as_of: IsoDateTime,
  provenance: Provenance,
});
export type Instruction = typeof Instruction.infer;

/** What actually happened, fed straight back to Reconciliation. */
export const Receipt = type({
  id: Id,
  instruction_id: Id,
  subject: Subject,
  executed_at: IsoDateTime,
  fills: type({
    instrument: "string",
    quantity: Decimal,
    price: Decimal,
    "fee?": Decimal.or("null"),
  }).array(),
  "broker_reference?": "string | null",
  raw: "Record<string, unknown>",
  as_of: IsoDateTime,
  provenance: Provenance,
});
export type Receipt = typeof Receipt.infer;
