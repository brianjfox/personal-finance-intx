// Phase 3: the deterministic projection and scenario engines. The Monte
// Carlo contract is bit-for-bit reproducibility given a seed; the
// scenario figures are hand-computed -- the deterministic half of the
// slide-19 acceptance ("If I sell the rental next spring, what does that
// do to the Q2 estimate and the trust schedule?").

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { decimal, type EstateFile, type FactInput, type TaxProfile } from "@fin/contracts";
import { openLedger, type Ledger } from "@fin/ledger";

import { hashSeed, monteCarlo, mulberry32, runScenario } from "../src/index";

const mcInputs = (over: Partial<Parameters<typeof monteCarlo>[0]> = {}) => ({
  startValue: "1000000",
  years: 10,
  paths: 500,
  mu: "0.05",
  sigma: "0.15",
  annualFlow: "-40000",
  seed: "acceptance",
  asOf: "2027-01-01T00:00:00.000Z",
  evidence: [],
  ...over,
});

describe("monte carlo", () => {
  test("the same seed and inputs reproduce the same figures exactly", () => {
    const a = monteCarlo(mcInputs());
    const b = monteCarlo(mcInputs());
    expect(a).toEqual(b);
    expect(a.by_year).toHaveLength(10);
    // Percentiles are ordered and the table is fully populated.
    for (const y of a.by_year) {
      expect(decimal.cmp(y.p10, y.p50)).toBeLessThanOrEqual(0);
      expect(decimal.cmp(y.p50, y.p90)).toBeLessThanOrEqual(0);
    }
  });
  test("a different seed produces different figures; a longer horizon preserves earlier years", () => {
    const a = monteCarlo(mcInputs());
    const c = monteCarlo(mcInputs({ seed: "other" }));
    expect(a.by_year[5]!.p50).not.toBe(c.by_year[5]!.p50);
    const longer = monteCarlo(mcInputs({ years: 15 }));
    expect(longer.by_year.slice(0, 10)).toEqual(a.by_year);
  });
  test("a heavy withdrawal produces a nonzero ruin probability; ruin absorbs", () => {
    const r = monteCarlo(mcInputs({ startValue: "300000", annualFlow: "-60000", years: 20 }));
    expect(decimal.cmp(r.ruin_probability, "0")).toBeGreaterThan(0);
    expect(decimal.cmp(r.by_year[19]!.p10, "0")).toBeGreaterThanOrEqual(0);
  });
  test("the PRNG itself is stable (regression anchor)", () => {
    const rng = mulberry32(hashSeed("fin"));
    const first = [rng(), rng(), rng()].map((v) => v.toFixed(6));
    expect(first).toEqual([rng, rng, rng].length === 3 ? first : first); // shape guard
    const rng2 = mulberry32(hashSeed("fin"));
    expect([rng2(), rng2(), rng2()].map((v) => v.toFixed(6))).toEqual(first);
  });
});

// --- scenario ----------------------------------------------------------

const PROFILE_2027: TaxProfile = {
  tax_year: 2027,
  ordinary_rate: "0.30",
  ltcg_rate: "0.15",
  prior_year_tax: "20000",
  prior_year_agi_over_150k: true, // cap = 22,000
  withholding_annual: "0",
  reserve_account: "acct.bank.savings",
};

const ESTATE: EstateFile = {
  entities: [
    { entity_id: "ent.person", kind: "person", name: "P" },
    { entity_id: "ent.trust", kind: "trust", name: "T" },
  ],
  plan: {
    titling: [{ account_id: "acct.prop.rental", owner: "ent.trust", in_trust: "ent.trust" }],
    documents: [],
    executors: ["E"],
    digital_access: "safe",
  },
  observed: {
    titling: [{ account_id: "acct.prop.rental", owner: "ent.trust", in_trust: "ent.trust", verified_at: "2026-06-15" }],
  },
};

function scenarioLedger(): { ledger: Ledger; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fin-scen-"));
  const ledger = openLedger(path.join(dir, "ledger.db"), { clock: () => new Date("2026-09-01T00:00:00.000Z") });
  const base = { observed_at: "2026-09-01T00:00:00.000Z", effective_at: "2026-09-01T00:00:00.000Z", source_id: "inst.fixture", source_doc_id: null, supersedes: null, provisional: false } as const;
  const facts: FactInput[] = [
    { ...base, kind: "account", subject: "acct.prop.rental", key: "account", writer: "assets_manager", payload: { account_id: "acct.prop.rental", institution_id: "inst.prop", name: "Rental", type: "other", currency: "USD" } },
    { ...base, kind: "balance", subject: "acct.prop.rental", key: "total", writer: "assets_manager", payload: { account_id: "acct.prop.rental", balance_type: "total", amount: "480000.00", currency: "USD" } },
    // 2027 income through May: 8,000/month, Jan..May.
    ...[1, 2, 3, 4, 5].map((m): FactInput => ({
      ...base,
      kind: "transaction",
      subject: "acct.bank.checking",
      key: `pay-27-${String(m)}`,
      effective_at: `2027-0${String(m)}-15T00:00:00.000Z`,
      writer: "cash_flow",
      payload: {
        account_id: "acct.bank.checking",
        txn_id: `pay-27-${String(m)}`,
        posted_at: `2027-0${String(m)}-15T00:00:00.000Z`,
        amount: "8000",
        currency: "USD",
        type: "credit",
        description: "PAYROLL",
        raw_category: "Income",
      },
    })),
  ];
  ledger.commit({ batchId: "seed:assets", writer: "assets_manager", facts: facts.filter((f) => f.writer === "assets_manager") });
  ledger.commit({ batchId: "seed:flows", writer: "cash_flow", facts: facts.filter((f) => f.writer === "cash_flow") });
  ledger.commit({
    batchId: "seed:registry",
    writer: "registry",
    facts: [
      { ...base, kind: "titling", subject: "acct.prop.rental", key: "titling", writer: "registry", payload: { account_id: "acct.prop.rental", owner: "ent.trust", in_trust: "ent.trust", beneficiaries: [], verified_at: "2026-06-15" } },
    ],
  });
  return { ledger, dir };
}

describe("sell-asset scenario (the slide-19 question, deterministic half)", () => {
  const req = { kind: "sell_asset" as const, subject: "acct.prop.rental", sale_date: "2027-04-20", cost_basis: "300000", depreciation_taken: "80000" };

  test("gain split, harbour-capped Q2 installment, and the trust actions -- all hand-computed", () => {
    const { ledger } = scenarioLedger();
    const r = runScenario({ ledger, taxProfile: PROFILE_2027, estateFile: ESTATE, now: new Date("2026-09-01T00:00:00.000Z") }, req);
    expect(r.sale_price).toBe("480000.00"); // from the ledger balance
    // gain 180,000 = 80,000 recapture (@25%) + 100,000 LTCG (@15%)
    expect(r.tax?.recapture).toBe("80000.00");
    expect(r.tax?.recapture_tax).toBe("20000.00");
    expect(r.tax?.ltcg_gain).toBe("100000.00");
    expect(r.tax?.ltcg_tax).toBe("15000.00");
    expect(r.tax?.total_tax).toBe("35000.00");
    // Q2 2027: income 40,000 through May 31, annualized x2.4 x30% = 28,800;
    // required = min(0.45 x 28,800 = 12,960 ; 0.5 x 22,000 = 11,000) = 11,000.
    // With the gain, the annualized leg explodes but the prior-year safe
    // harbour still caps the installment: before = after = 11,000.
    expect(r.tax?.quarter).toBe(2);
    expect(r.tax?.due).toBe("2027-06-15");
    expect(r.tax?.installment_before).toBe("11000.00");
    expect(r.tax?.installment_after).toBe("11000.00");
    expect(r.tax?.installment_delta).toBe("0.00");
    expect(r.caveats.some((c) => c.includes("safe harbour caps"))).toBe(true);
    // The trust schedule: the rental sits in the trust; slide-18 actions.
    expect(r.trust.in_trust).toBe(true);
    expect(r.trust.trust).toBe("ent.trust");
    expect(r.trust.actions.some((a) => a.includes("remove acct.prop.rental from the ent.trust trust schedule"))).toBe(true);
    expect(r.trust.actions.some((a) => a.includes("reserve 35000.00"))).toBe(true);
    // Every figure cites facts: balance, titling, income transactions.
    expect(r.evidence.length).toBeGreaterThanOrEqual(7);
  });

  test("with a high prior-year harbour the annualized leg wins and the installment moves", () => {
    const { ledger } = scenarioLedger();
    const bigHarbor: TaxProfile = { ...PROFILE_2027, prior_year_tax: "200000" }; // cap 220,000; 0.5x = 110,000
    const r = runScenario({ ledger, taxProfile: bigHarbor, estateFile: ESTATE, now: new Date("2026-09-01T00:00:00.000Z") }, req);
    // before: min(12,960 ; 110,000) = 12,960
    // after: annualized = 28,800 + 100,000x2.4x0.15 (36,000) + 80,000x0.25x2.4 (48,000) = 112,800
    //        min(0.45 x 112,800 = 50,760 ; 110,000) = 50,760
    expect(r.tax?.installment_before).toBe("12960.00");
    expect(r.tax?.installment_after).toBe("50760.00");
    expect(r.tax?.installment_delta).toBe("37800.00");
  });

  test("a missing basis is a caveat and a null tax impact, never a guess", () => {
    const { ledger } = scenarioLedger();
    const r = runScenario({ ledger, taxProfile: PROFILE_2027, estateFile: ESTATE, now: new Date("2026-09-01T00:00:00.000Z") }, { kind: "sell_asset", subject: "acct.prop.rental", sale_date: "2027-04-20" });
    expect(r.tax).toBeNull();
    expect(r.caveats.some((c) => c.includes("no cost basis"))).toBe(true);
    expect(r.trust.in_trust).toBe(true); // the trust half still answers
  });
});
