// Institution registry: `<dataDir>/institutions.json` lists the household's
// connections. Each entry names an adapter and its options. Loading is
// deliberately boring: no code, no credentials in this file.

import fs from "node:fs";
import path from "node:path";

import { type } from "arktype";

import type { InstitutionAdapter } from "./adapter";
import { csvDropAdapter, type CsvDropOptions } from "./csvdrop";
import { jsonDropAdapter } from "./jsondrop";

export const InstitutionEntry = type({
  institution_id: /^inst\.[A-Za-z0-9_-]+$/,
  name: "string",
  adapter: "'jsondrop' | 'csvdrop'",
  "options?": "Record<string, unknown>",
});
export type InstitutionEntry = typeof InstitutionEntry.infer;

export const InstitutionsFile = type({ institutions: InstitutionEntry.array() });
export type InstitutionsFile = typeof InstitutionsFile.infer;

export interface LoadedInstitutions {
  entries: InstitutionEntry[];
  adapters: InstitutionAdapter[];
}

/** Build adapters from a registry file. Relative dirs resolve against `dataDir`. */
export function loadInstitutions(dataDir: string, file = path.join(dataDir, "institutions.json")): LoadedInstitutions {
  if (!fs.existsSync(file)) return { entries: [], adapters: [] };
  const parsed = InstitutionsFile(JSON.parse(fs.readFileSync(file, "utf8")));
  if (parsed instanceof type.errors) throw new Error(`${file}: ${parsed.summary}`);
  const adapters = parsed.institutions.map((e) => buildAdapter(dataDir, e));
  return { entries: parsed.institutions, adapters };
}

export function buildAdapter(dataDir: string, e: InstitutionEntry): InstitutionAdapter {
  const o = e.options ?? {};
  const dir = typeof o["dir"] === "string" ? path.resolve(dataDir, o["dir"]) : defaultInbox(dataDir, e.institution_id);
  switch (e.adapter) {
    case "jsondrop":
      return jsonDropAdapter({ institution_id: e.institution_id, dir });
    case "csvdrop":
      return csvDropAdapter({ ...(o as unknown as CsvDropOptions), institution_id: e.institution_id, dir });
  }
}

export function defaultInbox(dataDir: string, institutionId: string): string {
  return path.join(dataDir, "institutions", institutionId.replace(/^inst\./, ""), "inbox");
}
