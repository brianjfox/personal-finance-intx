// Entity & Estate Registry vocabulary (Phase 3, deck slides 6 and 8).
//
// Two sides, compared by the hygiene audit:
//   - THE PLAN: `<dataDir>/estate.json`, operator-maintained with an
//     attorney -- who should own what, titled how, with which
//     beneficiary; which documents should exist; who can operate the
//     system when the operator cannot.
//   - REALITY: what the ledger has observed -- `entity` and `titling`
//     facts (the operator transcribes what the institutions' forms
//     actually say today, dated), and the documents actually in the
//     vault.
//
// "Compares the plan on paper to the plan in reality: titling,
// beneficiaries, document versions, digital access, and who can operate
// this system when you cannot" (slide 8). The audit never fixes
// anything; every gap is a finding in the queue.

import { type } from "arktype";

import { IsoDate, Subject } from "./scalars";

export const ESTATE_DOC_KINDS = ["will", "trust", "poa", "healthcare_directive", "deed", "policy", "other"] as const;
export const EstateDocKind = type("'will' | 'trust' | 'poa' | 'healthcare_directive' | 'deed' | 'policy' | 'other'");
export type EstateDocKind = typeof EstateDocKind.infer;

export const Beneficiary = type({
  name: "string",
  /** Fraction as a decimal string ("0.5"); null/absent = unspecified. */
  "share?": "string | null",
});
export type Beneficiary = typeof Beneficiary.infer;

/** An entity in the plan: a person, trust, LLC, estate or joint arrangement. */
export const PlanEntity = type({
  entity_id: Subject,
  kind: "'person' | 'trust' | 'llc' | 'estate' | 'joint' | 'other'",
  name: "string",
  "detail?": "Record<string, unknown>",
});
export type PlanEntity = typeof PlanEntity.infer;

/** How one account SHOULD be titled, per the plan. */
export const PlanTitling = type({
  account_id: Subject,
  /** Owning entity (person, trust, LLC...). */
  owner: Subject,
  /** Trust the account should sit in (the "trust schedule"), if any. */
  "in_trust?": Subject.or("null"),
  "beneficiaries?": Beneficiary.array(),
});
export type PlanTitling = typeof PlanTitling.infer;

/**
 * What the institution's paperwork actually says TODAY, transcribed by
 * the operator with an as-of date. Synced into `titling` facts.
 */
export const ObservedTitling = type({
  account_id: Subject,
  owner: Subject,
  "in_trust?": Subject.or("null"),
  "beneficiaries?": Beneficiary.array(),
  /** When the operator last verified this against the institution's form. */
  verified_at: IsoDate,
});
export type ObservedTitling = typeof ObservedTitling.infer;

export const PlanDocument = type({
  kind: EstateDocKind,
  description: "string",
  /** sha256 of the executed copy in the vault, once ingested. */
  "vault_sha256?": type(/^[a-f0-9]{64}$/).or("null"),
});
export type PlanDocument = typeof PlanDocument.infer;

/** `<dataDir>/estate.json` -- the operator's estate plan and observations. */
export const EstateFile = type({
  entities: PlanEntity.array(),
  plan: type({
    titling: PlanTitling.array(),
    documents: PlanDocument.array(),
    /** Who can operate/shut down this system (break-glass, slide 21). */
    executors: "string[]",
    /** Where keys/passwords physically are; free text for the audit to check non-empty. */
    "digital_access?": "string | null",
  }),
  observed: type({
    titling: ObservedTitling.array(),
  }),
});
export type EstateFile = typeof EstateFile.infer;

/**
 * Payload of a `titling` fact (writer: registry): the OBSERVED titling
 * of one account, as of `verified_at`, transcribed from the
 * institution's paperwork. The plan is configuration, never a fact.
 */
export const TitlingPayload = type({
  account_id: Subject,
  owner: Subject,
  in_trust: Subject.or("null"),
  beneficiaries: Beneficiary.array(),
  verified_at: IsoDate,
});
export type TitlingPayload = typeof TitlingPayload.infer;
