// `ingest.fetch` -- the Assets Manager pulls each institution.
//
// Output: `{ snapshots, failures }` (contracts `FetchResult`). Raw files go
// to the vault through `perform` so a crash re-run does not re-store or
// re-log them; the snapshot carries the resulting document ids as
// provenance. A failed institution is a `FetchFailure`, not a thrown
// error: the run continues and reconciliation records a `fetch_failed`
// finding for it.

import type { FetchFailure, FetchResult, InstitutionSnapshot } from "@fin/contracts";
import { views, type Ledger } from "@fin/ledger";

import { CAP, type ActionContext, type ActionHandler } from "../context";

export interface FetchInput {
  run_key: string;
  /** Restrict to these institution ids; default all registered. */
  institutions?: string[];
}

/** The widened transaction window used to backfill a shallow history. */
export const BACKFILL_LOOKBACK_DAYS = 365;
/** History this shallow (days back to the earliest observed transaction) triggers a backfill. */
export const BACKFILL_THRESHOLD_DAYS = 32;

/**
 * The transaction window to request for this institution, or null for the
 * adapter's default. Until the ledger holds more than a month of observed
 * transactions for the institution's accounts (a fresh connection, or one
 * that has only seen a fetch or two), ask for the past year so cash flow
 * and monthly spend rest on a real sample. Once the rolling window has
 * built more than a month of history, the default window takes over.
 */
export function backfillLookback(ledger: Ledger, institutionId: string, now: Date): number | null {
  const mine = new Set(
    views.accounts(ledger).filter((a) => a.institution_id === institutionId).map((a) => a.account_id),
  );
  let earliest: string | null = null;
  for (const f of views.transactions(ledger)) {
    const p = f.payload as { account_id?: string; posted_at?: string };
    if (p.account_id === undefined || !mine.has(p.account_id)) continue;
    if (p.posted_at !== undefined && (earliest === null || p.posted_at < earliest)) earliest = p.posted_at;
  }
  if (earliest === null) return BACKFILL_LOOKBACK_DAYS;
  const days = (now.getTime() - new Date(earliest).getTime()) / 86_400_000;
  return days < BACKFILL_THRESHOLD_DAYS ? BACKFILL_LOOKBACK_DAYS : null;
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
      // Shallow history (a fresh connection) widens the transaction
      // window to a year; established institutions keep the rolling default.
      const lookback = backfillLookback(actx.ledger, adapter.institution_id, now);
      // One effect per institution: the adapter read + vault writes are the
      // external effect; its output (the snapshot with doc ids) is what is
      // replayed on resume.
      const result = (await ctx.perform({
        effectId: `fetch:${adapter.institution_id}`,
        capability: CAP.institutionRead,
        run: async () => {
          try {
            const out = await adapter.fetch({ now, ...(lookback !== null ? { lookback_days: lookback } : {}) });
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
