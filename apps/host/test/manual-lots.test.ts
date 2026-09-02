// Issue #62: institutions that report no lots (Kraken with a funds-only
// key, watch-only wallets) accept operator-added lots -- guarded so they
// never sum past the position, filling the position's basis only when
// they cover it entirely, and surviving every fetch.
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { SnapshotAccount } from "@fin/contracts";
import { fixtureAdapter } from "@fin/institutions";
import type { InferenceSource } from "@intx/types/runtime";

import { createApp } from "../src/app";

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "fin-mlots-"));
const stubSource = (): InferenceSource => ({ id: "stub", provider: "anthropic", baseURL: "http://localhost:1", apiKey: "stub", model: "stub" });

function kraken(now: Date): SnapshotAccount {
  return {
    account_id: "acct.kraken.kraken",
    name: "Kraken",
    type: "crypto",
    currency: "USD",
    as_of: now.toISOString(),
    balances: [{ balance_type: "total", amount: "40000" }],
    // No lots field at all: exactly what the Kraken adapter delivers.
    positions: [{ instrument: { symbol: "ETH", asset_class: "crypto" }, quantity: "16", price: "2500", market_value: "40000", cost_basis: null }],
    transactions: [],
  };
}

describe("operator-added lots", () => {
  test("added lots are badged and guarded; the position basis fills only at full coverage; fetches leave them alone", async () => {
    const dataDir = tmp();
    const app = createApp({ dataDir, adapters: [fixtureAdapter("inst.kraken", { accounts: [kraken(new Date())] })], pollMs: 20, inferenceSource: stubSource, historicSpot: async () => null });
    try {
      expect((await app.runNightly({ runId: "n1" })).terminalStatus).toBe("completed");
      expect(await app.lotsFor("acct.kraken.kraken", "ETH")).toHaveLength(0);
      // Partial coverage: the lot lands, the position basis stays honest.
      const first = app.addLot({ accountId: "acct.kraken.kraken", symbol: "ETH", quantity: "10", acquiredAt: "May 1 2021", costBasis: "$25,000" });
      expect(first.lot).toMatchObject({ quantity: "10", acquired_at: "2021-05-01", cost_basis: "25000.00", basis_known: true, basis_source: "operator" });
      let pos = app.ledger.asOf({ kind: "position", subject: "acct.kraken.kraken", key: "ETH" })[0]!.payload as { cost_basis: string | null };
      expect(pos.cost_basis).toBeNull();
      // Full coverage: 10 + 6 = 16 -> the position basis is the lots' sum.
      app.addLot({ accountId: "acct.kraken.kraken", symbol: "ETH", quantity: "6", acquiredAt: "2022-05-01", costBasis: "9000" });
      pos = app.ledger.asOf({ kind: "position", subject: "acct.kraken.kraken", key: "ETH" })[0]!.payload as { cost_basis: string | null };
      expect(pos).toMatchObject({ cost_basis: "34000.00", basis_known: true });
      // Over-allocation is refused in plain words.
      expect(() => app.addLot({ accountId: "acct.kraken.kraken", symbol: "ETH", quantity: "1", acquiredAt: "2023-01-01", costBasis: "100" })).toThrow(/position holds 16/);
      // No such position either.
      expect(() => app.addLot({ accountId: "acct.kraken.kraken", symbol: "DOGE", quantity: "1", acquiredAt: "2023-01-01", costBasis: "100" })).toThrow(/no DOGE position/);
      // The next fetch (still lot-less) neither deletes the lots nor unknows the basis.
      expect((await app.runNightly({ runId: "n2" })).terminalStatus).toBe("completed");
      const lots = await app.lotsFor("acct.kraken.kraken", "ETH");
      expect(lots.map((l) => `${l.quantity}@${l.acquired_at}`).sort()).toEqual(["10@2021-05-01", "6@2022-05-01"]);
      pos = app.ledger.asOf({ kind: "position", subject: "acct.kraken.kraken", key: "ETH" })[0]!.payload as { cost_basis: string | null };
      expect(pos).toMatchObject({ cost_basis: "34000.00", basis_known: true });
      expect(app.ledger.listJournal(10).some((j) => j.summary.includes("added by the operator") && j.summary.includes("10 ETH"))).toBe(true);
    } finally {
      app.close();
    }
  });
});
