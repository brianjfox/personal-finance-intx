// The drift engine's candidate sizing (issue #48): a SELL is capped at
// the whole units the chosen position holds, even when the class's
// excess is larger than that position.

import { describe, expect, test } from "bun:test";

import type { InvestmentPlan, LotPayload, PositionPayload } from "@fin/contracts";
import type { StoredFact } from "@fin/ledger";

import { computeDrift } from "../src/market/drift";

let seq = 0;
function position(subject: string, symbol: string, asset_class: PositionPayload["instrument"]["asset_class"], quantity: string, price: string): StoredFact {
  seq += 1;
  const market_value = String(Number(quantity) * Number(price));
  return {
    id: `fact_${String(seq).padStart(4, "0")}`,
    batch_id: "b",
    seq,
    kind: "position",
    subject,
    key: symbol,
    payload: { account_id: subject, instrument: { symbol, asset_class }, quantity, price, market_value, currency: "USD", cost_basis: null, basis_known: false } satisfies PositionPayload,
    observed_at: "2026-09-01T00:00:00.000Z",
    effective_at: "2026-09-01T00:00:00.000Z",
    source_id: "test",
    source_doc_id: null,
    page: null,
    supersedes: null,
    writer: "assets_manager",
    provisional: false,
  };
}

const PLAN: InvestmentPlan = {
  as_of: "2026-09-01",
  band: "0.05",
  targets: [
    { asset_class: "etf", weight: "0.5" },
    { asset_class: "bond", weight: "0.2" },
    { asset_class: "crypto", weight: "0.3" },
  ],
  constraints: {},
};

describe("computeDrift SELL sizing", () => {
  test("a SELL never exceeds the chosen position's whole units when the class excess is larger than it (#48)", () => {
    // Crypto is 100% of the portfolio: BTC 83.81 @ 78,840 (6.6M) plus ETH 1,500 @ 3,000 (4.5M).
    // Excess = 70% of 11.1M = 7.77M -> 98 BTC by value; only 83 whole BTC are held.
    const report = computeDrift({
      runKey: "t",
      now: new Date("2026-09-01T12:00:00.000Z"),
      plan: PLAN,
      positions: [position("acct.coinbase", "BTC", "crypto", "83.811189944", "78840.02"), position("acct.wallet", "ETH", "crypto", "1500", "3000")],
      lots: [],
    });
    const sell = report.candidates.find((c) => c.side === "SELL");
    expect(sell).toMatchObject({ account: "acct.coinbase", symbol: "BTC", quantity: "83" });
    expect(sell!.est_value).toBe("6543721.66");
    expect(sell!.rationale).toContain("capped at the 83 BTC held in this position");
  });

  test("an excess smaller than the position is sized by value, uncapped", () => {
    // Equity 60k of 100k invested vs target 30%: excess 30k -> SELL 100 @ 300, of 200 held.
    const report = computeDrift({
      runKey: "t",
      now: new Date("2026-09-01T12:00:00.000Z"),
      plan: { ...PLAN, targets: [{ asset_class: "equity", weight: "0.3" }, { asset_class: "bond", weight: "0.7" }] },
      positions: [position("acct.broker", "AAPL", "equity", "200", "300"), position("acct.broker", "BND", "bond", "400", "100")],
      lots: [],
    });
    const sell = report.candidates.find((c) => c.side === "SELL")!;
    expect(sell).toMatchObject({ symbol: "AAPL", quantity: "100", est_value: "30000.00" });
    expect(sell.rationale).not.toContain("capped");
  });
});

function lot(subject: string, symbol: string, lot_id: string, quantity: string, acquired_at: string, cost_basis: string | null): StoredFact {
  seq += 1;
  return {
    id: `fact_${String(seq).padStart(4, "0")}`,
    batch_id: "b",
    seq,
    kind: "lot",
    subject,
    key: lot_id,
    payload: { account_id: subject, lot_id, instrument: { symbol, asset_class: "crypto" }, quantity, acquired_at, cost_basis, basis_known: cost_basis !== null, transferred_in: cost_basis === null, currency: "USD" } satisfies LotPayload,
    observed_at: "2026-09-01T00:00:00.000Z",
    effective_at: "2026-09-01T00:00:00.000Z",
    source_id: "test",
    source_doc_id: null,
    page: null,
    supersedes: null,
    writer: "assets_manager",
    provisional: false,
  };
}

describe("computeDrift SELL lot treatments (#53)", () => {
  test("FIFO skips consumed (zero) lots; a known long-term lot is LTCG, a known recent lot STCG, a transferred-in lot unknown", () => {
    const report = computeDrift({
      runKey: "t",
      now: new Date("2026-09-01T12:00:00.000Z"),
      plan: { ...PLAN, targets: [{ asset_class: "crypto", weight: "0.1" }, { asset_class: "bond", weight: "0.9" }] },
      positions: [position("acct.cb", "BTC", "crypto", "4", "100000"), position("acct.b", "BND", "bond", "100", "100")],
      lots: [
        lot("acct.cb", "BTC", "cb:sold", "0", "2023-01-01", "10000"),
        lot("acct.cb", "BTC", "cb:old", "1", "2024-01-11", "40000"),
        lot("acct.cb", "BTC", "cb:new", "1", "2026-06-01", "100000"),
        lot("acct.cb", "BTC", "cb:moved", "2", "2023-11-03", null),
      ],
    });
    const sell = report.candidates.find((c) => c.side === "SELL")!;
    expect(sell).toMatchObject({ symbol: "BTC", quantity: "3" });
    // Oldest first by acquisition date: moved (2023-11-03, unknown basis), old (LTCG), new (STCG).
    expect(sell.tax_lots).toEqual([
      { lot_id: "cb:moved", treatment: "unknown" },
      { lot_id: "cb:old", treatment: "LTCG" },
    ]);
  });
});

describe("computeDrift cash (#55)", () => {
  test("cash on hand adds to cash_value and the portfolio, never to the class weights; excluded currencies ride along", () => {
    const report = computeDrift({
      runKey: "t",
      now: new Date("2026-09-01T12:00:00.000Z"),
      plan: PLAN,
      positions: [position("acct.cb", "BTC", "crypto", "1", "100000"), position("acct.b", "CASH", "cash", "5000", "1")],
      lots: [],
      cash: { amount: "243169.70", excluded: [{ currency: "EUR", amount: "62565.41" }], evidence: ["fact_bal1", "fact_bal2"] },
    });
    expect(report.cash_value).toBe("248169.70");
    expect(report.portfolio_value).toBe("348169.70");
    expect(report.cash_excluded).toEqual([{ currency: "EUR", amount: "62565.41" }]);
    expect(report.by_class.find((l) => l.asset_class === "crypto")?.weight).toBe("1.0000");
    expect(report.evidence).toContain("fact_bal1");
  });
});

