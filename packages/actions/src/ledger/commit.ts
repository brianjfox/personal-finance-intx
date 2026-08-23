// `ledger.commit` -- append dated facts with provenance; nothing overwritten
// (deck slide 15, step 4). One step per writer: the step's principal is the
// writer, and the ledger refuses any kind the writer does not own.
//
// Input (merged by the workflow): { writer, facts: ProposedFact[], provisional_subjects, run_key }
// Output: { [writer]: { batch_id, ids: { [ref]: fact_id }, count, replayed } }
//
// The batch id is `${run_key}:${writer}`, so a crash re-run of this step
// -- whether or not the effect ledger remembers it -- lands on the same
// batch and the ledger returns the same ids. Exactly once, twice over.

import type { FactInput, Principal } from "@fin/contracts";

import { CAP, type ActionContext, type ActionHandler } from "../context";
import type { ProposedFact } from "../normalize/normalize";

export interface CommitInput {
  run_key: string;
  writer: Principal;
  facts: ProposedFact[];
  provisional_subjects: string[];
}

export interface CommitOutput {
  batch_id: string;
  ids: Record<string, string>;
  count: number;
  replayed: boolean;
  subjects: string[];
}

export function commitHandler(actx: ActionContext): ActionHandler {
  return async (rawInput, ctx) => {
    const input = rawInput as CommitInput;
    if (typeof input.run_key !== "string" || typeof input.writer !== "string") {
      throw new Error("ledger.commit: run_key and writer are required");
    }
    const mine = (input.facts ?? []).filter((f) => f.fact.writer === input.writer);
    const held = new Set(input.provisional_subjects ?? []);
    const kinds = [...new Set(mine.map((f) => f.fact.kind))].sort();
    const batchId = `${input.run_key}:${input.writer}`;

    // One effect per kind so the capability check is per fact kind (the
    // policy grants `ledger.write.fact.<kind>` per writer). The ledger write
    // itself is a single transaction on the first kind's effect; later kinds
    // are no-ops that exist to be authorized.
    let out: CommitOutput | null = null;
    for (const [i, kind] of kinds.entries()) {
      const result = (await ctx.perform({
        effectId: `commit:${kind}`,
        capability: CAP.ledgerWriteFact(kind),
        run: async () => {
          if (i > 0 && out !== null) return out;
          const facts: FactInput[] = mine.map((f) => ({
            ...f.fact,
            provisional: held.has(f.fact.subject),
          }));
          const r = actx.ledger.commit({
            batchId,
            writer: input.writer,
            facts,
            note: `nightly ${input.run_key}`,
          });
          const ids: Record<string, string> = {};
          mine.forEach((f, j) => {
            ids[f.ref] = r.factIds[j] as string;
          });
          actx.ledger.logAccess({
            at: actx.clock().toISOString(),
            principal: input.writer,
            resource: `ledger:batch:${batchId}`,
            action: "write",
            detail: `${String(facts.length)} facts (${kinds.join(",")}); provisional subjects: ${[...held].join(",") || "none"}`,
          });
          return {
            batch_id: batchId,
            ids,
            count: facts.length,
            replayed: r.replayed,
            subjects: [...new Set(facts.map((f) => f.subject))].sort(),
          } satisfies CommitOutput;
        },
      })) as CommitOutput;
      out = result;
    }
    if (out === null) out = { batch_id: batchId, ids: {}, count: 0, replayed: false, subjects: [] };
    return { [input.writer]: out };
  };
}
