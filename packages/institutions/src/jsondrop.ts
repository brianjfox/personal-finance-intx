// JSON drop-folder adapter.
//
// The institution "connection" of Phase 1: the operator (or an export
// script) drops a snapshot-shaped JSON file into
// `<dataDir>/institutions/<institution_id>/inbox/`. Each nightly fetch takes
// the newest file (by name, then mtime), validates it, and hands the file
// itself back as the raw document so the vault keeps it as evidence. Files
// are never deleted by the adapter; the vault dedupes identical bytes.

import fs from "node:fs";
import path from "node:path";

import { validateDraftSnapshot, type FetchOutput, type InstitutionAdapter } from "./adapter";

export interface JsonDropOptions {
  institution_id: string;
  dir: string;
}

export const JSONDROP_VIA = "adapter.jsondrop@1";

export function jsonDropAdapter(opts: JsonDropOptions): InstitutionAdapter {
  return {
    institution_id: opts.institution_id,
    via: JSONDROP_VIA,
    async fetch(ctx): Promise<FetchOutput> {
      const file = newestJson(opts.dir);
      if (file === null) {
        throw new Error(`jsondrop ${opts.institution_id}: no *.json in ${opts.dir}`);
      }
      const bytes = fs.readFileSync(file);
      let parsed: unknown;
      try {
        parsed = JSON.parse(new TextDecoder().decode(bytes));
      } catch (e) {
        throw new Error(`jsondrop ${opts.institution_id}: ${path.basename(file)} is not JSON: ${String(e)}`);
      }
      const body = (parsed ?? {}) as Record<string, unknown>;
      if (body["institution_id"] !== undefined && body["institution_id"] !== opts.institution_id) {
        throw new Error(
          `jsondrop ${opts.institution_id}: ${path.basename(file)} is for ${String(body["institution_id"])}`,
        );
      }
      const draft = validateDraftSnapshot(
        {
          institution_id: opts.institution_id,
          fetched_at: ctx.now.toISOString(),
          via: JSONDROP_VIA,
          accounts: body["accounts"],
        },
        `jsondrop ${opts.institution_id}: ${path.basename(file)}`,
      );
      return {
        raw: [{ bytes: new Uint8Array(bytes), filename: path.basename(file), mime: "application/json", kind: "snapshot" }],
        snapshot: draft,
      };
    },
  };
}

function newestJson(dir: string): string | null {
  if (!fs.existsSync(dir)) return null;
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith(".json") && !f.startsWith("."))
    .map((f) => {
      const p = path.join(dir, f);
      return { p, f, mtime: fs.statSync(p).mtimeMs };
    })
    .sort((a, b) => (a.f === b.f ? a.mtime - b.mtime : a.f.localeCompare(b.f)));
  return files.at(-1)?.p ?? null;
}
