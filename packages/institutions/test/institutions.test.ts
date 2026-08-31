import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { csvDropAdapter, decodeKeychainValue, encodeKeychainValue, fixtureAdapter, jsonDropAdapter, loadInstitutions, parseCsv, parseMoney, reorderInstitutionEntries } from "../src/index";

const NOW = new Date("2026-08-23T06:00:00.000Z");
const FIX = path.join(import.meta.dir, "fixtures");

describe("csv", () => {
  test("quoted fields, money, parens negatives", () => {
    const rows = parseCsv('a,b\n"x, y","he said ""hi"""\n');
    expect(rows).toEqual([{ a: "x, y", b: 'he said "hi"' }]);
    expect(parseMoney("$1,234.56")).toBe("1234.56");
    expect(parseMoney("(1,234.56)")).toBe("-1234.56");
    expect(parseMoney("--")).toBeNull();
    expect(parseMoney("")).toBeNull();
  });
});

describe("csvdrop adapter", () => {
  test("maps a brokerage export to a snapshot; blank basis stays null; cash row becomes a balance", async () => {
    const a = csvDropAdapter({
      institution_id: "inst.demo",
      dir: FIX,
      accounts: [
        {
          account_id: "acct.demo.brokerage",
          name: "Brokerage",
          type: "brokerage",
          currency: "USD",
          as_of: "2026-08-22T00:00:00.000Z",
          total_from_positions: true,
          positions: {
            file: "positions.csv",
            columns: { symbol: "Symbol", name: "Description", quantity: "Quantity", price: "Price", market_value: "Market Value", cost_basis: "Cost Basis", asset_class: "Security Type" },
            cash_symbols: ["Cash & Cash Investments"],
          },
          transactions: {
            file: "transactions.csv",
            columns: { date: "Date", type: "Action", symbol: "Symbol", description: "Description", quantity: "Quantity", amount: "Amount" },
          },
        },
      ],
    });
    const out = await a.fetch({ now: NOW });
    expect(out.raw.map((r) => r.filename).sort()).toEqual(["positions.csv", "transactions.csv"]);
    const acct = out.snapshot.accounts[0]!;
    expect(acct.positions).toHaveLength(2);
    const aapl = acct.positions!.find((p) => p.instrument.symbol === "AAPL")!;
    expect(aapl.cost_basis).toBeNull();
    expect(aapl.instrument.asset_class).toBe("equity");
    const vti = acct.positions!.find((p) => p.instrument.symbol === "VTI")!;
    expect(vti.cost_basis).toBe("8100.00");
    expect(vti.instrument.asset_class).toBe("etf");
    expect(acct.balances).toEqual([
      { balance_type: "cash", amount: "1500.25" },
      { balance_type: "total", amount: "13764.25" },
    ]);
    expect(acct.transactions!.map((t) => t.type)).toEqual(["buy", "transfer_in", "dividend"]);
    expect(acct.transactions![0]!.posted_at).toBe("2026-08-20T00:00:00.000Z");
  });
});

describe("jsondrop adapter + registry", () => {
  test("newest file wins, institution mismatch refused, raw file returned as evidence", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fin-inst-"));
    const inbox = path.join(dataDir, "institutions", "demo", "inbox");
    fs.mkdirSync(inbox, { recursive: true });
    const acct = (amount: string) => ({
      accounts: [{ account_id: "acct.demo.checking", name: "Checking", type: "checking", currency: "USD", as_of: "2026-08-22T00:00:00.000Z", balances: [{ balance_type: "total", amount }] }],
    });
    fs.writeFileSync(path.join(inbox, "2026-08-21.json"), JSON.stringify(acct("1")));
    fs.writeFileSync(path.join(inbox, "2026-08-22.json"), JSON.stringify(acct("2")));
    fs.writeFileSync(path.join(dataDir, "institutions.json"), JSON.stringify({ institutions: [{ institution_id: "inst.demo", name: "Demo", adapter: "jsondrop" }] }));
    const { adapters } = loadInstitutions(dataDir);
    expect(adapters).toHaveLength(1);
    const out = await adapters[0]!.fetch({ now: NOW });
    expect(out.snapshot.accounts[0]!.balances[0]!.amount).toBe("2");
    expect(out.raw[0]!.filename).toBe("2026-08-22.json");
    fs.writeFileSync(path.join(inbox, "2026-08-23.json"), JSON.stringify({ institution_id: "inst.other", ...acct("3") }));
    await expect(adapters[0]!.fetch({ now: NOW })).rejects.toThrow(/is for inst.other/);
    const empty = jsonDropAdapter({ institution_id: "inst.x", dir: path.join(dataDir, "nope") });
    await expect(empty.fetch({ now: NOW })).rejects.toThrow(/no \*\.json/);
  });

  test("fixture adapter validates the draft", async () => {
    const bad = fixtureAdapter("inst.demo", { accounts: [{ account_id: "acct.demo.x", name: "x", type: "checking", currency: "USD", as_of: "nope", balances: [] }] } as never);
    await expect(bad.fetch({ now: NOW })).rejects.toThrow(/violates contract/);
  });
});

describe("registry reorder", () => {
  test("listed ids take their relative order within their own slots; others stay put", () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fin-reorder-"));
    const entries = ["a", "b", "c", "d"].map((id) => ({ institution_id: `inst.${id}`, name: id.toUpperCase(), adapter: "jsondrop" }));
    fs.writeFileSync(path.join(dataDir, "institutions.json"), JSON.stringify({ institutions: entries }));
    const ids = () => loadInstitutions(dataDir).entries.map((e) => e.institution_id);
    // Reorder a subset (one "tab"): c before a, b and d untouched in place.
    expect(reorderInstitutionEntries(dataDir, ["inst.c", "inst.a"])).toBe(true);
    expect(ids()).toEqual(["inst.c", "inst.b", "inst.a", "inst.d"]);
    // Unknown ids are ignored; an effective no-op reports false.
    expect(reorderInstitutionEntries(dataDir, ["inst.c", "inst.nope", "inst.a"])).toBe(false);
    expect(reorderInstitutionEntries(dataDir, ["inst.only"])).toBe(false);
    expect(ids()).toEqual(["inst.c", "inst.b", "inst.a", "inst.d"]);
    // A full reorder applies exactly.
    expect(reorderInstitutionEntries(dataDir, ["inst.d", "inst.a", "inst.b", "inst.c"])).toBe(true);
    expect(ids()).toEqual(["inst.d", "inst.a", "inst.b", "inst.c"]);
  });
});

describe("keychain value encoding", () => {
  const PEM = "-----BEGIN PRIVATE KEY-----\nMIIEvAIBADANBg\nkqhkiG9w0BAQEF\n-----END PRIVATE KEY-----";

  test("multi-line values round-trip via the b64 tag; single-line values stay raw", () => {
    expect(encodeKeychainValue("sk-ant-plain")).toBe("sk-ant-plain");
    const enc = encodeKeychainValue(PEM);
    expect(enc.startsWith("b64:")).toBe(true);
    expect(enc.includes("\n")).toBe(false);
    expect(decodeKeychainValue(enc)).toBe(PEM);
  });

  test("legacy hex output from `security -w` (a raw multi-line write) is healed", () => {
    // What the CLI prints for an item stored with real newlines.
    const hexed = Buffer.from(PEM, "utf8").toString("hex");
    expect(decodeKeychainValue(hexed)).toBe(PEM);
  });

  test("genuine secrets that merely look hexish pass through untouched", () => {
    const plaidish = "9a1f0c2b8d4e6f7a3c5b1d9e8f0a2c4b"; // decodes to binary junk, no newline
    expect(decodeKeychainValue(plaidish)).toBe(plaidish);
    expect(decodeKeychainValue("deadbeef")).toBe("deadbeef"); // too short to consider
    expect(decodeKeychainValue("not-hex-at-all")).toBe("not-hex-at-all");
  });
});
