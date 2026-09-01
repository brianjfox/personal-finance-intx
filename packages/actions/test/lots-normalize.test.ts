// Lots reported by an adapter (issue #53): a lot that vanished is
// superseded at quantity 0, a changed lot gets a new fact, an unchanged
// lot writes nothing.
import { describe, expect, test } from "bun:test";

import type { LotPayload } from "@fin/contracts";
import type { SnapshotLot as SnapshotLotSchema } from "@fin/contracts";
type SnapshotLot = typeof SnapshotLotSchema.infer;
import { openLedger } from "@fin/ledger";

import { brokerage, runNight, snap } from "./helpers";

const AT1 = "2026-08-22T00:00:00.000Z";
const AT2 = "2026-08-23T00:00:00.000Z";
function night(ledger: ReturnType<typeof openLedger>, key: string, at: string, lots: SnapshotLot[], quantity: string) {
  return runNight(
    ledger,
    key,
    { snapshots: [snap("inst.cb", at, [brokerage("acct.cb.coinbase", at, { positions: [{ instrument: { symbol: "BTC", asset_class: "crypto" }, quantity, price: "60000", market_value: "0", cost_basis: null, lots }] })])], failures: [] },
    at,
  );
}
const lotsOf = (ledger: ReturnType<typeof openLedger>) =>
  ledger
    .asOf({ kind: "lot", subject: "acct.cb.coinbase" })
    .map((f) => ({ key: f.key, id: f.id, q: (f.payload as LotPayload).quantity, basis: (f.payload as LotPayload).cost_basis }))
    .sort((a, b) => a.key.localeCompare(b.key));

describe("lots through normalize", () => {
  test("vanished lots close at 0, changed lots re-emit, unchanged lots keep their fact", () => {
    const ledger = openLedger(":memory:");
    const n1 = night(ledger, "n1", AT1, [
      { lot_id: "cb:a", quantity: "1", acquired_at: "2024-01-01", cost_basis: "40000" },
      { lot_id: "cb:b", quantity: "2", acquired_at: "2024-06-01", cost_basis: "120000" },
      { lot_id: "cb:t", quantity: "3", acquired_at: "2023-11-03", cost_basis: null, transferred_in: true },
    ], "6");
    n1.commit();
    const before = lotsOf(ledger);
    expect(before.map((l) => `${l.key}:${l.q}`)).toEqual(["cb:a:1", "cb:b:2", "cb:t:3"]);
    // Night 2: lot a fully sold (vanishes), b partly sold (changes), t untouched.
    const n2 = night(ledger, "n2", AT2, [
      { lot_id: "cb:b", quantity: "1.5", acquired_at: "2024-06-01", cost_basis: "90000" },
      { lot_id: "cb:t", quantity: "3", acquired_at: "2023-11-03", cost_basis: null, transferred_in: true },
    ], "4.5");
    const lotFacts = n2.norm.facts.filter((f) => f.fact.kind === "lot").map((f) => `${f.fact.key}:${(f.fact.payload as LotPayload).quantity}`);
    expect(lotFacts.sort()).toEqual(["cb:a:0", "cb:b:1.5"]); // nothing for the unchanged t
    n2.commit();
    const after = lotsOf(ledger);
    expect(after.map((l) => `${l.key}:${l.q}:${l.basis ?? "null"}`)).toEqual(["cb:a:0:40000", "cb:b:1.5:90000", "cb:t:3:null"]);
    expect(after.find((l) => l.key === "cb:t")!.id).toBe(before.find((l) => l.key === "cb:t")!.id);
  });
});
