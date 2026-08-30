// What every action handler closes over. Handlers are registered by
// string ref (BUILD_PLAN §8.5) so the workflow definition stays hashable;
// the registry is built once per host from this context.

import type { EstateFile, HouseholdProfile, InvestmentPlan, Principal, TaxProfile } from "@fin/contracts";
import type { HttpLogEntry, InstitutionAdapter } from "@fin/institutions";
import type { Ledger } from "@fin/ledger";
import type { Vault } from "@fin/vault";
import type { EffectContext } from "@intx/workflow";

/** One institution fetch, with the HTTP exchanges observed during it. */
export interface FetchLogRecord {
  institution_id: string;
  at: string;
  via: string;
  ok: boolean;
  error?: string;
  entries: HttpLogEntry[];
}

export interface ActionContext {
  ledger: Ledger;
  vault: Vault;
  adapters: () => InstitutionAdapter[];
  clock: () => Date;
  /** Reconciliation thresholds. */
  thresholds?: Partial<Thresholds>;
  /** The operator's tax profile (Phase 2). Null/absent -> tax checks fail loudly. */
  taxProfile?: () => TaxProfile | null;
  /** The operator's estate plan + observations (Phase 3). Null/absent -> registry/audit fail loudly. */
  estateFile?: () => EstateFile | null;
  /** The written investment plan (Phase 4). Null/absent -> proposals fail loudly. */
  plan?: () => InvestmentPlan | null;
  /** The household profile (who the operator is; spouse/children/others). Null/absent -> agents say it's not set up. */
  profile?: () => HouseholdProfile | null;
  /** Receives each institution fetch's HTTP exchanges (the Assets page's fetch-log view). */
  fetchLog?: (rec: FetchLogRecord) => void;
}

export interface Thresholds {
  /** A balance whose institution-stated as-of is older than this vs. fetch time is stale. */
  staleBalanceDays: number;
  /** Transfer legs across household accounts match within this many days. */
  transferWindowDays: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  staleBalanceDays: 3,
  transferWindowDays: 3,
};

export type ActionHandler = (input: unknown, ctx: EffectContext, signal: AbortSignal) => Promise<unknown>;

/** Capability names (`action({ effect: { requires } })`). The policy layer grants them per principal. */
export const CAP = {
  institutionRead: "institution.read",
  vaultWrite: "vault.write",
  ledgerRead: "ledger.read",
  ledgerReadPositions: "ledger.read.positions",
  recordRecommendation: "record.recommendation",
  recordVerdict: "record.verdict",
  recordApproval: "record.approval",
  recordInstruction: "record.instruction",
  ledgerWriteFact: (kind: string) => `ledger.write.fact.${kind}`,
  ledgerWriteFinding: "ledger.write.finding",
  ledgerEmit: "ledger.emit",
} as const;

export function principalOfStep(stepId: string, table: Record<string, Principal>): Principal {
  const p = table[stepId];
  if (p === undefined) throw new Error(`no principal registered for step ${stepId}`);
  return p;
}
