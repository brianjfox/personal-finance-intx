// FIFO lots from Kraken's account ledger (issue #64).
import { describe, expect, test } from "bun:test";

import { deriveKrakenLots, normalizeKrakenAsset, type KrakenLedgerEntry } from "../src";

let n = 0;
const e = (time: number, type: string, asset: string, amount: string, fee = "0", refid?: string, subtype = ""): KrakenLedgerEntry => {
  n += 1;
  return { id: `L${String(n).padStart(3, "0")}${String(time)}`, refid: refid ?? `R${String(n)}`, time, type, subtype, asset, amount, fee };
};

describe("deriveKrakenLots", () => {
  test("a fiat-quoted trade pairs by refid: basis = |fiat leg| + fiat fee; an asset-side fee reduces the lot", () => {
    const d = deriveKrakenLots(
      [e(100, "trade", "XXBT", "1.001", "0.001", "T1"), e(100, "trade", "ZUSD", "-40000", "80", "T1")],
      normalizeKrakenAsset,
    );
    expect(d.get("BTC")!.lots).toEqual([{ lot_id: "kr:L001100", quantity: "1", acquired_at: "1970-01-01", cost_basis: "40080.00", transferred_in: false }]);
    expect(d.get("USD")!.net).toBe("-40080");
  });

  test("crypto-to-crypto trades and staking open unknown-basis lots (staking net of its fee); deposits are transferred in", () => {
    const d = deriveKrakenLots(
      [
        e(1610579901, "deposit", "XETH", "121.99"),
        e(1638003711, "trade", "XETH", "3.4665839400", "0.0048532200", "TX"),
        e(1638003711, "trade", "DOT", "-403.1380319500", "0", "TX"),
        e(1788081845, "staking", "XETH", "0.0040580125", "0.0012174037"),
      ],
      normalizeKrakenAsset,
    );
    const eth = d.get("ETH")!;
    expect(eth.lots.map((l) => ({ q: l.quantity, basis: l.cost_basis, t: l.transferred_in, at: l.acquired_at }))).toEqual([
      { q: "121.99", basis: null, t: true, at: "2021-01-13" },
      { q: "3.46173072", basis: null, t: false, at: "2021-11-27" },
      { q: "0.0028406088", basis: null, t: false, at: "2026-08-30" },
    ]);
    expect(d.get("DOT")!.shortfall).toBe("403.13803195"); // nothing recorded bought the DOT
  });

  test("internal spot<->staking transfers are skipped so real lots survive; withdrawals consume amount + fee", () => {
    const d = deriveKrakenLots(
      [
        e(100, "trade", "DOT", "10000", "0", "T1"),
        e(100, "trade", "ZUSD", "-35000", "0", "T1"),
        e(200, "transfer", "DOT", "-10000", "0", "F1", "spottostaking"),
        e(201, "transfer", "DOT.S", "10000", "0", "F2", "stakingfromspot"),
        e(300, "withdrawal", "DOT.S", "-6500", "0.05", "W1"),
      ],
      normalizeKrakenAsset,
    );
    const dot = d.get("DOT")!;
    expect(dot.net).toBe("3499.95");
    expect(dot.shortfall).toBe("0");
    expect(dot.lots).toEqual([{ lot_id: expect.stringMatching(/^kr:/), quantity: "3499.95", acquired_at: "1970-01-01", cost_basis: "12249.83", transferred_in: false }]);
  });
});
