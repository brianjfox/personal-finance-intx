// Provenance: where a message came from and when it was known.
// "Every message carries provenance, an as-of timestamp and an id.
// Anything without them is not admissible." (deck slide 12)

import { type } from "arktype";

import { Id, IsoDateTime, Subject } from "./scalars";

export const Provenance = type({
  /** Who/what asserted it: `inst.schwab`, `operator.brian`, `handler.reconcile`. */
  source_id: Subject,
  /** The document in the vault this was extracted from, if any. */
  source_doc_id: Id.or("null"),
  /** Page of the source document, when known. 1-indexed. */
  "page?": type("number.integer >= 1").or("null"),
  /** When we learned it. */
  observed_at: IsoDateTime,
  /** The adapter/handler (and version) that produced it, e.g. `adapter.csv@1`. */
  "via?": "string",
});
export type Provenance = typeof Provenance.infer;
