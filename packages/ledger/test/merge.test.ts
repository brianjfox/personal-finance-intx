// The repair for ledgers duplicated by a relink before normalize kept
// account identity (issue #2): the same real account exists under two
// subjects -- the original with the history, a younger duplicate from the
// new link -- and both count. `mergeAccounts` folds the duplicate into
// the survivor with appended facts only; these tests pin that the result
// counts once, keeps history continuous, and replays safely.

import { describe, expect, test } from "bun:test";

import type { AccountPayload, FactInput, TransactionPayload } from "@fin/contracts";

import { findMergeCandidates, mergeAccounts, openLedger, views, type Ledger } from "../src/index";

const T0 = "2026-06-01T06:00:00.000Z";
const T1 = "2026-08-20T06:00:00.000Z";
const T2 = "2026-08-25T06:00:00.000Z";
const NOW = new Date("2026-08-31T06:00:00.000Z");

function fact(partial: Partial<FactInput> & Pick<FactInput, "kind" | "subject" | "key" | "payload" | "writer">): FactInput {
  return {
    observed_at: T0,
    effective_at: T0,
    source_id: "inst.schwab",
    source_doc_id: null,
    supersedes: null,
    provisional: false,
    ...partial,
  };
}

function account(subject: string, at: string, extra: Partial<AccountPayload> = {}): FactInput {
  return fact({
    kind: "account",
    subject,
    key: "account",
    writer: "assets_manager",
    observed_at: at,
    effective_at: at,
    payload: {
      account_id: subject,
      institution_id: "inst.schwab",
      name: "Schwab Checking",
      type: "checking",
      currency: "USD",
      masked_number: "2222",
      ...extra,
    },
  });
}

function balance(subject: string, at: string, amount: string): FactInput {
  return fact({
    kind: "balance",
    subject,
    key: "total",
    writer: "assets_manager",
    observed_at: at,
    effective_at: at,
    payload: { account_id: subject, balance_type: "total", amount, currency: "USD" },
  });
}

function txnFact(subject: string, id: string, posted: string, amount: string, desc: string): FactInput {
  return fact({
    kind: "transaction",
    subject,
    key: id,
    writer: "cash_flow",
    observed_at: posted,
    effective_at: posted,
    payload: {
      account_id: subject,
      txn_id: id,
      posted_at: posted,
      amount,
      currency: "USD",
      type: "debit",
      description: desc,
    },
  });
}

/**
 * The shape the bug leaves behind: `acct.schwab.old` carries months of
 * history and was closed by delete-institution; `acct.schwab.new` is the
 * relinked duplicate holding the current balance and the re-observed
 * overlap window plus newer movements.
 */
function duplicatedLedger(): Ledger {
  const ledger = openLedger(":memory:");
  ledger.commit({
    batchId: "seed:assets",
    writer: "assets_manager",
    facts: [
      account("acct.schwab.old", T0),
      balance("acct.schwab.old", T1, "500"),
      account("acct.schwab.new", T2),
      balance("acct.schwab.new", T2, "436"),
    ],
  });
  // Close the old account the way delete-institution does.
  const prior = ledger.asOf({ kind: "account", subject: "acct.schwab.old" })[0]!;
  ledger.commit({
    batchId: "seed:close",
    writer: "assets_manager",
    facts: [
      fact({
        kind: "account",
        subject: "acct.schwab.old",
        key: "account",
        writer: "assets_manager",
        observed_at: T2,
        effective_at: T2,
        supersedes: prior.id,
        payload: { ...(prior.payload as AccountPayload), closed_at: "2026-08-25" },
      }),
    ],
  });
  ledger.commit({
    batchId: "seed:flows",
    writer: "cash_flow",
    facts: [
      // Old history plus the overlap window under old provider ids...
      txnFact("acct.schwab.old", "old-1", "2026-06-15T12:00:00.000Z", "-100", "Rent"),
      txnFact("acct.schwab.old", "old-2", "2026-08-20T12:00:00.000Z", "-40", "Grocery Store"),
      // ...the same grocery run re-observed under the new link's id, plus a newer movement.
      txnFact("acct.schwab.new", "new-1", "2026-08-20T12:00:00.000Z", "-40", "Grocery Store"),
      txnFact("acct.schwab.new", "new-2", "2026-08-24T12:00:00.000Z", "-24", "Bakery"),
    ],
  });
  return ledger;
}

describe("findMergeCandidates", () => {
  test("pairs the duplicate with the older survivor", () => {
    const ledger = duplicatedLedger();
    const clusters = findMergeCandidates(ledger);
    expect(clusters).toEqual([
      { survivor: "acct.schwab.old", duplicates: ["acct.schwab.new"], institution_id: "inst.schwab", name: "Schwab Checking" },
    ]);
  });

  test("differing masks are different accounts, and all-closed groups need no repair", () => {
    const ledger = openLedger(":memory:");
    ledger.commit({
      batchId: "b",
      writer: "assets_manager",
      facts: [
        account("acct.schwab.a", T0, { masked_number: "1111" }),
        account("acct.schwab.b", T1, { masked_number: "9999" }),
        account("acct.schwab.c", T0, { name: "Old Twin", masked_number: null, closed_at: "2026-01-01" }),
        account("acct.schwab.d", T1, { name: "Old Twin", masked_number: null, closed_at: "2026-01-01" }),
      ],
    });
    expect(findMergeCandidates(ledger)).toEqual([]);
  });
});

describe("mergeAccounts", () => {
  test("the household counts each real account and movement exactly once, with history continuous", () => {
    const ledger = duplicatedLedger();
    // Before: both generations exist and the movement books twice.
    expect(views.netWorth(ledger).net_worth).toBe("436"); // old is closed; but 4 txns are live
    expect(views.transactions(ledger)).toHaveLength(4);

    const r = mergeAccounts(ledger, { survivor: "acct.schwab.old", duplicate: "acct.schwab.new", now: NOW });
    expect(r).toMatchObject({ replayed: false, balances: 1, transactions_moved: 1, transactions_absorbed: 1 });

    // One open account, carrying the live link's balance.
    const accts = views.accounts(ledger);
    const open = accts.filter((a) => a.closed_at === null);
    expect(open.map((a) => a.account_id)).toEqual(["acct.schwab.old"]);
    const alias = accts.find((a) => a.account_id === "acct.schwab.new");
    expect(alias?.merged_into).toBe("acct.schwab.old");
    expect(alias?.closed_at).not.toBeNull();
    expect(views.netWorth(ledger).net_worth).toBe("436");

    // History is continuous under the survivor: rent, one grocery run, bakery.
    const mine = views.transactions(ledger, { subject: "acct.schwab.old" });
    expect(mine.map((f) => f.key).sort()).toEqual(["new-2", "old-1", "old-2"]);
    // ...and nothing lives anywhere else.
    expect(views.transactions(ledger)).toHaveLength(3);
    const moved = mine.find((f) => f.key === "new-2");
    expect((moved?.payload as TransactionPayload).account_id).toBe("acct.schwab.old");

    // Cash flow books the grocery run once.
    const flow = views.cashFlow(ledger, { months: 4, now: NOW });
    const aug = flow.months.find((m) => m.month === "2026-08");
    expect(aug?.outflow).toBe("64"); // 40 grocery + 24 bakery, not 104
  });

  test("replays and repeat calls are no-ops", () => {
    const ledger = duplicatedLedger();
    mergeAccounts(ledger, { survivor: "acct.schwab.old", duplicate: "acct.schwab.new", now: NOW });
    const facts = ledger.factCount();
    const again = mergeAccounts(ledger, { survivor: "acct.schwab.old", duplicate: "acct.schwab.new", now: NOW });
    expect(again.replayed).toBe(true);
    expect(ledger.factCount()).toBe(facts);
    // And the detector no longer sees a pair.
    expect(findMergeCandidates(ledger)).toEqual([]);
  });

  test("refuses a survivor that is itself merged away", () => {
    const ledger = duplicatedLedger();
    mergeAccounts(ledger, { survivor: "acct.schwab.old", duplicate: "acct.schwab.new", now: NOW });
    expect(() => mergeAccounts(ledger, { survivor: "acct.schwab.new", duplicate: "acct.schwab.old", now: NOW })).toThrow(
      /merged into/,
    );
  });
});
