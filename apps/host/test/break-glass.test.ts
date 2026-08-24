// BUILD_PLAN §9 must-have: "Break-glass: export opens and is
// comprehensible with the app uninstalled." The test plays the executor:
// it reads the export with nothing but the filesystem, a CSV split and
// a PDF magic check -- no @fin code touches the exported bytes.

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createApp } from "../src/app";
import { seedDemo } from "../src/demo";

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "fin-bg-"));

/** A deliberately naive CSV reader -- what a spreadsheet (or an executor) does. */
function readCsv(file: string): { header: string[]; rows: string[][] } {
  const lines = fs.readFileSync(file, "utf8").trim().split("\n");
  const parse = (line: string): string[] => {
    const out: string[] = [];
    let cur = "";
    let quoted = false;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i] as string;
      if (quoted) {
        if (ch === '"' && line[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else if (ch === '"') {
          quoted = false;
        } else {
          cur += ch;
        }
      } else if (ch === '"') {
        quoted = true;
      } else if (ch === ",") {
        out.push(cur);
        cur = "";
      } else {
        cur += ch;
      }
    }
    out.push(cur);
    return out;
  };
  const parsed = lines.map(parse);
  return { header: parsed[0] ?? [], rows: parsed.slice(1) };
}

describe("break-glass export (deck slide 21)", () => {
  test("the executor's view: CSVs, originals with checksums, the printed guide -- no project software required", async () => {
    const dataDir = tmp();
    seedDemo(dataDir, 1);
    const app = createApp({ dataDir });
    app.reloadInstitutions();
    expect((await app.runNightly({ runId: "nightly_bg" })).terminalStatus).toBe("completed");
    const result = app.exportBreakGlass();
    // The export is journaled -- itself a recorded decision.
    expect(app.ledger.listJournal().some((j) => j.summary.includes("break-glass export"))).toBe(true);
    app.close();

    // From here on: the app is "uninstalled" -- only fs and plain parsing.
    const dir = result.dir;
    const balances = readCsv(path.join(dir, "csv/balances.csv"));
    expect(balances.header).toEqual(["account", "balance_type", "amount", "currency", "observed_at", "effective_at"]);
    expect(balances.rows.length).toBeGreaterThanOrEqual(5);
    const savings = balances.rows.find((r) => r[0] === "acct.demobank.savings" && r[1] === "total");
    expect(savings?.[2]).toBe("25000.00");

    const positions = readCsv(path.join(dir, "csv/positions.csv"));
    expect(positions.rows.some((r) => r[1] === "VTI" && r[3] === "120")).toBe(true);
    // An unknown basis reads as the word, never a silent zero.
    expect(positions.rows.some((r) => r[1] === "AAPL" && r[6] === "unknown")).toBe(true);

    const journal = readCsv(path.join(dir, "csv/journal.csv"));
    expect(journal.header).toEqual(["at", "kind", "author", "summary"]);
    const facts = readCsv(path.join(dir, "csv/facts-full.csv"));
    expect(facts.rows.length).toBeGreaterThan(30);

    // The originals are there under readable names, with checksums in the manifest.
    const manifest = readCsv(path.join(dir, "documents/manifest.csv"));
    expect(manifest.rows.length).toBeGreaterThanOrEqual(3);
    for (const row of manifest.rows) {
      const file = path.join(dir, "documents", row[0] as string);
      expect(fs.existsSync(file)).toBe(true);
      const sha = new Bun.CryptoHasher("sha256").update(fs.readFileSync(file)).digest("hex");
      expect(sha).toBe(row[4] as string);
    }

    // The guide is a real PDF (magic + EOF + pages) and says the load-bearing things.
    const pdf = fs.readFileSync(path.join(dir, "OPERATING-GUIDE.pdf"));
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pdf.subarray(-7).toString()).toContain("%%EOF");
    const pdfText = pdf.toString("latin1");
    expect(pdfText).toContain("/Type /Page");
    expect(pdfText).toContain("How to shut it down");
    expect(pdfText).toContain("never held a credential");

    // index.html is self-contained and links the pieces.
    const html = fs.readFileSync(path.join(dir, "index.html"), "utf8");
    expect(html).toContain("OPERATING-GUIDE.pdf");
    expect(html).toContain("csv/balances.csv");
    expect(html).toContain("How to shut it down");
    expect(html).not.toContain("http://"); // nothing external
    expect(html).not.toContain("https://");
  }, 60_000);
});
