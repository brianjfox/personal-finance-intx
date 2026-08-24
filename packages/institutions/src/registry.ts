// Institution registry: `<dataDir>/institutions.json` lists the household's
// connections. Each entry names an adapter and its options. Loading is
// deliberately boring: no code, no credentials in this file.

import fs from "node:fs";
import path from "node:path";

import { type } from "arktype";

import type { InstitutionAdapter } from "./adapter";
import { csvDropAdapter, type CsvDropOptions } from "./csvdrop";
import { enableBankingAdapter } from "./enablebanking";
import { jsonDropAdapter } from "./jsondrop";
import { plaidAdapter, PLAID_BASE_URLS } from "./plaid";
import type { SecretStore } from "./secrets";

export const InstitutionEntry = type({
  institution_id: /^inst\.[A-Za-z0-9_-]+$/,
  name: "string",
  adapter: "'jsondrop' | 'csvdrop' | 'plaid' | 'enablebanking'",
  /** `false` pauses the connection: the entry stays listed but no adapter is built. */
  "enabled?": "boolean",
  "options?": "Record<string, unknown>",
});
export type InstitutionEntry = typeof InstitutionEntry.infer;

export const InstitutionsFile = type({ institutions: InstitutionEntry.array() });
export type InstitutionsFile = typeof InstitutionsFile.infer;

export interface LoadedInstitutions {
  entries: InstitutionEntry[];
  adapters: InstitutionAdapter[];
}

/** Build adapters from a registry file. Relative dirs resolve against `dataDir`; connector credentials come from `secrets` (default: env + Keychain). */
export function loadInstitutions(dataDir: string, file = path.join(dataDir, "institutions.json"), secrets?: SecretStore): LoadedInstitutions {
  if (!fs.existsSync(file)) return { entries: [], adapters: [] };
  const parsed = InstitutionsFile(JSON.parse(fs.readFileSync(file, "utf8")));
  if (parsed instanceof type.errors) throw new Error(`${file}: ${parsed.summary}`);
  const adapters = parsed.institutions.filter((e) => e.enabled !== false).map((e) => buildAdapter(dataDir, e, secrets));
  return { entries: parsed.institutions, adapters };
}

// --- registry editing (the GUI's path; nobody hand-edits the file) ----

function readRegistry(file: string): InstitutionsFile {
  if (!fs.existsSync(file)) return { institutions: [] };
  const parsed = InstitutionsFile(JSON.parse(fs.readFileSync(file, "utf8")));
  if (parsed instanceof type.errors) throw new Error(`${file}: ${parsed.summary}`);
  return parsed;
}

function writeRegistry(file: string, contents: InstitutionsFile): void {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(contents, null, 2));
  fs.renameSync(tmp, file);
}

/** Turn a display name into an `inst.<slug>` id, unique within the registry. */
export function institutionIdFor(name: string, taken: ReadonlySet<string>): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "institution";
  let id = `inst.${slug}`;
  for (let n = 2; taken.has(id); n += 1) id = `inst.${slug}_${n}`;
  return id;
}

export interface AddInstitutionInput {
  name: string;
  adapter: InstitutionEntry["adapter"];
  institution_id?: string;
  options?: Record<string, unknown>;
}

/** Append an entry (creating the registry and the inbox directory) and return it. */
export function addInstitutionEntry(dataDir: string, input: AddInstitutionInput): InstitutionEntry {
  const file = path.join(dataDir, "institutions.json");
  const reg = readRegistry(file);
  const taken = new Set(reg.institutions.map((e) => e.institution_id));
  const id = input.institution_id ?? institutionIdFor(input.name, taken);
  if (taken.has(id)) throw new Error(`institution ${id} already exists`);
  const entry = InstitutionEntry({
    institution_id: id,
    name: input.name,
    adapter: input.adapter,
    ...(input.options !== undefined ? { options: input.options } : {}),
  });
  if (entry instanceof type.errors) throw new Error(entry.summary);
  reg.institutions.push(entry);
  writeRegistry(file, reg);
  fs.mkdirSync(defaultInbox(dataDir, id), { recursive: true });
  return entry;
}

/** Drop an entry from the registry. Inbox files and ledger history stay: records are never destroyed. */
export function removeInstitutionEntry(dataDir: string, institutionId: string): boolean {
  const file = path.join(dataDir, "institutions.json");
  const reg = readRegistry(file);
  const next = reg.institutions.filter((e) => e.institution_id !== institutionId);
  if (next.length === reg.institutions.length) return false;
  writeRegistry(file, { institutions: next });
  return true;
}

/** Merge fields into an entry's options (connector reconnects: new consent expiry, etc.). */
export function updateInstitutionOptions(dataDir: string, institutionId: string, patch: Record<string, unknown>): boolean {
  const file = path.join(dataDir, "institutions.json");
  const reg = readRegistry(file);
  const entry = reg.institutions.find((e) => e.institution_id === institutionId);
  if (entry === undefined) return false;
  entry.options = { ...entry.options, ...patch };
  writeRegistry(file, reg);
  return true;
}

/** Pause (`false`) or resume (`true`) a connection without losing its configuration. */
export function setInstitutionEnabled(dataDir: string, institutionId: string, enabled: boolean): boolean {
  const file = path.join(dataDir, "institutions.json");
  const reg = readRegistry(file);
  const entry = reg.institutions.find((e) => e.institution_id === institutionId);
  if (entry === undefined) return false;
  if (enabled) delete entry.enabled;
  else entry.enabled = false;
  writeRegistry(file, reg);
  return true;
}

export function buildAdapter(dataDir: string, e: InstitutionEntry, secrets?: SecretStore): InstitutionAdapter {
  const o = e.options ?? {};
  const dir = typeof o["dir"] === "string" ? path.resolve(dataDir, o["dir"]) : defaultInbox(dataDir, e.institution_id);
  const str = (k: string): string | undefined => (typeof o[k] === "string" ? (o[k] as string) : undefined);
  const num = (k: string): number | undefined => (typeof o[k] === "number" ? (o[k] as number) : undefined);
  switch (e.adapter) {
    case "jsondrop":
      return jsonDropAdapter({ institution_id: e.institution_id, dir });
    case "csvdrop":
      return csvDropAdapter({ ...(o as unknown as CsvDropOptions), institution_id: e.institution_id, dir });
    case "plaid": {
      const env = str("environment");
      return plaidAdapter({
        institution_id: e.institution_id,
        ...(env !== undefined && env in PLAID_BASE_URLS ? { environment: env as keyof typeof PLAID_BASE_URLS } : {}),
        ...(str("base_url") !== undefined ? { base_url: str("base_url") as string } : {}),
        ...(num("lookback_days") !== undefined ? { lookback_days: num("lookback_days") as number } : {}),
        ...(secrets !== undefined ? { secrets } : {}),
      });
    }
    case "enablebanking":
      return enableBankingAdapter({
        institution_id: e.institution_id,
        ...(str("base_url") !== undefined ? { base_url: str("base_url") as string } : {}),
        ...(num("lookback_days") !== undefined ? { lookback_days: num("lookback_days") as number } : {}),
        ...(secrets !== undefined ? { secrets } : {}),
      });
  }
}

export function defaultInbox(dataDir: string, institutionId: string): string {
  return path.join(dataDir, "institutions", institutionId.replace(/^inst\./, ""), "inbox");
}
