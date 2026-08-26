import { describe, expect, test } from "bun:test";
import { type } from "arktype";

import {
  Approval,
  decimal,
  Fact,
  FACT_KINDS,
  FACT_WRITERS,
  Finding,
  InstitutionSnapshot,
  Instruction,
  newId,
  PRINCIPALS,
  Receipt,
  Recommendation,
  tierOf,
  validateFactPayload,
} from "../src/index";

const NOW = "2026-08-23T10:00:00.000Z";
const prov = { source_id: "inst.demo", source_doc_id: null, observed_at: NOW };

describe("six message types", () => {
  test("a Fact requires id, as-of dates, provenance and a writer", () => {
    const ok = Fact({
      id: "fact_1",
      kind: "balance",
      subject: "acct.demo.checking",
      key: "total",
      payload: { account_id: "acct.demo.checking", balance_type: "total", amount: "10.00", currency: "USD" },
      observed_at: NOW,
      effective_at: NOW,
      source_id: "inst.demo",
      source_doc_id: null,
      supersedes: null,
      writer: "assets_manager",
      provisional: false,
    });
    expect(ok).not.toBeInstanceOf(type.errors);
    const missing = Fact({ id: "fact_1", kind: "balance" });
    expect(missing).toBeInstanceOf(type.errors);
  });

  test("every fact kind has exactly one writer and a payload schema", () => {
    for (const kind of FACT_KINDS) {
      expect(PRINCIPALS).toContain(FACT_WRITERS[kind]);
      expect(tierOf(FACT_WRITERS[kind])).toBe("ledger");
      expect(validateFactPayload(kind, {})).toBeInstanceOf(type.errors);
    }
  });

  test("cost basis may be null but not a number, and amounts are decimal strings", () => {
    const bad = validateFactPayload("position", {
      account_id: "acct.x",
      instrument: { symbol: "VTI", asset_class: "etf" },
      quantity: 10,
      currency: "USD",
      cost_basis: 0,
      basis_known: false,
    });
    expect(bad).toBeInstanceOf(type.errors);
    const ok = validateFactPayload("position", {
      account_id: "acct.x",
      instrument: { symbol: "VTI", asset_class: "etf" },
      quantity: "10",
      currency: "USD",
      cost_basis: null,
      basis_known: false,
    });
    expect(ok).not.toBeInstanceOf(type.errors);
  });

  test("Finding carries severity, evidence, and both versions", () => {
    const f = Finding({
      id: "fnd_1",
      kind: "break",
      code: "duplicate_transaction",
      severity: "high",
      subject: "acct.demo.checking",
      summary: "x",
      detail: {},
      evidence: ["fact_1"],
      before: ["fact_1"],
      after: ["fact_2"],
      requires_human: true,
      emitted_by: "reconciliation",
      as_of: NOW,
      provenance: prov,
    });
    expect(f).not.toBeInstanceOf(type.errors);
  });

  test("Recommendation refuses empty evidence and requires an expiry", () => {
    const base = {
      id: "rec_1",
      from: "market_manager",
      subject: "acct.brokerage.taxable",
      action: { verb: "SELL", instrument: "VTI", quantity: "40" },
      thesis: "equity 6.2% over target",
      as_of: NOW,
      confidence: 0.71,
      requires: ["auditor.review", "human.approve"],
      expires: "2026-08-26T00:00:00.000Z",
      provenance: prov,
    };
    expect(Recommendation({ ...base, evidence: [] })).toBeInstanceOf(type.errors);
    expect(Recommendation({ ...base, evidence: ["fact_881"] })).not.toBeInstanceOf(type.errors);
    const { expires: _e, ...noExpiry } = { ...base, evidence: ["fact_881"] };
    expect(Recommendation(noExpiry)).toBeInstanceOf(type.errors);
  });

  test("Approval, Instruction, Receipt chain by id", () => {
    const approval = Approval({
      id: "apr_1",
      recommendation_id: "rec_1",
      subject: "acct.brokerage.taxable",
      action: { verb: "SELL", instrument: "VTI", quantity: "40" },
      bound: { max_quantity: "40", limit_price: "250.00" },
      expires: "2026-08-26T00:00:00.000Z",
      signed_by: "operator.brian",
      signed_at: NOW,
      signal_id: "approve:rec_1",
      as_of: NOW,
      provenance: prov,
    });
    expect(approval).not.toBeInstanceOf(type.errors);
    const instr = Instruction({
      id: "ins_1",
      approval_id: "apr_1",
      recommendation_id: "rec_1",
      subject: "acct.brokerage.taxable",
      action: { verb: "SELL" },
      bound: {},
      issued_at: NOW,
      expires: "2026-08-26T00:00:00.000Z",
      status: "prepared",
      as_of: NOW,
      provenance: prov,
    });
    expect(instr).not.toBeInstanceOf(type.errors);
    const rcpt = Receipt({
      id: "rct_1",
      instrument_id: "x",
      instruction_id: "ins_1",
      subject: "acct.brokerage.taxable",
      executed_at: NOW,
      fills: [{ instrument: "VTI", quantity: "40", price: "249.10" }],
      raw: {},
      as_of: NOW,
      provenance: prov,
    });
    expect(rcpt).not.toBeInstanceOf(type.errors);
  });
});

describe("snapshot", () => {
  test("a minimal institution snapshot validates", () => {
    const s = InstitutionSnapshot({
      institution_id: "inst.demo",
      fetched_at: NOW,
      via: "adapter.jsondrop@1",
      raw_document_ids: [],
      accounts: [
        {
          account_id: "acct.demo.checking",
          name: "Checking",
          type: "checking",
          currency: "USD",
          as_of: NOW,
          balances: [{ balance_type: "total", amount: "1234.56" }],
        },
      ],
    });
    expect(s).not.toBeInstanceOf(type.errors);
  });
});

describe("decimal", () => {
  test("exact arithmetic", () => {
    expect(decimal.add("0.1", "0.2")).toBe("0.3");
    expect(decimal.sub("1", "1.0000000001")).toBe("-0.0000000001");
    expect(decimal.mul("40", "249.10")).toBe("9964");
    expect(decimal.sum(["1.5", "-0.5", "2"])).toBe("3");
    expect(decimal.round("2.345", 2)).toBe("2.35");
    expect(decimal.round("-2.345", 2)).toBe("-2.35");
    expect(decimal.cmp("10", "9.99")).toBe(1);
    expect(decimal.formatDecimal(0n, 2)).toBe("0.00");
  });
});

describe("ids", () => {
  test("monotonic within a process, prefixed", () => {
    const a = newId("fact", 1000);
    const b = newId("fact", 1000);
    const c = newId("fact", 1001);
    expect(a < b).toBe(true);
    expect(b < c).toBe(true);
    expect(a.startsWith("fact_")).toBe(true);
  });
});

describe("parseMoneyInput", () => {
  const { parseMoneyInput } = require("../src/money") as typeof import("../src/money");
  const cases: Array<[string, string, string | null]> = [
    ["$1,250,000.50", "1250000.50", "USD"],
    ["€1.250.000,50", "1250000.50", "EUR"],
    ["£12,000", "12000", "GBP"],
    ["¥1500000", "1500000", "JPY"],
    ["CHF 5'000", "5000", "CHF"],
    ["1 250 000,50 €", "1250000.50", "EUR"],
    ["USD 1200", "1200", "USD"],
    ["1200 eur", "1200", "EUR"],
    ["CA$99.95", "99.95", "CAD"],
    ["R$ 2.500,00", "2500.00", "BRL"],
    ["(1,200)", "-1200", "USD"],   // wait: no symbol -> null currency
  ];
  test("symbols, ISO codes, and locale separators", () => {
    for (const [input, amount] of cases.slice(0, 10)) {
      const r = parseMoneyInput(input);
      expect(r?.amount).toBe(amount);
    }
    expect(parseMoneyInput("$1,250,000.50")?.currency).toBe("USD");
    expect(parseMoneyInput("€1.250.000,50")?.currency).toBe("EUR");
    expect(parseMoneyInput("CA$99.95")?.currency).toBe("CAD");
    expect(parseMoneyInput("R$ 2.500,00")?.currency).toBe("BRL");
    expect(parseMoneyInput("1200 eur")?.currency).toBe("EUR");
  });
  test("plain numbers, negatives, ambiguity, and garbage", () => {
    expect(parseMoneyInput("1250000")).toEqual({ amount: "1250000", currency: null });
    expect(parseMoneyInput("1,25")).toEqual({ amount: "1.25", currency: null });
    expect(parseMoneyInput("1.250")).toEqual({ amount: "1250", currency: null }); // exact grouping = thousands
    expect(parseMoneyInput("1250.50")).toEqual({ amount: "1250.50", currency: null });
    expect(parseMoneyInput("(1,200)")).toEqual({ amount: "-1200", currency: null });
    expect(parseMoneyInput("-€500")).toEqual({ amount: "-500", currency: "EUR" });
    expect(parseMoneyInput("5 000 kr")?.amount).toBe("5000");
    expect(parseMoneyInput("5 000 kr")?.currency).toBeNull(); // kr is ambiguous: never guessed
    expect(parseMoneyInput("hello")).toBeNull();
    expect(parseMoneyInput("1,23,45")).toBeNull();
    expect(parseMoneyInput("")).toBeNull();
  });
});

describe("parseDateInput", () => {
  const { parseDateInput } = require("../src/dates") as typeof import("../src/dates");
  test("freeform forms all land on ISO", () => {
    expect(parseDateInput("Jul 30 1959")).toBe("1959-07-30");
    expect(parseDateInput("nov 3 1977")).toBe("1977-11-03"); // lowercase month, as people type
    expect(parseDateInput("July 30, 1959")).toBe("1959-07-30");
    expect(parseDateInput("jul. 30th, 1959")).toBe("1959-07-30");
    expect(parseDateInput("30 Jul 1959")).toBe("1959-07-30");
    expect(parseDateInput("30th of July, 1959")).toBe("1959-07-30");
    expect(parseDateInput("1959-07-30")).toBe("1959-07-30");
    expect(parseDateInput("1959-7-3")).toBe("1959-07-03");
    expect(parseDateInput("7/30/1959")).toBe("1959-07-30"); // US month-first
    expect(parseDateInput("30/7/1959")).toBe("1959-07-30"); // day-first when month-first impossible
    expect(parseDateInput("Nov 2, 2000")).toBe("2000-11-02");
    expect(parseDateInput("November 25 2025")).toBe("2025-11-25");
  });
  test("impossible or unreadable dates refuse", () => {
    expect(parseDateInput("Feb 30 2001")).toBeNull();
    expect(parseDateInput("Feb 29 2024")).toBe("2024-02-29"); // leap
    expect(parseDateInput("Feb 29 2023")).toBeNull();
    expect(parseDateInput("Jul 30")).toBeNull(); // no year: never guessed
    expect(parseDateInput("Smarch 5 1990")).toBeNull();
    expect(parseDateInput("")).toBeNull();
    expect(parseDateInput("soon")).toBeNull();
  });
});
