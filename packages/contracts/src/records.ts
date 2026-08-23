// Supporting records: documents in the vault, journal entries, access log.

import { type } from "arktype";

import { Principal } from "./principals";
import { Id, IsoDateTime, Subject } from "./scalars";

export const DocumentKind = type(
  "'statement' | 'tax_form' | 'trade_confirm' | 'deed' | 'policy' | 'trust' | 'will' | 'snapshot' | 'export' | 'other'",
);
export type DocumentKind = typeof DocumentKind.infer;

/** A document held in the vault. The bytes are content-addressed by `sha256`. */
export const Document = type({
  id: Id,
  sha256: /^[a-f0-9]{64}$/,
  mime: "string",
  bytes: "number.integer >= 0",
  filename: "string",
  kind: DocumentKind,
  /** Page count when the format exposes one (PDF); null otherwise. */
  pages: type("number.integer >= 0").or("null"),
  /** Who supplied it: `inst.schwab`, `operator.brian`. */
  source_id: Subject,
  "institution_id?": Subject.or("null"),
  "account_id?": Subject.or("null"),
  "tax_year?": type("number.integer").or("null"),
  ingested_at: IsoDateTime,
  ingested_by: Principal,
});
export type Document = typeof Document.infer;
export const DocumentInput = Document.omit("id");
export type DocumentInput = typeof DocumentInput.infer;

export const JournalEntry = type({
  id: Id,
  at: IsoDateTime,
  kind: "'decision' | 'note' | 'resolution' | 'approval' | 'system'",
  "subject?": Subject.or("null"),
  summary: "string",
  detail: "Record<string, unknown>",
  refs: Id.array(),
  author: "string",
});
export type JournalEntry = typeof JournalEntry.infer;
export const JournalEntryInput = JournalEntry.omit("id");
export type JournalEntryInput = typeof JournalEntryInput.infer;

/** Which principal touched what, when. Deck slide 9 (Security & Access). */
export const AccessLogEntry = type({
  id: Id,
  at: IsoDateTime,
  principal: Principal,
  resource: "string",
  action: "'read' | 'write' | 'invoke' | 'denied'",
  "detail?": "string",
  "run_id?": "string | null",
  "step_id?": "string | null",
});
export type AccessLogEntry = typeof AccessLogEntry.infer;
export const AccessLogInput = AccessLogEntry.omit("id");
export type AccessLogInput = typeof AccessLogInput.infer;
