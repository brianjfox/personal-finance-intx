// A freshly connected institution should paint a year of cash flow, not
// 30 days: until the ledger holds more than a month of observed
// transactions for an institution, ingest widens the fetch window.

import { describe, expect, test } from "bun:test";

import { openLedger, type Ledger } from "@fin/ledger";

import { BACKFILL_LOOKBACK_DAYS, backfillLookback } from "../src/ingest/fetch";
import { checking, runNight, snap } from "./helpers";

const NOW = new Date("2026-08-30T06:00:00.000Z");
const iso = (daysAgo: number) => new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString();

function seed(ledger: Ledger, inst: string, acct: string, txnDaysAgo: number[]): void {
  const night = runNight(
    ledger,
    `rk-${inst}`,
    {
      snapshots: [
        snap(inst, iso(0), [
          checking(acct, iso(0), "100", {
            transactions: txnDaysAgo.map((d, i) => ({
              txn_id: `${acct}-t${String(i)}`,
              posted_at: iso(d),
              amount: "-10",
              type: "debit",
              description: "coffee",
            })),
          }),
        ]),
      ],
      failures: [],
    },
    iso(0),
  );
  night.commit();
}

describe("transaction backfill window", () => {
  test("no history at all: ask for the past year", () => {
    const l = openLedger(":memory:");
    expect(backfillLookback(l, "inst.fresh", NOW)).toBe(BACKFILL_LOOKBACK_DAYS);
  });

  test("under a month of history: still backfilling", () => {
    const l = openLedger(":memory:");
    seed(l, "inst.new", "acct.new.checking", [3, 10, 20]);
    expect(backfillLookback(l, "inst.new", NOW)).toBe(BACKFILL_LOOKBACK_DAYS);
  });

  test("more than a month of history: the rolling default takes over", () => {
    const l = openLedger(":memory:");
    seed(l, "inst.old", "acct.old.checking", [3, 45, 90]);
    expect(backfillLookback(l, "inst.old", NOW)).toBeNull();
  });

  test("history depth is judged per institution", () => {
    const l = openLedger(":memory:");
    seed(l, "inst.old", "acct.old.checking", [90]);
    seed(l, "inst.new", "acct.new.checking", [5]);
    expect(backfillLookback(l, "inst.old", NOW)).toBeNull();
    expect(backfillLookback(l, "inst.new", NOW)).toBe(BACKFILL_LOOKBACK_DAYS);
  });
});
