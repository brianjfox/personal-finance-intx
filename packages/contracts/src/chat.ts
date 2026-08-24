// Chat vocabulary (Phase 3, deck slides 8 and 19). A conversation with
// an advisory agent is a sequence of typed turns recorded durably in
// the ledger's outbox -- the transcript is data, not scrollback.
//
// The model narrates; it never produces a figure. Every figure in a
// reply comes from a tool call whose result is captured verbatim as
// `evidence` on the turn, each item carrying the ledger fact ids it was
// computed from -- that is what makes the GUI's numbers clickable and
// the reply auditable after the conversation is gone.

import { type } from "arktype";

import { Id, IsoDateTime } from "./scalars";

export const CHAT_AGENTS = ["strategist", "estate_planner"] as const;
export type ChatAgent = (typeof CHAT_AGENTS)[number];
export const ChatAgent = type("'strategist' | 'estate_planner'");

/** One tool result the reply's figures came from, captured at call time. */
export const ChatEvidence = type({
  tool: "string",
  /** The tool's structured result, verbatim (figures, ids, caveats). */
  result: "unknown",
  /** Ledger fact ids cited by the result, surfaced for the GUI's links. */
  fact_ids: Id.array(),
  at: IsoDateTime,
});
export type ChatEvidence = typeof ChatEvidence.infer;

/** One user->agent exchange, as recorded in the ledger outbox. */
export const ChatTurn = type({
  agent: ChatAgent,
  /** Caller-supplied id; deduplicates delivery and keys the reply. */
  message_id: "string",
  message: "string",
  reply: "string",
  evidence: ChatEvidence.array(),
  /** Journal entry ids written during this turn (the thesis landing). */
  journal_ids: Id.array(),
  at: IsoDateTime,
});
export type ChatTurn = typeof ChatTurn.infer;
