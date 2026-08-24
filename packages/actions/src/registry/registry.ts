// The Entity & Estate Registry (Phase 3, deck slides 6 and 8).
//
//   registry.sync   (registry)        diff `estate.json`'s entities and
//                                     OBSERVED titling into `entity` and
//                                     `titling` facts -- supersession on
//                                     change, idempotent batches, the
//                                     plan itself is never a fact
//   estate.audit    (estate_planner)  compare the plan on paper to the
//                                     plan in reality; every gap is a
//                                     fingerprint-deduped finding in the
//                                     queue. It never fixes anything.

import {
  assertType,
  EstateFile,
  type AccountPayload,
  type EntityPayload,
  type FactInput,
  type FindingCode,
  type FindingDraft,
  type FindingInput,
  type FindingKind,
  type Severity,
  type TitlingPayload,
} from "@fin/contracts";
import type { Ledger, StoredFact } from "@fin/ledger";

import { CAP, type ActionContext, type ActionHandler } from "../context";
import { suppressKnown } from "../reconcile/reconcile";

const REGISTRY_VIA = "registry@1";

function estateFileOf(actx: ActionContext): EstateFile {
  const raw = actx.estateFile?.() ?? null;
  if (raw === null) throw new Error("registry: no estate.json configured; write the estate plan before running the registry");
  return assertType(EstateFile, raw, "estate.json");
}

export interface RegistrySyncInput {
  run_key: string;
}

export function registrySyncHandler(actx: ActionContext): ActionHandler {
  return async (rawInput, ctx) => {
    const input = rawInput as RegistrySyncInput;
    if (typeof input.run_key !== "string") throw new Error("registry.sync: run_key is required");
    const estate = estateFileOf(actx);
    // One effect per fact kind so the capability check is per kind (the
    // policy grants ledger.write.fact.<kind>); the write itself happens
    // in the first, the second exists to be authorized -- the same
    // pattern as ledger.commit.
    let out: unknown = null;
    for (const [i, kind] of (["entity", "titling"] as const).entries()) {
      out = await ctx.perform({
        effectId: `sync:${kind}`,
        capability: CAP.ledgerWriteFact(kind),
        run: async () => {
          if (i > 0 && out !== null) return out;
          return syncRegistry(actx, estate, input.run_key);
        },
      });
    }
    return out;
  };
}

function syncRegistry(actx: ActionContext, estate: EstateFile, runKey: string): unknown {
  const { ledger } = actx;
  const asOf = actx.clock().toISOString();
  const facts: FactInput[] = [];
  const base = {
    observed_at: asOf,
    effective_at: asOf,
    source_id: "operator.estate",
    source_doc_id: null,
    writer: "registry" as const,
    provisional: false,
  };
  for (const e of estate.entities) {
    const payload: EntityPayload = { entity_id: e.entity_id, kind: e.kind, name: e.name, detail: e.detail ?? {} };
    const current = ledger.asOf({ kind: "entity", subject: e.entity_id, key: "entity" })[0] ?? null;
    if (current !== null && samePayload(current, payload)) continue;
    facts.push({ ...base, kind: "entity", subject: e.entity_id, key: "entity", payload, supersedes: current?.id ?? null });
  }
  for (const t of estate.observed.titling) {
    const payload: TitlingPayload = {
      account_id: t.account_id,
      owner: t.owner,
      in_trust: t.in_trust ?? null,
      beneficiaries: t.beneficiaries ?? [],
      verified_at: t.verified_at,
    };
    const current = ledger.asOf({ kind: "titling", subject: t.account_id, key: "titling" })[0] ?? null;
    if (current !== null && samePayload(current, payload)) continue;
    facts.push({
      ...base,
      kind: "titling",
      subject: t.account_id,
      key: "titling",
      // The observation is effective as of the operator's verification date.
      effective_at: `${t.verified_at}T00:00:00.000Z`,
      payload,
      supersedes: current?.id ?? null,
    });
  }
  if (facts.length === 0) {
    return { changed: 0, batch_id: null, entities: estate.entities.length, titling: estate.observed.titling.length };
  }
  const r = ledger.commit({ batchId: `${runKey}:registry`, writer: "registry", facts, note: "estate registry sync" });
  ledger.logAccess({
    at: asOf,
    principal: "registry",
    resource: "ledger:fact:entity+titling",
    action: "write",
    detail: `${String(facts.length)} registry facts from estate.json`,
  });
  return { changed: facts.length, batch_id: r.batchId, replayed: r.replayed, entities: estate.entities.length, titling: estate.observed.titling.length };
}

function samePayload(current: StoredFact, next: object): boolean {
  return JSON.stringify(current.payload) === JSON.stringify(next);
}

// --- the hygiene audit -------------------------------------------------

export function estateAuditHandler(actx: ActionContext): ActionHandler {
  return async (rawInput, ctx) => {
    const input = rawInput as RegistrySyncInput;
    if (typeof input.run_key !== "string") throw new Error("estate.audit: run_key is required");
    const estate = estateFileOf(actx);
    return ctx.perform({
      effectId: "audit",
      capability: CAP.ledgerWriteFinding,
      run: async () => {
        const drafts = estateHygiene(actx.ledger, estate, actx.clock());
        const fresh = suppressKnown(drafts, actx.ledger);
        const inputs: FindingInput[] = fresh.map((d) => {
          const { after_refs: _a, holds, fingerprint: _f, ...rest } = d;
          return { ...rest, detail: { ...rest.detail, holds }, after: [] };
        });
        const ids = actx.ledger.appendFindings(`${input.run_key}:estate:findings`, inputs);
        actx.ledger.emitEvent({
          id: `${input.run_key}:estate.audited`,
          kind: "estate.audited",
          payload: { run_key: input.run_key, finding_ids: ids, drafted: drafts.length, suppressed: drafts.length - fresh.length },
        });
        return { finding_ids: ids, drafted: drafts.length, suppressed: drafts.length - fresh.length, queued: inputs.filter((f) => f.requires_human).length };
      },
    });
  };
}

/** Pure: the plan-vs-reality checks. Exported for direct tests. */
export function estateHygiene(ledger: Ledger, estate: EstateFile, now: Date): FindingDraft[] {
  const asOf = now.toISOString();
  const drafts: FindingDraft[] = [];
  const draft = (f: {
    kind: FindingKind;
    code: FindingCode;
    severity: Severity;
    subject: string;
    summary: string;
    detail: Record<string, unknown>;
    evidence?: string[];
    identity: string[];
  }): void => {
    const idKeys = [...f.identity].sort();
    const fingerprint = `${f.code}|${f.subject}|${JSON.stringify(idKeys.map((k) => [k, f.detail[k] ?? null]))}`;
    drafts.push({
      kind: f.kind,
      code: f.code,
      severity: f.severity,
      subject: f.subject,
      summary: f.summary,
      detail: { ...f.detail, fingerprint },
      fingerprint,
      evidence: f.evidence ?? [],
      before: [],
      after_refs: [],
      requires_human: true,
      emitted_by: "estate_planner",
      as_of: asOf,
      provenance: { source_id: "estate.audit", source_doc_id: null, observed_at: asOf, via: REGISTRY_VIA },
      holds: false,
    });
  };

  const accounts = ledger.asOf({ kind: "account" });
  const titlingBySubject = new Map<string, StoredFact>();
  for (const f of ledger.asOf({ kind: "titling" })) titlingBySubject.set(f.subject, f);
  const planBySubject = new Map(estate.plan.titling.map((t) => [t.account_id, t]));
  const entityIds = new Set(ledger.asOf({ kind: "entity" }).map((f) => f.subject));

  // 1. Every ledger account should have a plan row AND an observed titling.
  for (const a of accounts) {
    const p = a.payload as AccountPayload;
    if (!planBySubject.has(p.account_id)) {
      draft({
        kind: "gap",
        code: "titling_gap",
        severity: "medium",
        subject: p.account_id,
        summary: `${p.account_id} (${p.name}) is in the ledger but the estate plan says nothing about how it should be titled`,
        detail: { side: "plan", account: p.account_id },
        evidence: [a.id],
        identity: ["side", "account"],
      });
    }
    if (!titlingBySubject.has(p.account_id)) {
      draft({
        kind: "gap",
        code: "titling_gap",
        severity: "medium",
        subject: p.account_id,
        summary: `${p.account_id} (${p.name}) has no observed titling on record -- transcribe the institution's registration/beneficiary form into estate.json`,
        detail: { side: "observed", account: p.account_id },
        evidence: [a.id],
        identity: ["side", "account"],
      });
    }
  }

  // 2. Plan rows that reference nothing real.
  const accountIds = new Set(accounts.map((a) => (a.payload as AccountPayload).account_id));
  for (const t of estate.plan.titling) {
    if (!accountIds.has(t.account_id)) {
      draft({
        kind: "gap",
        code: "titling_gap",
        severity: "low",
        subject: t.account_id,
        summary: `the estate plan titles ${t.account_id} but the ledger has no such account`,
        detail: { side: "ledger", account: t.account_id },
        identity: ["side", "account"],
      });
    }
    if (t.in_trust != null && !entityIds.has(t.in_trust) && !estate.entities.some((e) => e.entity_id === t.in_trust)) {
      draft({
        kind: "gap",
        code: "titling_gap",
        severity: "medium",
        subject: t.account_id,
        summary: `the plan puts ${t.account_id} in ${t.in_trust}, but no such entity is registered`,
        detail: { side: "entity", account: t.account_id, trust: t.in_trust },
        identity: ["side", "account", "trust"],
      });
    }
  }

  // 3. Plan vs observed: trust membership and beneficiaries.
  for (const t of estate.plan.titling) {
    const observedFact = titlingBySubject.get(t.account_id);
    if (observedFact === undefined) continue; // already a titling_gap
    const o = observedFact.payload as TitlingPayload;
    const planTrust = t.in_trust ?? null;
    if (planTrust !== o.in_trust) {
      draft({
        kind: "mismatch",
        code: "beneficiary_mismatch",
        severity: "high",
        subject: t.account_id,
        summary: `${t.account_id}: the plan says ${planTrust === null ? "no trust" : `titled in ${planTrust}`} but the paperwork says ${o.in_trust === null ? "no trust" : `titled in ${o.in_trust}`} (verified ${o.verified_at})`,
        detail: { field: "in_trust", plan: planTrust, observed: o.in_trust },
        evidence: [observedFact.id],
        identity: ["field", "plan", "observed"],
      });
    }
    const planBen = normalizeBeneficiaries(t.beneficiaries ?? []);
    const obsBen = normalizeBeneficiaries(o.beneficiaries);
    if (planBen !== obsBen) {
      draft({
        kind: "mismatch",
        code: "beneficiary_mismatch",
        severity: "high",
        subject: t.account_id,
        summary: `${t.account_id}: beneficiaries on file (${obsBen || "none"}) differ from the plan (${planBen || "none"}) -- registry vs. trust schedule`,
        detail: { field: "beneficiaries", plan: planBen, observed: obsBen },
        evidence: [observedFact.id],
        identity: ["field", "plan", "observed"],
      });
    }
  }

  // 4. Documents the plan expects, present in the vault by sha.
  const vaultShas = new Set(ledger.listDocuments(10_000).map((d) => d.sha256));
  for (const d of estate.plan.documents) {
    const sha = d.vault_sha256 ?? null;
    if (sha === null || !vaultShas.has(sha)) {
      draft({
        kind: "gap",
        code: "estate_doc_missing",
        severity: sha === null ? "medium" : "high",
        subject: "household.estate",
        summary:
          sha === null
            ? `the plan expects a ${d.kind} ("${d.description}") but no executed copy is linked -- ingest it into the vault and record its sha`
            : `the plan links a ${d.kind} ("${d.description}") to sha ${sha.slice(0, 12)}... but the vault has no such document`,
        detail: { kind: d.kind, description: d.description, sha },
        identity: ["kind", "description"],
      });
    }
  }

  // 5. Break-glass: someone must be able to operate this (slide 21).
  if (estate.plan.executors.length === 0) {
    draft({
      kind: "gap",
      code: "executor_gap",
      severity: "high",
      subject: "household.estate",
      summary: "no executor is recorded -- an estate system your executor cannot operate is a liability",
      detail: { field: "executors" },
      identity: ["field"],
    });
  }
  if (estate.plan.digital_access == null || estate.plan.digital_access.trim() === "") {
    draft({
      kind: "gap",
      code: "executor_gap",
      severity: "medium",
      subject: "household.estate",
      summary: "no digital-access note is recorded -- where the keys physically are must outlive you",
      detail: { field: "digital_access" },
      identity: ["field"],
    });
  }

  return drafts;
}

function normalizeBeneficiaries(list: readonly { name: string; share?: string | null }[]): string {
  return [...list]
    .map((b) => `${b.name.trim().toLowerCase()}${b.share != null ? `:${b.share}` : ""}`)
    .sort()
    .join(", ");
}
