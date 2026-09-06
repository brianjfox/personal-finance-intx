// Two open wallet accounts watching the same address are one balance
// counted twice (issue #112): the reconciler raises a break naming both,
// reports the standing conditions by fingerprint so record_findings can
// close the ones that end, and stays quiet for two wallets that merely
// hold the same coin.

import { describe, expect, test } from "bun:test";

import { ASOF1, brokerage, freshLedger, NIGHT1, runNight, snap } from "./helpers";

const ETH = "0x00000000219ab540356cbb839cbe05303d7705fa";
const OTHER = "0x1111111111111111111111111111111111111111";

const wallet = (account_id: string, addresses: string[]) =>
  brokerage(account_id, ASOF1, {
    type: "crypto",
    positions: [{ instrument: { symbol: "ETH", asset_class: "crypto" }, quantity: "1", price: "2000", market_value: "2000", cost_basis: null }],
    watched_addresses: addresses,
  });

describe("address watched twice (issue #112)", () => {
  test("the same address in two open accounts is a break naming both; a different address is not", () => {
    const n = runNight(
      freshLedger(),
      "n1",
      {
        snapshots: [
          snap("inst.ledger", NIGHT1, [wallet("acct.ledger.wallet", [ETH, OTHER])]),
          snap("inst.ledger_ethereum_1", NIGHT1, [wallet("acct.ledger_ethereum_1.wallet", [ETH])]),
          snap("inst.other", NIGHT1, [wallet("acct.other.wallet", ["0x2222222222222222222222222222222222222222"])]),
        ],
        failures: [],
      },
      NIGHT1,
    );
    const found = n.rec.findings.filter((f) => f.code === "address_watched_twice");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ kind: "break", severity: "high", subject: "acct.ledger_ethereum_1.wallet", requires_human: true, holds: false });
    expect(found[0]!.summary).toBe("address 0x0000…05fa is watched by acct.ledger.wallet (inst.ledger) and acct.ledger_ethereum_1.wallet (inst.ledger_ethereum_1): one balance, counted 2 times in net worth -- remove all but one of those entries on Credentials");
    expect(found[0]!.detail).toMatchObject({ address: ETH, accounts: ["acct.ledger.wallet", "acct.ledger_ethereum_1.wallet"] });
    // Not a hold: the remedy is on Credentials, not in the queue's resolution flow.
    expect(n.rec.provisional_subjects).toEqual([]);
    expect(n.rec.still_watched_twice).toEqual([found[0]!.fingerprint]);
  });

  test("the condition is read from the ledger, so a night that fetches only the other institution still sees it, and its end is reported", () => {
    const ledger = freshLedger();
    const n1 = runNight(
      ledger,
      "n1",
      { snapshots: [snap("inst.a", NIGHT1, [wallet("acct.a.wallet", [ETH])]), snap("inst.b", NIGHT1, [wallet("acct.b.wallet", [ETH])])], failures: [] },
      NIGHT1,
    );
    n1.commit();
    const fp = n1.rec.findings.find((f) => f.code === "address_watched_twice")!.fingerprint;
    // Night 2 refreshes only inst.a: the ledger still holds both open accounts, so the condition stands (suppressed as already known).
    const n2 = runNight(ledger, "n2", { snapshots: [snap("inst.a", "2026-08-24T06:00:00.000Z", [wallet("acct.a.wallet", [ETH])])], failures: [] }, "2026-08-24T06:00:00.000Z");
    expect(n2.rec.still_watched_twice).toEqual([fp]);
    // Night 3: inst.b's account now watches a different address -- the shared one is watched once, and the condition is reported gone.
    const n3 = runNight(ledger, "n3", { snapshots: [snap("inst.b", "2026-08-25T06:00:00.000Z", [wallet("acct.b.wallet", [OTHER])])], failures: [] }, "2026-08-25T06:00:00.000Z");
    expect(n3.rec.findings.filter((f) => f.code === "address_watched_twice")).toHaveLength(0);
    expect(n3.rec.still_watched_twice).toEqual([]);
  });
});
