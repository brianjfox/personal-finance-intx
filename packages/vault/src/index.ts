// Document Vault.
//
// Deck slide 6: "Statements, 1099s, K-1s, deeds, policies, trust
// instruments. Extracts structured facts and keeps the original page as
// evidence." The vault keeps bytes content-addressed under
// `<dataDir>/vault/<sha256>.<ext>` and a `document` row in the ledger; a
// fact's `source_doc_id` (+ `page`) points here. Bytes are written
// temp+fsync+rename so a crash never leaves a half-written original, and
// identical bytes ingested twice are stored once.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { Document, DocumentKind, Principal } from "@fin/contracts";
import type { Ledger } from "@fin/ledger";

export interface VaultOptions {
  dir: string;
  ledger: Ledger;
  clock?: () => Date;
}

export interface IngestInput {
  bytes: Uint8Array;
  filename: string;
  mime?: string;
  kind: DocumentKind;
  source_id: string;
  institution_id?: string | null;
  account_id?: string | null;
  tax_year?: number | null;
  ingested_by: Principal;
}

export interface IngestResult {
  id: string;
  sha256: string;
  path: string;
  existed: boolean;
}

export interface Vault {
  readonly dir: string;
  ingest(input: IngestInput): IngestResult;
  /** Bytes of a stored document. Logged to the access log under `principal`. */
  read(id: string, principal: Principal): Uint8Array;
  pathOf(id: string): string | null;
  get(id: string): Document | null;
  list(limit?: number): Document[];
}

export function createVault(opts: VaultOptions): Vault {
  const { dir, ledger } = opts;
  const clock = opts.clock ?? (() => new Date());
  fs.mkdirSync(dir, { recursive: true });

  const fileFor = (sha: string, filename: string): string =>
    path.join(dir, `${sha}${extOf(filename)}`);

  return {
    dir,
    ingest(input) {
      const sha256 = createHash("sha256").update(input.bytes).digest("hex");
      const mime = input.mime ?? guessMime(input.filename);
      const target = fileFor(sha256, input.filename);
      if (!fs.existsSync(target)) {
        const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
        const fd = fs.openSync(tmp, "w");
        try {
          fs.writeSync(fd, input.bytes);
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
        fs.renameSync(tmp, target);
      }
      const { id, existed } = ledger.appendDocument({
        sha256,
        mime,
        bytes: input.bytes.byteLength,
        filename: input.filename,
        kind: input.kind,
        pages: mime === "application/pdf" ? countPdfPages(input.bytes) : null,
        source_id: input.source_id,
        institution_id: input.institution_id ?? null,
        account_id: input.account_id ?? null,
        tax_year: input.tax_year ?? null,
        ingested_at: clock().toISOString(),
        ingested_by: input.ingested_by,
      });
      if (!existed) {
        ledger.logAccess({
          at: clock().toISOString(),
          principal: input.ingested_by,
          resource: `vault:${id}`,
          action: "write",
          detail: `${input.filename} (${sha256.slice(0, 12)})`,
        });
      }
      return { id, sha256, path: target, existed };
    },
    read(id, principal) {
      const doc = ledger.getDocument(id);
      if (doc === null) throw new Error(`vault: no document ${id}`);
      const p = fileFor(doc.sha256, doc.filename);
      const bytes = fs.readFileSync(p);
      const sha = createHash("sha256").update(bytes).digest("hex");
      if (sha !== doc.sha256) {
        throw new Error(`vault: ${id} on disk does not match its recorded sha256 (tampered or corrupt)`);
      }
      ledger.logAccess({
        at: clock().toISOString(),
        principal,
        resource: `vault:${id}`,
        action: "read",
      });
      return new Uint8Array(bytes);
    },
    pathOf(id) {
      const doc = ledger.getDocument(id);
      return doc === null ? null : fileFor(doc.sha256, doc.filename);
    },
    get(id) {
      return ledger.getDocument(id);
    },
    list(limit) {
      return ledger.listDocuments(limit);
    },
  };
}

function extOf(filename: string): string {
  const m = /(\.[A-Za-z0-9]{1,8})$/.exec(filename);
  return m === null ? "" : m[1]!.toLowerCase();
}

export function guessMime(filename: string): string {
  switch (extOf(filename)) {
    case ".pdf":
      return "application/pdf";
    case ".json":
      return "application/json";
    case ".csv":
      return "text/csv";
    case ".txt":
      return "text/plain";
    case ".ofx":
    case ".qfx":
      return "application/x-ofx";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    default:
      return "application/octet-stream";
  }
}

/** Cheap PDF page count: `/Type /Page` objects (not `/Pages`). Good enough for evidence metadata. */
export function countPdfPages(bytes: Uint8Array): number | null {
  const text = Buffer.from(bytes).toString("latin1");
  const matches = text.match(/\/Type\s*\/Page(?![s])/g);
  if (matches === null) return null;
  return matches.length;
}
