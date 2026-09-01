// The drift engine's candidate sizing (issue #48): a SELL is capped at
// the whole units the chosen position holds, even when the class's
// excess is larger than that position.

import { describe, expect, test } from "bun:test";

import type { InvestmentPlan, PositionPayload } from "@fin/contracts";
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
