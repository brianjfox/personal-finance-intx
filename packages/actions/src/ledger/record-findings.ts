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
  /** Hand-entered holdings reported tonight: their open stale_balance findings are moot (D-049). */
  manual_subjects?: string[];
  /** Accounts whose institution's own ids identify its movements: their open duplicate_transaction findings are moot (issue #123). */
  authoritative_id_subjects?: string[];
  /** The address_watched_twice conditions still standing tonight, by fingerprint (issue #112): open findings not in it are resolved. */
  still_watched_twice?: string[];
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
  /** stale_balance findings this run closed because the holding is hand-entered (D-049). */
  resolved_stale_holdings: number;
  resolved_own_id_duplicates: number;
  /** address_watched_twice findings this run closed because only one open account watches the address now (issue #112). */
  resolved_watched_twice: number;
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
        // A hand-entered holding has no feed to be stale: any open
        // stale_balance finding on it (raised before D-049) is moot.
        let resolvedStaleHoldings = 0;
        for (const subject of input.manual_subjects ?? []) {
          for (const f of actx.ledger.openFindings({ subject })) {
            if (f.code !== "stale_balance") continue;
            actx.ledger.appendResolution({
              finding_id: f.id,
              decision: "dismiss",
              note: `hand-entered holdings have no feed to be stale (resolved on ${input.run_key})`,
              decided_by: "reconciliation",
              decided_at: actx.clock().toISOString(),
              resulting_facts: [],
            });
            resolvedStaleHoldings += 1;
          }
        }
        // Where the institution's own ids identify its movements, a
        // duplicate finding raised on equal same-day fills (before #123)
        // was never a duplicate: moot.
        let resolvedOwnIdDuplicates = 0;
        for (const subject of input.authoritative_id_subjects ?? []) {
          for (const f of actx.ledger.openFindings({ subject })) {
            if (f.code !== "duplicate_transaction") continue;
            actx.ledger.appendResolution({
              finding_id: f.id,
              decision: "dismiss",
              note: `the institution's own ids tell these movements apart; equal same-day fills are not duplicates (resolved on ${input.run_key})`,
              decided_by: "reconciliation",
              decided_at: actx.clock().toISOString(),
              resulting_facts: [],
            });
            resolvedOwnIdDuplicates += 1;
          }
        }
        // An address watched twice stops being so when one of the
        // accounts closes (the operator removed the entry): the finding
        // resolves itself rather than waiting for a dismissal.
        let resolvedWatchedTwice = 0;
        if (input.still_watched_twice !== undefined) {
          const standing = new Set(input.still_watched_twice);
          for (const f of actx.ledger.openFindings({})) {
            if (f.code !== "address_watched_twice") continue;
            const fp = typeof f.detail["fingerprint"] === "string" ? (f.detail["fingerprint"] as string) : null;
            if (fp !== null && standing.has(fp)) continue;
            actx.ledger.appendResolution({
              finding_id: f.id,
              decision: "dismiss",
              note: `only one open account watches the address now (resolved on ${input.run_key})`,
              decided_by: "reconciliation",
              decided_at: actx.clock().toISOString(),
              resulting_facts: [],
            });
            resolvedWatchedTwice += 1;
          }
        }
        return {
          run_key: input.run_key,
          clean: input.clean,
          finding_ids: ids,
          queued,
          provisional_subjects: input.provisional_subjects ?? [],
          resolved_fetch_failures: resolvedFetchFailures,
          resolved_stale_holdings: resolvedStaleHoldings,
          resolved_own_id_duplicates: resolvedOwnIdDuplicates,
          resolved_watched_twice: resolvedWatchedTwice,
        } satisfies RecordFindingsOutput;
      },
    })) as RecordFindingsOutput;
    return out;
  };
}
