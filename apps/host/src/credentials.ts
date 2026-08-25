// GUI credential management (FINANCE-PROMPT: "the user should be able
// to paste API keys and secrets once, and the app should store those in
// the Keychain... and be able to delete or modify those credentials").
// Three global slots (Anthropic, Plaid, Enable Banking) plus the
// per-connection tokens the connect flows store. Secret VALUES never
// leave the host: status reports presence only. The slot registry below
// is a whitelist -- the IPC surface can only ever touch these services.

import crypto from "node:crypto";

import { COINBASE_SERVICE, ENABLEBANKING_SERVICE, PLAID_SERVICE, type InstitutionEntry, type SecretStore } from "@fin/institutions";

/** The Anthropic key's Keychain home (docs/PACKAGING.md §7.3; the Tauri shell reads it at spawn). */
export const ANTHROPIC_SERVICE = "fin-interchange";

export interface CredentialField {
  account: string;
  label: string;
  /** Render as a multi-line box (PEM blocks). */
  multiline: boolean;
}

export interface CredentialSlot {
  id: "anthropic" | "plaid" | "enablebanking";
  label: string;
  service: string;
  fields: CredentialField[];
  note: string;
  /** Also mirrored into this env var of the running host, so it takes effect without a restart. */
  env?: string;
}

export const CREDENTIAL_SLOTS: readonly CredentialSlot[] = [
  {
    id: "anthropic",
    label: "AI assistant — Anthropic API key",
    service: ANTHROPIC_SERVICE,
    fields: [{ account: "anthropic", label: "API key", multiline: false }],
    note: "Powers the Strategist/Estate chats and model-drafted proposals. Everything else works without it. Takes effect immediately.",
    env: "ANTHROPIC_API_KEY",
  },
  {
    id: "plaid",
    label: "Plaid — US & Canadian banks",
    service: PLAID_SERVICE,
    fields: [
      { account: "client_id", label: "Client ID", multiline: false },
      { account: "secret", label: "Secret", multiline: false },
    ],
    note: "From dashboard.plaid.com. Needed once, before connecting a US/Canadian bank.",
  },
  {
    id: "enablebanking",
    label: "Enable Banking — European banks",
    service: ENABLEBANKING_SERVICE,
    fields: [
      { account: "app_id", label: "Application ID", multiline: false },
      { account: "private_key", label: "Private key (PEM)", multiline: true },
    ],
    note: "From enablebanking.com (register an application, upload your RSA public key). Needed once, before connecting a European bank.",
  },
];

export interface SlotStatus {
  id: CredentialSlot["id"];
  label: string;
  note: string;
  configured: boolean;
  fields: Array<CredentialField & { set: boolean }>;
}

export interface ConnectionTokenStatus {
  institution_id: string;
  name: string;
  adapter: InstitutionEntry["adapter"];
  /** Which per-connection secrets exist for it. */
  set: boolean;
}

export interface CredentialsStatus {
  slots: SlotStatus[];
  tokens: ConnectionTokenStatus[];
}

/** The per-connection secrets a connector entry owns. */
export function connectionSecretAccounts(e: InstitutionEntry): Array<{ service: string; account: string }> {
  switch (e.adapter) {
    case "plaid":
      return [{ service: PLAID_SERVICE, account: `access_token:${e.institution_id}` }];
    case "enablebanking":
      return [{ service: ENABLEBANKING_SERVICE, account: `session:${e.institution_id}` }];
    case "coinbase":
      return [
        { service: COINBASE_SERVICE, account: `api_key_name:${e.institution_id}` },
        { service: COINBASE_SERVICE, account: `private_key:${e.institution_id}` },
      ];
    default:
      return [];
  }
}

export function credentialsStatus(secrets: SecretStore, entries: InstitutionEntry[]): CredentialsStatus {
  const slots = CREDENTIAL_SLOTS.map((s) => {
    const fields = s.fields.map((f) => ({ ...f, set: secrets.get(s.service, f.account) !== null }));
    return { id: s.id, label: s.label, note: s.note, configured: fields.every((f) => f.set), fields };
  });
  const tokens = entries
    .map((e) => ({ e, accounts: connectionSecretAccounts(e) }))
    .filter(({ accounts }) => accounts.length > 0)
    .map(({ e, accounts }) => ({
      institution_id: e.institution_id,
      name: e.name,
      adapter: e.adapter,
      set: accounts.every((a) => secrets.get(a.service, a.account) !== null),
    }));
  return { slots, tokens };
}

/** Refuse obviously-wrong values before anything is stored. */
function validate(slot: CredentialSlot, values: Record<string, string>): void {
  for (const f of slot.fields) {
    const v = (values[f.account] ?? "").trim();
    if (v === "") throw new Error(`missing ${f.label}`);
  }
  if (slot.id === "enablebanking") {
    try {
      crypto.createPrivateKey((values["private_key"] as string).trim().replace(/\\n/g, "\n"));
    } catch {
      throw new Error("the private key doesn't parse -- paste the full PEM block (BEGIN ... PRIVATE KEY) you generated for Enable Banking");
    }
  }
}

export function setCredential(secrets: SecretStore, id: string, values: Record<string, string>): SlotStatus["id"] {
  const slot = CREDENTIAL_SLOTS.find((s) => s.id === id);
  if (slot === undefined) throw new Error(`unknown credential ${id}`);
  if (secrets.set === undefined) throw new Error("the configured secret store cannot persist credentials");
  validate(slot, values);
  for (const f of slot.fields) {
    secrets.set(slot.service, f.account, (values[f.account] as string).trim().replace(/\\n/g, "\n"));
  }
  // Mirror into the running host so it takes effect without a restart.
  if (slot.env !== undefined) process.env[slot.env] = (values[slot.fields[0]!.account] as string).trim();
  return slot.id;
}

export function deleteCredential(secrets: SecretStore, id: string): boolean {
  const slot = CREDENTIAL_SLOTS.find((s) => s.id === id);
  if (slot === undefined) throw new Error(`unknown credential ${id}`);
  let any = false;
  for (const f of slot.fields) {
    if (secrets.delete?.(slot.service, f.account) === true) any = true;
  }
  if (slot.env !== undefined) delete process.env[slot.env];
  return any;
}

/** Remove every per-connection secret an institution owns (used on delete and from the Credentials page). */
export function deleteConnectionTokens(secrets: SecretStore, e: InstitutionEntry): number {
  let n = 0;
  for (const a of connectionSecretAccounts(e)) {
    if (secrets.delete?.(a.service, a.account) === true) n += 1;
  }
  return n;
}
