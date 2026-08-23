import type { FetchResult, InstitutionSnapshot, SnapshotAccount } from "@fin/contracts";
import { openLedger, type Ledger } from "@fin/ledger";

import { DEFAULT_THRESHOLDS, normalize, reconcile, type NormalizeOutput, type ReconcileOutput } from "../src/index";

export const NIGHT1 = "2026-08-22T06:00:00.000Z";
export const NIGHT2 = "2026-08-23T06:00:00.000Z";
export const ASOF1 = "2026-08-22T00:00:00.000Z";
export const ASOF2 = "2026-08-23T00:00:00.000Z";

export function snap(institution_id: string, fetched_at: string, accounts: SnapshotAccount[]): InstitutionSnapshot {
  return { institution_id, fetched_at, via: "adapter.fixture@1", raw_document_ids: [], accounts };
}

export function checking(account_id: string, as_of: string, total: string, extra: Partial<SnapshotAccount> = {}): SnapshotAccount {
  return { account_id, name: account_id, type: "checking", currency: "USD", as_of, balances: [{ balance_type: "total", amount: total }], transactions: [], ...extra };
}

export function brokerage(account_id: string, as_of: string, extra: Partial<SnapshotAccount> = {}): SnapshotAccount {
  return { account_id, name: account_id, type: "brokerage", currency: "USD", as_of, balances: [], positions: [], transactions: [], ...extra };
}

export interface Night {
  ledger: Ledger;
  norm: NormalizeOutput;
  rec: ReconcileOutput;
  /** Commit everything exactly as the workflow would (provisional per reconcile). */
  commit: () => Record<string, string>;
}

/** Run normalise + reconcile for one night against `ledger`, optionally committing. */
export function runNight(ledger: Ledger, runKey: string, fetch: FetchResult, now: string): Night {
  const norm = normalize({ ...fetch, run_key: runKey }, ledger, DEFAULT_THRESHOLDS);
  const rec = reconcile(norm, ledger, DEFAULT_THRESHOLDS, new Date(now));
  const commit = (): Record<string, string> => {
    const ids: Record<string, string> = {};
    const held = new Set(rec.provisional_subjects);
    const writers = [...new Set(norm.facts.map((f) => f.fact.writer))];
    for (const w of writers) {
      const mine = norm.facts.filter((f) => f.fact.writer === w);
      const r = ledger.commit({ batchId: `${runKey}:${w}`, writer: w, facts: mine.map((f) => ({ ...f.fact, provisional: held.has(f.fact.subject) })) });
      mine.forEach((f, i) => {
        ids[f.ref] = r.factIds[i] as string;
      });
    }
    const findings = rec.findings.map((d) => {
      const { after_refs, holds: _h, ...rest } = d;
      const after = after_refs.map((r) => ids[r]).filter((x): x is string => x !== undefined);
      return { ...rest, after, evidence: [...new Set([...d.evidence, ...after])] };
    });
    ledger.appendFindings(`${runKey}:findings`, findings);
    return ids;
  };
  return { ledger, norm, rec, commit };
}

export function freshLedger(): Ledger {
  return openLedger(":memory:");
}
