// FIFO lots from a Coinbase transaction history (issue #53).
import { describe, expect, test } from "bun:test";

import { deriveCoinbaseLots, type CoinbaseTxn } from "../src/coinbase-lots";

const fill = (id: string, at: string, amount: string, native: string, commission: string, product = "BTC-USD", status = "completed"): CoinbaseTxn => ({
  id,
  type: "advanced_trade_fill",
  status,
  created_at: at,
  amount: { amount, currency: "BTC" },
  native_amount: { amount: native, currency: "USD" },
  advanced_trade_fill: { commission, fill_price: "x", product_id: product, order_side: amount.startsWith("-") ? "sell" : "buy" },
});
const txn = (id: string, type: string, at: string, amount: string, native: string): CoinbaseTxn => ({ id, type, status: "completed", created_at: at, amount: { amount, currency: "BTC" }, native_amount: { amount: native, currency: "USD" } });

describe("deriveCoinbaseLots", () => {
  test("buys open lots with basis = notional + dollar commission; a sell consumes FIFO, scaling the remaining basis by unit cost", () => {
    const d = deriveCoinbaseLots([
      fill("b2", "2025-03-01T00:00:00Z", "1", "60000", "60"), // out of order on purpose
      fill("b1", "2024-01-11T00:00:00Z", "2", "80000", "80"),
      fill("s1", "2025-06-01T00:00:00Z", "-2.5", "-200000", "200"),
    ]);
    expect(d.net).toBe("0.5");
    expect(d.shortfall).toBe("0");
    expect(d.counted).toEqual({ advanced_trade_fill: 3 });
    // b1 (2 @ 40,040/unit) fully consumed, then 0.5 of b2 (1 @ 60,060/unit): 0.5 left, basis 30,030.
    expect(d.lots).toEqual([{ lot_id: "cb:b2", quantity: "0.5", acquired_at: "2025-03-01", cost_basis: "30030.00", transferred_in: false }]);
  });

  test("transfers in are lots without a basis; income arrivals carry fair value; a crypto-quoted commission is not added", () => {
    const d = deriveCoinbaseLots([
      txn("d1", "exchange_deposit", "2023-11-03T00:00:00Z", "10", "300000"), // Pro migration: value on arrival, NOT basis
      txn("r1", "staking_reward", "2024-02-01T00:00:00Z", "0.1", "5000"),
      fill("x1", "2024-03-01T00:00:00Z", "1", "65000", "0.01", "BTC-ETH"),
      { id: "buy1", type: "buy", status: "completed", created_at: "2024-04-01T00:00:00Z", amount: { amount: "0.5", currency: "BTC" }, native_amount: { amount: "31000", currency: "USD" }, buy: { total: { amount: "31500", currency: "USD" }, fee: { amount: "500", currency: "USD" } } },
    ]);
    expect(d.lots).toEqual([
      { lot_id: "cb:d1", quantity: "10", acquired_at: "2023-11-03", cost_basis: null, transferred_in: true },
      { lot_id: "cb:r1", quantity: "0.1", acquired_at: "2024-02-01", cost_basis: "5000.00", transferred_in: false },
      { lot_id: "cb:x1", quantity: "1", acquired_at: "2024-03-01", cost_basis: "65000.00", transferred_in: false },
      { lot_id: "cb:buy1", quantity: "0.5", acquired_at: "2024-04-01", cost_basis: "31500.00", transferred_in: false },
    ]);
  });

  test("outflows the record cannot cover are a shortfall; pending and zero rows are ignored", () => {
    const d = deriveCoinbaseLots([
      fill("b1", "2024-01-01T00:00:00Z", "1", "40000", "0"),
      fill("p", "2024-01-02T00:00:00Z", "5", "1", "0", "BTC-USD", "pending"),
      txn("z", "send", "2024-01-03T00:00:00Z", "0", "0"),
      txn("s", "send", "2024-02-01T00:00:00Z", "-1.25", "-50000"),
    ]);
    expect(d.lots).toEqual([]);
    expect(d.net).toBe("-0.25");
    expect(d.shortfall).toBe("0.25");
    expect(d.counted).toEqual({ advanced_trade_fill: 1, send: 1 });
  });
});
