import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openLedger } from "@fin/ledger";
import { countPdfPages, createVault } from "../src/index";

describe("vault", () => {
  test("ingest stores content-addressed bytes once, read verifies the hash and logs access", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fin-vault-"));
    const ledger = openLedger(":memory:");
    const vault = createVault({ dir, ledger });
    const bytes = new TextEncoder().encode('{"hello":"world"}');
    const a = vault.ingest({ bytes, filename: "a.json", kind: "snapshot", source_id: "inst.demo", ingested_by: "document_vault" });
    const b = vault.ingest({ bytes, filename: "b.json", kind: "snapshot", source_id: "inst.demo", ingested_by: "document_vault" });
    expect(a.existed).toBe(false);
    expect(b.existed).toBe(true);
    expect(b.id).toBe(a.id);
    expect(fs.readdirSync(dir)).toEqual([`${a.sha256}.json`]);
    const back = vault.read(a.id, "assets_manager");
    expect(new TextDecoder().decode(back)).toBe('{"hello":"world"}');
    const log = ledger.listAccess();
    expect(log.map((e) => [e.principal, e.action])).toEqual([
      ["assets_manager", "read"],
      ["document_vault", "write"],
    ]);
    // tamper -> refuse
    fs.writeFileSync(path.join(dir, `${a.sha256}.json`), "{}");
    expect(() => vault.read(a.id, "assets_manager")).toThrow(/tampered/);
  });

  test("pdf page count heuristic", () => {
    const pdf = new TextEncoder().encode("%PDF-1.4\n1 0 obj << /Type /Pages /Kids [2 0 R 3 0 R] >>\n2 0 obj << /Type /Page >>\n3 0 obj << /Type /Page >>\n");
    expect(countPdfPages(pdf)).toBe(2);
  });
});
