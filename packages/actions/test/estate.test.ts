// Phase 3: registry sync (estate.json -> entity/titling facts) and the
// deterministic hygiene audit (plan on paper vs plan in reality).

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { type EstateFile, type FactInput } from "@fin/contracts";
import { openLedger, type Ledger } from "@fin/ledger";

import { estateHygiene } from "../src/index";

const NOW = new Date("2026-09-01T00:00:00.000Z");

function freshLedger(): Ledger {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fin-estate-"));
  return openLedger(path.join(dir, "ledger.db"), { clock: () => NOW });
}

const base = { observed_at: NOW.toISOString(), effective_at: NOW.toISOString(), source_id: "inst.fixture", source_doc_id: null, supersedes: null, provisional: false } as const;

function seedAccounts(ledger: Ledger, ids: string[]): void {
  const facts: FactInput[] = ids.map((id) => ({
    ...base,
    kind: "account",
    subject: id,
    key: "account",
    writer: "assets_manager",
    payload: { account_id: id, institution_id: "inst.fixture", name: id, type: "checking", currency: "USD" },
  }));
  ledger.commit({ batchId: "seed:accounts", writer: "assets_manager", facts });
}

function seedRegistry(ledger: Ledger, estate: EstateFile): void {
  const facts: FactInput[] = [
    ...estate.entities.map((e): FactInput => ({
      ...base,
      kind: "entity",
      subject: e.entity_id,
      key: "entity",
      writer: "registry",
      payload: { entity_id: e.entity_id, kind: e.kind, name: e.name, detail: {} },
    })),
    ...estate.observed.titling.map((t): FactInput => ({
      ...base,
      kind: "titling",
      subject: t.account_id,
      key: "titling",
      writer: "registry",
      payload: { account_id: t.account_id, owner: t.owner, in_trust: t.in_trust ?? null, beneficiaries: t.beneficiaries ?? [], verified_at: t.verified_at },
    })),
  ];
  ledger.commit({ batchId: "seed:registry", writer: "registry", facts });
}

const estate: EstateFile = {
  entities: [
    { entity_id: "ent.p", kind: "person", name: "P" },
    { entity_id: "ent.t", kind: "trust", name: "T" },
  ],
  plan: {
    titling: [
      { account_id: "acct.a", owner: "ent.p", beneficiaries: [{ name: "Spouse", share: "1" }] },
      { account_id: "acct.b", owner: "ent.t", in_trust: "ent.t" },
      { account_id: "acct.gone", owner: "ent.p" }, // no such ledger account
      { account_id: "acct.d", owner: "ent.p", in_trust: "ent.missing" }, // unregistered trust
    ],
    documents: [
      { kind: "will", description: "Pour-over will" }, // not linked
      { kind: "trust", description: "Trust instrument", vault_sha256: "a".repeat(64) }, // linked but absent
    ],
    executors: [],
    digital_access: null,
  },
  observed: {
    titling: [
      { account_id: "acct.a", owner: "ent.p", beneficiaries: [], verified_at: "2026-07-01" }, // beneficiary mismatch
      { account_id: "acct.b", owner: "ent.t", in_trust: null, verified_at: "2026-07-01" }, // trust mismatch
      { account_id: "acct.d", owner: "ent.p", in_trust: "ent.missing", verified_at: "2026-07-01" },
    ],
  },
};

describe("estate hygiene audit", () => {
  test("every gap is a distinct fingerprinted finding: titling, beneficiaries, trust, documents, break-glass", () => {
    const ledger = freshLedger();
    seedAccounts(ledger, ["acct.a", "acct.b", "acct.c", "acct.d"]); // acct.c: not in plan
    seedRegistry(ledger, estate);
    const drafts = estateHygiene(ledger, estate, NOW);
    const by = (code: string) => drafts.filter((d) => d.code === code);

    // titling gaps: acct.c missing from plan AND from observed; acct.gone in
    // plan but not ledger; acct.d's trust entity unregistered... ent.missing
    // is not in entities nor the ledger.
    const gaps = by("titling_gap");
    expect(gaps.some((d) => d.subject === "acct.c" && (d.detail["side"] as string) === "plan")).toBe(true);
    expect(gaps.some((d) => d.subject === "acct.c" && (d.detail["side"] as string) === "observed")).toBe(true);
    expect(gaps.some((d) => d.subject === "acct.gone" && (d.detail["side"] as string) === "ledger")).toBe(true);
    expect(gaps.some((d) => d.subject === "acct.d" && (d.detail["side"] as string) === "entity")).toBe(true);

    // plan vs paperwork: the spouse never got added; the trust titling never happened.
    const mism = by("beneficiary_mismatch");
    expect(mism.some((d) => d.subject === "acct.a" && (d.detail["field"] as string) === "beneficiaries")).toBe(true);
    expect(mism.some((d) => d.subject === "acct.b" && (d.detail["field"] as string) === "in_trust")).toBe(true);

    // documents: one never linked, one linked to a sha the vault lacks.
    const docs = by("estate_doc_missing");
    expect(docs).toHaveLength(2);
    expect(docs.some((d) => (d.detail["sha"] as string | null) === null)).toBe(true);

    // break-glass: no executor, no digital access.
    expect(by("executor_gap")).toHaveLength(2);

    // every draft carries a stable fingerprint and requires the operator
    for (const d of drafts) {
      expect(d.fingerprint.length).toBeGreaterThan(0);
      expect(d.requires_human).toBe(true);
      expect(d.emitted_by).toBe("estate_planner");
    }
    // deterministic: same inputs, same drafts
    expect(estateHygiene(ledger, estate, NOW)).toEqual(drafts);
  });

  test("a clean estate yields no findings", () => {
    const ledger = freshLedger();
    const clean: EstateFile = {
      entities: estate.entities,
      plan: {
        titling: [{ account_id: "acct.a", owner: "ent.p", beneficiaries: [{ name: "Spouse", share: "1" }] }],
        documents: [],
        executors: ["E"],
        digital_access: "safe deposit box",
      },
      observed: {
        titling: [{ account_id: "acct.a", owner: "ent.p", beneficiaries: [{ name: "spouse ", share: "1" }], verified_at: "2026-07-01" }],
      },
    };
    seedAccounts(ledger, ["acct.a"]);
    seedRegistry(ledger, clean);
    // beneficiary comparison is case/whitespace-insensitive
    expect(estateHygiene(ledger, clean, NOW)).toEqual([]);
  });
});
