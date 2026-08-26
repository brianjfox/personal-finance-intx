// The household profile: who the operator is, and the people an estate
// or tax plan must know about (spouse, children, anyone else who should
// appear in a will). Lives in `<dataDir>/profile.json`, edited only
// through the GUI's Profile page and the Estate page's wizard.
//
// The SSN/TIN is stored here for documents and exports but is NEVER
// handed to a model: the `household_profile` agent tool redacts it, and
// the IPC surface returns only the last four digits.

import { type } from "arktype";

import { IsoDate } from "./scalars";

export const MaritalStatus = type("'single' | 'married' | 'partnered' | 'divorced' | 'widowed'");
export type MaritalStatus = typeof MaritalStatus.infer;

export const ProfilePerson = type({
  legal_name: "string > 0",
  "preferred_name?": "string",
  "date_of_birth?": IsoDate.or("null"),
  /** Social security / tax id. Stored for documents; redacted from models and the IPC surface. */
  "ssn?": "string | null",
  "citizenship?": "string",
  "country_of_residence?": "string",
  /** State/province of residence -- it drives estate and tax specifics. */
  "state_or_province?": "string",
  "marital_status?": MaritalStatus,
});
export type ProfilePerson = typeof ProfilePerson.infer;

export const ProfileRelation = type({
  legal_name: "string > 0",
  "relationship?": "string",
  "date_of_birth?": IsoDate.or("null"),
  "note?": "string",
});
export type ProfileRelation = typeof ProfileRelation.infer;

export const HouseholdProfile = type({
  person: ProfilePerson,
  /** All values display converted into this currency (ISO). Default USD. */
  "preferred_currency?": "string",
  "spouse?": ProfileRelation.or("null"),
  children: ProfileRelation.array(),
  /** Anyone else who should appear in a will: parents, siblings, godchildren, charities. */
  others: ProfileRelation.array(),
  "updated_at?": "string",
});
export type HouseholdProfile = typeof HouseholdProfile.infer;

// What a SAVE may carry: identical to the stored shape except that dates
// arrive the way people type them ("nov 3 1977"). The host normalizes
// them to ISO (refusing unreadable ones by name) before anything is
// stored -- so the strict IsoDate rule must NOT run at the request
// boundary, where it would bounce the whole form.
export const ProfilePersonInput = type({
  legal_name: "string > 0",
  "preferred_name?": "string",
  "date_of_birth?": "string | null",
  "ssn?": "string | null",
  "citizenship?": "string",
  "country_of_residence?": "string",
  "state_or_province?": "string",
  "marital_status?": MaritalStatus,
});
export type ProfilePersonInput = typeof ProfilePersonInput.infer;

export const ProfileRelationInput = type({
  legal_name: "string > 0",
  "relationship?": "string",
  "date_of_birth?": "string | null",
  "note?": "string",
});
export type ProfileRelationInput = typeof ProfileRelationInput.infer;

export const HouseholdProfileInput = type({
  person: ProfilePersonInput,
  "preferred_currency?": "string",
  "spouse?": ProfileRelationInput.or("null"),
  children: ProfileRelationInput.array(),
  others: ProfileRelationInput.array(),
  "updated_at?": "string",
});
export type HouseholdProfileInput = typeof HouseholdProfileInput.infer;

/** What models and the GUI may see: everything except the tax id. */
export function redactProfile(p: HouseholdProfile): Omit<HouseholdProfile, "person"> & { person: Omit<ProfilePerson, "ssn"> & { ssn_last4: string | null } } {
  const { ssn, ...person } = p.person;
  return { ...p, person: { ...person, ssn_last4: ssn != null && ssn.length >= 4 ? ssn.replace(/[^0-9A-Za-z]/g, "").slice(-4) : null } };
}
