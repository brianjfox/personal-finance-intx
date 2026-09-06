// Same-instrument transfer legs pair on quantity (issue #99): a coin
// sent from an exchange and received in a household wallet carry
// different USD figures (the exchange's own value vs. the day's spot,
// D-051) and a fee-sized quantity gap, so amount equality never fires.
// Quantity pairing does, within the fee tolerance -- and refuses when the
// gap is too large or the receiver got MORE than was sent.

import { describe, expect, test } from "bun:test";

import { ASOF1, brokerage, freshLedger, NIGHT1, runNight, snap } from "./helpers";

const BTC = { symbol: "BTC", name: "Bitcoin", asset_class: "crypto" as const };

function night(sentQty: string, sentUsd: string, gotQty: string, gotUsd: string, gotSymbol = "BTC", gotType: "transfer_in" | "income" = "transfer_in") {
  const ledger = freshLedger();
  return runNight(
    ledger,
    "n1",
    {
      snapshots: [
        snap("inst.coinbase", NIGHT1, [
          brokerage("acct.coinbase.coinbase", ASOF1, {
            type: "crypto",
            transactions: [{ txn_id: "cb-send", posted_at: "2026-08-20T10:00:00.000Z", amount: sentUsd, type: "transfer_out", description: "Sent Bitcoin — To BTC address", instrument: BTC, quantity: sentQty, raw_category: "send" }],
          }),
        ]),
        snap("inst.ledger", NIGHT1, [
          brokerage("acct.ledger.wallet", ASOF1, {
            type: "crypto",
            transactions: [{ txn_id: "chain-1", posted_at: "2026-08-20T11:30:00.000Z", amount: gotUsd, type: gotType, description: "Received on-chain · valued at the day's spot", instrument: { ...BTC, symbol: gotSymbol }, quantity: gotQty, raw_category: "receive" }],
          }),
        ]),
      ],
      failures: [],
    },
    NIGHT1,
  );
}

const legOf = (n: ReturnType<typeof night>, subject: string) => n.norm.facts.find((f) => f.fact.kind === "transaction" && f.fact.subject === subject)!.fact.payload as { type: string; transfer_group: string | null; counterparty_account_id: string | null };

describe("quantity-aware transfer pairing (issue #99)", () => {
  test("an exchange send and the wallet receive, valued differently and a fee apart, are one internal transfer", () => {
    // Coinbase: -0.1005 BTC at its own value; the chain: +0.1 BTC at the day's spot.
    const n = night("-0.1005", "-6030.00", "0.1", "5990.00");
    expect(n.norm.transfers).toHaveLength(1);
    const pair = n.norm.transfers[0]!;
    expect(pair).toMatchObject({ matched_on: "quantity", instrument: "BTC", quantity: "0.1", out_account: "acct.coinbase.coinbase", in_account: "acct.ledger.wallet" });
    const out = legOf(n, "acct.coinbase.coinbase");
    const inn = legOf(n, "acct.ledger.wallet");
    expect(out.transfer_group).toBe(pair.group);
    expect(inn.transfer_group).toBe(pair.group);
    expect(out.counterparty_account_id).toBe("acct.ledger.wallet");
    expect(inn.counterparty_account_id).toBe("acct.coinbase.coinbase");
    // Both legs are transfers, so neither counts as household in/outflow; nothing is held for a human.
    expect(n.rec.findings.filter((f) => f.code === "internal_transfer_booked_as_income")).toHaveLength(0);
  });

  test("a gap larger than a fee, more received than sent, or a different coin: no pair", () => {
    expect(night("-0.2", "-12000", "0.1", "5990").norm.transfers).toHaveLength(0); // half went elsewhere
    expect(night("-0.1", "-6000", "0.1005", "6020").norm.transfers).toHaveLength(0); // cannot receive more than was sent
    expect(night("-0.1005", "-6030", "0.1", "5990", "ETH").norm.transfers).toHaveLength(0); // not the same instrument
    const unpaired = night("-0.2", "-12000", "0.1", "5990");
    expect(legOf(unpaired, "acct.coinbase.coinbase").transfer_group).toBeNull();
  });

  test("a quantity-paired receive booked as income is flagged, and the finding names what moved", () => {
    const n = night("-0.1005", "-6030.00", "0.1", "5990.00", "BTC", "income");
    expect(n.norm.transfers).toHaveLength(1);
    const f = n.rec.findings.filter((x) => x.code === "internal_transfer_booked_as_income");
    expect(f).toHaveLength(1);
    // The two legs carry different USD figures, so the outflow is described by quantity, not by the receive's amount.
    expect(f[0]!.summary).toContain("5990.00 USD into acct.ledger.wallet was booked as income but matches a 0.1 BTC outflow from acct.coinbase.coinbase");
    expect(f[0]!.detail).toMatchObject({ matched_on: "quantity", instrument: "BTC", quantity: "0.1" });
    expect(legOf(n, "acct.ledger.wallet").type).toBe("transfer_in");
  });

  test("cash legs still pair on the amount alone, and say so", () => {
    const n = night("-0.1", "-6000", "0.1", "6000");
    expect(n.norm.transfers[0]).toMatchObject({ matched_on: "amount" });
    expect(n.norm.transfers[0]!.instrument).toBeUndefined();
  });
});
