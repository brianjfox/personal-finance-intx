// Issue #57: the operator enters a cost basis for a lot the institution
// could not know; the entry is badged, defaulted to the arrival value,
// journaled, reflected on the position, and it survives the next fetch.
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { LotPayload, SnapshotAccount } from "@fin/contracts";
import { fixtureAdapter } from "@fin/institutions";
import type { InferenceSource } from "@intx/types/runtime";

import { createApp } from "../src/app";

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "fin-lots-"));
const stubSource = (): InferenceSource => ({ id: "stub", provider: "anthropic", baseURL: "http://localhost:1", apiKey: "stub", model: "stub" });

function account(now: Date): SnapshotAccount {
  return {
    account_id: "acct.cb.coinbase",
    name: "Coinbase",
    type: "crypto",
    currency: "USD",
    as_of: now.toISOString(),
    balances: [{ balance_type: "total", amount: "120000" }],
    positions: [
      {
        instrument: { symbol: "BTC", asset_class: "crypto" },
        quantity: "2",
        price: "60000",
        market_value: "120000",
        cost_basis: null,
        lots: [{ lot_id: "cb:t", quantity: "2", acquired_at: "2023-11-03", cost_basis: null, transferred_in: true, value_at_transfer: "68000" }],
      },
    ],
    transactions: [],
  };
}

describe("operator-entered lot basis", () => {
  test("suggested default is the arrival value; the entry is badged, journaled, fills the position, and survives the next fetch", async () => {
    const dataDir = tmp();
    const app = createApp({
      dataDir,
      adapters: [fixtureAdapter("inst.cb", { accounts: [account(new Date())] })],
      pollMs: 20,
      inferenceSource: stubSource,
      // No network in tests: the market price for the arrival date.
      historicSpot: async (sym, date) => (sym === "BTC" && date === "2023-11-03" ? "34250.10" : null),
    });
    try {
      expect((await app.runNightly({ runId: "n1" })).terminalStatus).toBe("completed");
      const before = await app.lotsFor("acct.cb.coinbase", "BTC");
      expect(before).toHaveLength(1);
      expect(before[0]).toMatchObject({ lot_id: "cb:t", basis_known: false, basis_source: null, transferred_in: true });
      // The default the operator sees: the lot's value on the transfer date,
      // and the UNIT price looked up from the provider for that date.
      expect(before[0]!.suggested).toEqual({ amount: "68000", source: "its value on the day it arrived", unit_price: "34250.10", unit_source: "Coinbase" });
      // Enter the real basis (friendly formatting), correcting the date.
      const r = app.setLotBasis({ accountId: "acct.cb.coinbase", lotId: "cb:t", costBasis: "$52,000", acquiredAt: "Feb 1 2020" });
      expect(r.lot).toMatchObject({ cost_basis: "52000.00", basis_known: true, basis_source: "operator", acquired_at: "2020-02-01" });
      const after = await app.lotsFor("acct.cb.coinbase", "BTC");
      expect(after[0]).toMatchObject({ cost_basis: "52000.00", basis_source: "operator", acquired_at: "2020-02-01", suggested: null });
      // The position's own basis filled in at once.
      const pos = app.ledger.asOf({ kind: "position", subject: "acct.cb.coinbase", key: "BTC" })[0]!.payload as { cost_basis: string | null; basis_known: boolean };
      expect(pos).toMatchObject({ cost_basis: "52000.00", basis_known: true });
      expect(app.ledger.listJournal(10).some((j) => j.summary.includes("cost basis of lot cb:t") && j.summary.includes("by the operator"))).toBe(true);
      // The next fetch re-derives the same basis-less lot: the entry survives.
      expect((await app.runNightly({ runId: "n2" })).terminalStatus).toBe("completed");
      const nextNight = await app.lotsFor("acct.cb.coinbase", "BTC");
      expect(nextNight[0]).toMatchObject({ cost_basis: "52000.00", basis_known: true, basis_source: "operator", acquired_at: "2020-02-01" });
      const lotFact = app.ledger.asOf({ kind: "lot", subject: "acct.cb.coinbase", key: "cb:t" })[0]!.payload as LotPayload;
      expect(lotFact.basis_source).toBe("operator");
      // Garbage is refused in plain words.
      expect(() => app.setLotBasis({ accountId: "acct.cb.coinbase", lotId: "cb:t", costBasis: "a lot" })).toThrow(/not an amount/);
    } finally {
      app.close();
    }
  });

  test("same-day fills fold into one row, and one basis entry splits across them by quantity (#103)", async () => {
    const dataDir = tmp();
    const now = new Date();
    const acct: SnapshotAccount = {
      ...account(now),
      balances: [{ balance_type: "total", amount: "90000" }],
      positions: [
        {
          instrument: { symbol: "BTC", asset_class: "crypto" },
          quantity: "1.5",
          price: "60000",
          market_value: "90000",
          cost_basis: null,
          lots: [
            // One order, filled in four pieces on 2023-11-03, each valued on arrival.
            { lot_id: "cb:f1", quantity: "0.25", acquired_at: "2023-11-03", cost_basis: null, transferred_in: true, value_at_transfer: "8500" },
            { lot_id: "cb:f2", quantity: "0.25", acquired_at: "2023-11-03", cost_basis: null, transferred_in: true, value_at_transfer: "8500" },
            { lot_id: "cb:f3", quantity: "0.25", acquired_at: "2023-11-03", cost_basis: null, transferred_in: true, value_at_transfer: "8500" },
            { lot_id: "cb:f4", quantity: "0.25", acquired_at: "2023-11-03", cost_basis: null, transferred_in: true, value_at_transfer: "8500" },
            // A separate, known lot on another day.
            { lot_id: "cb:k", quantity: "0.5", acquired_at: "2024-01-11", cost_basis: "20000" },
          ],
        },
      ],
    };
    const app = createApp({
      dataDir,
      adapters: [fixtureAdapter("inst.cb", { accounts: [acct] })],
      pollMs: 20,
      inferenceSource: stubSource,
      historicSpot: async (sym, date) => (sym === "BTC" && date === "2023-11-03" ? "34250.10" : null),
    });
    try {
      expect((await app.runNightly({ runId: "n1" })).terminalStatus).toBe("completed");
      expect(app.ledger.asOf({ kind: "lot", subject: "acct.cb.coinbase" })).toHaveLength(5); // the ledger keeps every fill
      const rows = await app.lotsFor("acct.cb.coinbase", "BTC");
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({ lot_id: "cb:f1", fills: 4, lot_ids: ["cb:f1", "cb:f2", "cb:f3", "cb:f4"], quantity: "1", acquired_at: "2023-11-03", basis_known: false, value_at_transfer: "34000.00" });
      expect(rows[0]!.suggested).toEqual({ amount: "34000.00", source: "their value on the day they arrived", unit_price: "34250.10", unit_source: "Coinbase" });
      expect(rows[1]).toMatchObject({ lot_id: "cb:k", fills: 1, lot_ids: ["cb:k"], quantity: "0.5", cost_basis: "20000", basis_known: true });

      // $100 over four equal fills does not divide to the cent: 25.00 x 3, and the remainder on the last, so the total is exact.
      const r = app.setLotBasis({ accountId: "acct.cb.coinbase", lotId: "cb:f1", lotIds: ["cb:f1", "cb:f2", "cb:f3", "cb:f4"], costBasis: "$100.01" });
      expect(r.lot).toMatchObject({ lot_id: "cb:f1", fills: 4, quantity: "1", cost_basis: "100.01", basis_known: true, basis_source: "operator" });
      const fills = ["cb:f1", "cb:f2", "cb:f3", "cb:f4"].map((id) => app.ledger.asOf({ kind: "lot", subject: "acct.cb.coinbase", key: id })[0]!.payload as LotPayload);
      expect(fills.map((f) => f.cost_basis)).toEqual(["25.00", "25.00", "25.00", "25.01"]);
      expect(fills.every((f) => f.basis_known && f.basis_source === "operator")).toBe(true);
      // Every lot is known now: the position's own basis fills in, and the list folds the entered fills as one known row.
      const pos = app.ledger.asOf({ kind: "position", subject: "acct.cb.coinbase", key: "BTC" })[0]!.payload as { cost_basis: string | null; basis_known: boolean };
      expect(pos).toMatchObject({ cost_basis: "20100.01", basis_known: true });
      const after = await app.lotsFor("acct.cb.coinbase", "BTC");
      expect(after).toHaveLength(2);
      expect(after[0]).toMatchObject({ fills: 4, cost_basis: "100.01", basis_source: "operator", suggested: null });
      // One journal entry for the order, naming the split.
      const entries = app.ledger.listJournal(10).filter((j) => j.summary.includes("4 fills of BTC acquired 2023-11-03") && j.summary.includes("100.01 USD in total"));
      expect(entries).toHaveLength(1);
      expect(entries[0]!.detail).toMatchObject({ lot_ids: ["cb:f1", "cb:f2", "cb:f3", "cb:f4"], cost_basis: "100.01" });
      // The entries survive the next fetch, fill by fill.
      const n2 = await app.runNightly({ runId: "n2" });
      expect(n2.terminalStatus).toBe("completed");
      const nextNight = await app.lotsFor("acct.cb.coinbase", "BTC");
      expect(nextNight[0]).toMatchObject({ fills: 4, cost_basis: "100.01", basis_source: "operator" });
    } finally {
      app.close();
    }
  });
});
