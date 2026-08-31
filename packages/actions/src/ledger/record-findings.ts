// `ledger.record_findings` -- write tonight's findings now that the facts
// they point at have ids. Idempotent by batch id. Emits `findings.opened`.
//
// Input (merged): { run_key, findings: FindingDraft[], provisional_subjects, clean,
//                   assets_manager?: CommitOutput, cash_flow?: CommitOutput, document_vault?: CommitOutput, ... }
// Output: { run_key, clean, finding_ids, queued, provisional_subjects }

import type { FindingInput } from "@fin/contracts";
import { PRINCIPALS } from "@fin/contracts";

import { CAP, type ActionContext, type ActionHandler } from "../context";
import type { CommitOutput } from "./commit";
import type { FindingDraft } from "../reconcile/reconcile";

export interface RecordFindingsInput {
  run_key: string;
  clean: boolean;
  findings: FindingDraft[];
  provisional_subjects: string[];
  /** Institutions that produced a snapshot tonight (reconcile passes it through from normalize). */
  answered?: string[];
  [writer: string]: unknown;
}

export interface RecordFindingsOutput {
  run_key: string;
  clean: boolean;
  finding_ids: string[];
  queued: number;
  provisional_subjects: string[];
  /** Stale "did not answer" findings this run closed because the institution answered. */
  resolved_fetch_failures: number;
}

export function recordFindingsHandler(actx: ActionContext): ActionHandler {
  return async (rawInput, ctx) => {
    const input = rawInput as RecordFindingsInput;
    if (typeof input.run_key !== "string") throw new Error("record_findings: run_key is required");
    const refToId = new Map<string, string>();
    for (const p of PRINCIPALS) {
      const c = input[p] as CommitOutput | undefined;
      if (c !== undefined && typeof c === "object" && c.ids !== undefined) {
        for (const [ref, id] of Object.entries(c.ids)) refToId.set(ref, id);
      }
    }
    const drafts = input.findings ?? [];
    const inputs: FindingInput[] = drafts.map((d) => {
      const after = d.after_refs.map((r) => refToId.get(r)).filter((x): x is string => x !== undefined);
      const { after_refs: _a, holds, fingerprint: _f, ...rest } = d;
      // `holds` rides in detail so resolution knows whether this finding held its subject.
      return { ...rest, detail: { ...rest.detail, holds }, after, evidence: [...new Set([...d.evidence, ...after])] };
    });
    const out = (await ctx.perform({
      effectId: "record-findings",
      capability: CAP.ledgerWriteFinding,
      run: async () => {
        const ids = actx.ledger.appendFindings(`${input.run_key}:findings`, inputs);
        const queued = inputs.filter((f) => f.requires_human).length;
        if (ids.length > 0) {
          actx.ledger.emitEvent({
            id: `${input.run_key}:findings.opened`,
            kind: "findings.opened",
            payload: { run_key: input.run_key, finding_ids: ids, queued, provisional_subjects: input.provisional_subjects },
          });
        }
        // A successful fetch is the definitive answer to "did not answer
        // tonight": close the institution's open fetch_failed findings so
        // the card's warning banner clears itself (issue #15). Idempotent
        // across crash re-runs -- a resolved finding is no longer open.
        let resolvedFetchFailures = 0;
        for (const inst of input.answered ?? []) {
          for (const f of actx.ledger.openFindings({ subject: inst })) {
            if (f.code !== "fetch_failed") continue;
            actx.ledger.appendResolution({
              finding_id: f.id,
              decision: "dismiss",
              note: `the institution answered on ${input.run_key}`,
              decided_by: "reconciliation",
              decided_at: actx.clock().toISOString(),
              resulting_facts: [],
            });
            resolvedFetchFailures += 1;
          }
        }
        return {
          run_key: input.run_key,
          clean: input.clean,
          finding_ids: ids,
          queued,
          provisional_subjects: input.provisional_subjects ?? [],
          resolved_fetch_failures: resolvedFetchFailures,
        } satisfies RecordFindingsOutput;
      },
    })) as RecordFindingsOutput;
    return out;
  };
}
