// `govern.notify` -- step 5 of the nightly: "Emit events; Tax, Risk and
// Market agents wake on what changed." Only reachable through the gate's
// clean branch, and it double-checks: it refuses to emit for a subject
// the ledger still holds provisional. Downstream consumers subscribe to
// `ledger_event`; in Phase 1 there are none yet -- the outbox is the seam.
//
// `govern.hold` -- the exception path: records that downstream was held
// and why. The findings themselves were already queued by
// `record_findings`; this step is the audit line and the journal entry.

import { CAP, type ActionContext, type ActionHandler } from "../context";
import type { CommitOutput } from "../ledger/commit";

export interface NotifyInput {
  run_key: string;
  clean: boolean;
  provisional_subjects: string[];
  [writer: string]: unknown;
}

export class ProvisionalDataRefusal extends Error {
  override readonly name = "ProvisionalDataRefusal";
}

export function notifyHandler(actx: ActionContext): ActionHandler {
  return async (rawInput, ctx) => {
    const input = rawInput as NotifyInput;
    if (typeof input.run_key !== "string") throw new Error("notify: run_key is required");
    const subjects = new Set<string>();
    for (const v of Object.values(input)) {
      const c = v as Partial<CommitOutput> | undefined;
      if (c !== undefined && c !== null && typeof c === "object" && Array.isArray(c.subjects)) {
        for (const s of c.subjects) subjects.add(s);
      }
    }
    // Belt and braces: the gate should never route here with held data, and
    // the ledger is the final word on what is provisional.
    const held = [...subjects].filter((s) => actx.ledger.isProvisional(s));
    if (input.clean !== true || (input.provisional_subjects ?? []).length > 0 || held.length > 0) {
      throw new ProvisionalDataRefusal(
        `notify refused: downstream must not run on provisional data (${[...new Set([...(input.provisional_subjects ?? []), ...held])].join(", ") || "run not clean"})`,
      );
    }
    return ctx.perform({
      effectId: "notify",
      capability: CAP.ledgerEmit,
      run: async () => {
        const ids: string[] = [];
        for (const s of [...subjects].sort()) {
          ids.push(
            actx.ledger.emitEvent({
              id: `${input.run_key}:facts.committed:${s}`,
              kind: "facts.committed",
              subject: s,
              payload: { run_key: input.run_key },
            }),
          );
        }
        ids.push(
          actx.ledger.emitEvent({
            id: `${input.run_key}:nightly.clean`,
            kind: "nightly.clean",
            payload: { run_key: input.run_key, subjects: [...subjects].sort() },
          }),
        );
        return { emitted: ids, subjects: [...subjects].sort() };
      },
    });
  };
}

export function holdHandler(actx: ActionContext): ActionHandler {
  return async (rawInput, ctx) => {
    const input = rawInput as NotifyInput & { finding_ids?: string[]; queued?: number };
    if (typeof input.run_key !== "string") throw new Error("hold: run_key is required");
    return ctx.perform({
      effectId: "hold",
      capability: CAP.ledgerEmit,
      run: async () => {
        const held = input.provisional_subjects ?? [];
        const evt = actx.ledger.emitEvent({
          id: `${input.run_key}:nightly.held`,
          kind: "nightly.held",
          payload: { run_key: input.run_key, provisional_subjects: held, finding_ids: input.finding_ids ?? [], queued: input.queued ?? 0 },
        });
        actx.ledger.appendJournal({
          at: actx.clock().toISOString(),
          kind: "system",
          summary: `nightly ${input.run_key}: downstream held; ${String(held.length)} account(s) provisional, ${String(input.queued ?? 0)} item(s) queued`,
          detail: { provisional_subjects: held, finding_ids: input.finding_ids ?? [] },
          refs: input.finding_ids ?? [],
          author: "scheduler",
        });
        return { held, event: evt };
      },
    });
  };
}
