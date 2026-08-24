// GUI-managed institutions: connections whose numbers the operator types
// into the app instead of dropping export files. Under the hood they are
// ordinary `jsondrop` institutions (registry `options.managed: true`):
// the source of truth is `<dataDir>/institutions/<id>/managed.json`, and
// every edit writes a fresh, dated snapshot into the same inbox the
// nightly fetch reads -- so managed data flows through fetch -> normalise
// -> reconcile exactly like a bank export, with the snapshot file kept in
// the vault as evidence. Nothing is ever edited in place: a change is a
// new snapshot, a removal is an observed balance of 0 (the account's
// history stays in the ledger, append-only).

import fs from "node:fs";
import path from "node:path";

import { AccountType, LIABILITY_ACCOUNT_TYPES, type Decimal } from "@fin/contracts";
import { defaultInbox, type InstitutionEntry } from "@fin/institutions";
import { type } from "arktype";

export const MANAGED_OPTION = "managed";

export function isManaged(entry: InstitutionEntry): boolean {
  return entry.adapter === "jsondrop" && entry.options?.[MANAGED_OPTION] === true;
}

export const ManagedAccount = type({
  account_id: /^acct\.[A-Za-z0-9_.-]+$/,
  name: "string > 0",
  type: AccountType,
  currency: /^[A-Z0-9]{2,10}$/,
  /** What it's worth (assets) or what is owed (credit cards, loans). Plain decimal string. */
  value: /^-?\d+(\.\d+)?$/,
  updated_at: "string.date.iso",
  /** Set when the operator removes the account: it keeps reporting 0 so the ledger records the closure. */
  "closed_at?": "string.date.iso",
});
export type ManagedAccount = typeof ManagedAccount.infer;

const ManagedFile = type({ accounts: ManagedAccount.array() });

function managedFilePath(dataDir: string, institutionId: string): string {
  return path.join(dataDir, "institutions", institutionId.replace(/^inst\./, ""), "managed.json");
}

export function readManagedAccounts(dataDir: string, institutionId: string): ManagedAccount[] {
  const file = managedFilePath(dataDir, institutionId);
  if (!fs.existsSync(file)) return [];
  const parsed = ManagedFile(JSON.parse(fs.readFileSync(file, "utf8")));
  if (parsed instanceof type.errors) throw new Error(`${file}: ${parsed.summary}`);
  return parsed.accounts;
}

function writeManagedAccounts(dataDir: string, institutionId: string, accounts: ManagedAccount[]): void {
  const file = managedFilePath(dataDir, institutionId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ accounts }, null, 2));
  fs.renameSync(tmp, file);
}

/** Emit the snapshot the jsondrop adapter will fetch: every managed account, closed ones at 0. */
function writeSnapshot(dataDir: string, institutionId: string, accounts: ManagedAccount[], now: Date): string {
  const inbox = defaultInbox(dataDir, institutionId);
  fs.mkdirSync(inbox, { recursive: true });
  const asOf = now.toISOString();
  const snapshot = {
    institution_id: institutionId,
    accounts: accounts.map((a) => ({
      account_id: a.account_id,
      name: a.name,
      type: a.type,
      currency: a.currency,
      as_of: asOf,
      balances: [
        {
          balance_type: LIABILITY_ACCOUNT_TYPES.has(a.type) ? "owed" : "total",
          amount: a.closed_at !== undefined ? "0" : a.value,
        },
      ],
    })),
  };
  // Lexicographic name order == chronological, which is how jsondrop picks the newest file.
  const file = path.join(inbox, `${asOf.replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(file, JSON.stringify(snapshot, null, 2));
  return file;
}

/** Set up a fresh managed institution: empty account list plus an empty snapshot, so the nightly has something valid to read from day one. */
export function initManagedInstitution(dataDir: string, institutionId: string, now: Date): void {
  writeManagedAccounts(dataDir, institutionId, []);
  writeSnapshot(dataDir, institutionId, [], now);
}

export interface UpsertManagedInput {
  account_id?: string;
  name: string;
  type: AccountType;
  currency?: string;
  value: Decimal;
}

/** Add an account or update its value/name/type; writes managed.json and a fresh snapshot. */
export function upsertManagedAccount(dataDir: string, institutionId: string, input: UpsertManagedInput, now: Date): ManagedAccount {
  const accounts = readManagedAccounts(dataDir, institutionId);
  const id = input.account_id ?? accountIdFor(institutionId, input.name, new Set(accounts.map((a) => a.account_id)));
  const existing = accounts.find((a) => a.account_id === id);
  const next: ManagedAccount = {
    account_id: id,
    name: input.name,
    type: input.type,
    currency: input.currency ?? existing?.currency ?? "USD",
    value: input.value,
    updated_at: now.toISOString(),
  };
  const check = ManagedAccount(next);
  if (check instanceof type.errors) throw new Error(check.summary);
  const merged = existing !== undefined ? accounts.map((a) => (a.account_id === id ? next : a)) : [...accounts, next];
  writeManagedAccounts(dataDir, institutionId, merged);
  writeSnapshot(dataDir, institutionId, merged, now);
  return next;
}

/** Remove = observe the balance going to 0 and keep it there. History stays; nothing is erased. */
export function closeManagedAccount(dataDir: string, institutionId: string, accountId: string, now: Date): boolean {
  const accounts = readManagedAccounts(dataDir, institutionId);
  const existing = accounts.find((a) => a.account_id === accountId);
  if (existing === undefined || existing.closed_at !== undefined) return false;
  const merged = accounts.map((a) =>
    a.account_id === accountId ? { ...a, closed_at: now.toISOString(), updated_at: now.toISOString() } : a,
  );
  writeManagedAccounts(dataDir, institutionId, merged);
  writeSnapshot(dataDir, institutionId, merged, now);
  return true;
}

function accountIdFor(institutionId: string, name: string, taken: ReadonlySet<string>): string {
  const inst = institutionId.replace(/^inst\./, "");
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "account";
  let id = `acct.${inst}.${slug}`;
  for (let n = 2; taken.has(id); n += 1) id = `acct.${inst}.${slug}_${n}`;
  return id;
}
