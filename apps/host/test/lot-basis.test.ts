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
    const app = createApp({ dataDir, adapters: [fixtureAdapter("inst.cb", { accounts: [account(new Date())] })], pollMs: 20, inferenceSource: stubSource });
    try {
      expect((await app.runNightly({ runId: "n1" })).terminalStatus).toBe("completed");
      const before = await app.lotsFor("acct.cb.coinbase", "BTC");
      expect(before).toHaveLength(1);
      expect(before[0]).toMatchObject({ lot_id: "cb:t", basis_known: false, basis_source: null, transferred_in: true });
      // The default the operator sees: the lot's value on the transfer date.
      expect(before[0]!.suggested).toEqual({ amount: "68000", source: "its value on the day it arrived" });
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
});
