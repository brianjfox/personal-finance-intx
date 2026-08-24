// `ingest.fetch` -- the Assets Manager pulls each institution.
//
// Output: `{ snapshots, failures }` (contracts `FetchResult`). Raw files go
// to the vault through `perform` so a crash re-run does not re-store or
// re-log them; the snapshot carries the resulting document ids as
// provenance. A failed institution is a `FetchFailure`, not a thrown
// error: the run continues and reconciliation records a `fetch_failed`
// finding for it.

import type { FetchFailure, FetchResult, InstitutionSnapshot } from "@fin/contracts";

import { CAP, type ActionContext, type ActionHandler } from "../context";

export interface FetchInput {
  run_key: string;
  /** Restrict to these institution ids; default all registered. */
  institutions?: string[];
}

export function fetchHandler(actx: ActionContext): ActionHandler {
  return async (rawInput, ctx, _signal) => {
    const input = (rawInput ?? {}) as Partial<FetchInput>;
    const wanted = input.institutions;
    const adapters = actx.adapters().filter((a) => wanted === undefined || wanted.includes(a.institution_id));
    const now = actx.clock();
    const snapshots: InstitutionSnapshot[] = [];
    const failures: FetchFailure[] = [];
    for (const adapter of adapters) {
      // One effect per institution: the adapter read + vault writes are the
      // external effect; its output (the snapshot with doc ids) is what is
      // replayed on resume.
      const result = (await ctx.perform({
        effectId: `fetch:${adapter.institution_id}`,
        capability: CAP.institutionRead,
        run: async () => {
          try {
            const out = await adapter.fetch({ now });
            const docIds: string[] = [];
            for (const raw of out.raw) {
              const stored = actx.vault.ingest({
                bytes: raw.bytes,
                filename: raw.filename,
                ...(raw.mime !== undefined ? { mime: raw.mime } : {}),
                kind: raw.kind,
                source_id: adapter.institution_id,
                institution_id: adapter.institution_id,
                account_id: raw.account_id ?? null,
                tax_year: raw.tax_year ?? null,
                ingested_by: "assets_manager",
              });
              docIds.push(stored.id);
            }
            actx.ledger.logAccess({
              at: now.toISOString(),
              principal: "assets_manager",
              resource: `institution:${adapter.institution_id}`,
              action: "read",
              detail: `${adapter.via}; ${out.snapshot.accounts.length} accounts; docs ${docIds.join(",")}`,
            });
            const snapshot: InstitutionSnapshot = { ...out.snapshot, raw_document_ids: docIds };
            return { ok: true as const, snapshot };
          } catch (e) {
            const failure: FetchFailure = {
              institution_id: adapter.institution_id,
              fetched_at: now.toISOString(),
              via: adapter.via,
              error: e instanceof Error ? e.message : String(e),
            };
            return { ok: false as const, failure };
          }
        },
      })) as { ok: true; snapshot: InstitutionSnapshot } | { ok: false; failure: FetchFailure };
      if (result.ok) snapshots.push(result.snapshot);
      else failures.push(result.failure);
    }
    const out: FetchResult = { snapshots, failures };
    return out;
  };
}
