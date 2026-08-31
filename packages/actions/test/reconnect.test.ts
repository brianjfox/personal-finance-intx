// A relink (new Plaid item, new Enable Banking session) reports the same
// real accounts under brand-new provider ids. These tests pin the repair
// for the duplication that used to cause: tonight's unknown ids are
// matched to the known accounts (mask/type first, name/currency as the
// fallback), history stays on the original subjects, re-observed
// transactions do not book twice, and a complete feed that stops
// reporting an account closes it instead of leaving its last balance in
// net worth forever.

import { describe, expect, test } from "bun:test";

import type { AccountPayload, TransactionPayload } from "@fin/contracts";
import { views } from "@fin/ledger";

import { ASOF1, ASOF2, checking, freshLedger, NIGHT1, NIGHT2, runNight, snap } from "./helpers";

const NIGHT3 = "2026-08-24T06:00:00.000Z";
const ASOF3 = "2026-08-24T00:00:00.000Z";

const txn = (txn_id: string, posted_at: string, amount: string, description: string) => ({
  txn_id,
  posted_at,
  amount,
  type: "debit" as const,
  description,
});

/** Two accounts the way a Plaid item reports them, ids scoped to `item`. */
function schwabNight(item: string, asOf: string, opts: { txns?: ReturnType<typeof txn>[]; totals?: [string, string] } = {}) {
  const [t1, t2] = opts.totals ?? ["1000", "500"];
  return snap("inst.schwab", asOf === ASOF1 ? NIGHT1 : asOf === ASOF2 ? NIGHT2 : NIGHT3, [
    checking(`acct.schwab.${item}_1`, asOf, t1, { name: "Schwab Brokerage", masked_number: "1111" }),
    checking(`acct.schwab.${item}_2`, asOf, t2, { name: "Schwab Checking", masked_number: "2222", transactions: opts.txns ?? [] }),
  ]).accounts;
}

function completeSnap(fetchedAt: string, accounts: ReturnType<typeof schwabNight>) {
  return { ...snap("inst.schwab", fetchedAt, accounts), complete: true };
}

describe("reconnect keeps account identity", () => {
  test("new provider ids are matched by mask/type and history stays continuous", () => {
    const ledger = freshLedger();
    const overlap = [txn("itemA-t1", "2026-08-20T12:00:00.000Z", "-40", "Grocery Store"), txn("itemA-t2", "2026-08-21T12:00:00.000Z", "-15", "Coffee")];
    runNight(ledger, "n1", { snapshots: [completeSnap(NIGHT1, schwabNight("itemA", ASOF1, { txns: overlap }))], failures: [] }, NIGHT1).commit();

    // The relink: same two real accounts, brand-new item-scoped ids, the
    // same movements re-observed under new txn ids plus one new one.
    const relinkTxns = [
      txn("itemB-t1", "2026-08-20T12:00:00.000Z", "-40", "Grocery Store"),
      txn("itemB-t2", "2026-08-21T12:00:00.000Z", "-15", "Coffee"),
      txn("itemB-t3", "2026-08-22T12:00:00.000Z", "-9", "Bakery"),
    ];
    const night2 = runNight(
      ledger,
      "n2",
      { snapshots: [completeSnap(NIGHT2, schwabNight("itemB", ASOF2, { txns: relinkTxns, totals: ["1100", "436"] }))], failures: [] },
      NIGHT2,
    );

    // Both accounts resolve to their original subjects; nothing is "new".
    const byId = new Map(night2.norm.accounts.map((a) => [a.account_id, a]));
    expect([...byId.keys()].sort()).toEqual(["acct.schwab.itemA_1", "acct.schwab.itemA_2"]);
    expect(byId.get("acct.schwab.itemA_1")?.is_new).toBe(false);
    expect(byId.get("acct.schwab.itemA_1")?.remapped_from).toBe("acct.schwab.itemB_1");
    expect(byId.get("acct.schwab.itemA_2")?.remapped_from).toBe("acct.schwab.itemB_2");
    // The re-observed movements count as known; only the bakery is new.
    expect(night2.norm.stats.transactions_known).toBe(2);
    expect(night2.norm.stats.transactions_new).toBe(1);
    // The relink is reported as info, and nothing holds the accounts.
    expect(night2.rec.findings.filter((f) => f.code === "account_relinked")).toHaveLength(2);
    expect(night2.rec.findings.filter((f) => f.code === "unknown_account")).toHaveLength(0);
    expect(night2.rec.findings.filter((f) => f.code === "duplicate_transaction")).toHaveLength(0);
    expect(night2.rec.clean).toBe(true);
    night2.commit();

    // No duplicates: two open accounts, the new ids are closed aliases.
    const accts = views.accounts(ledger);
    const open = accts.filter((a) => a.closed_at === null);
    expect(open.map((a) => a.account_id).sort()).toEqual(["acct.schwab.itemA_1", "acct.schwab.itemA_2"]);
    const aliases = accts.filter((a) => a.merged_into !== null);
    expect(aliases.map((a) => [a.account_id, a.merged_into]).sort()).toEqual([
      ["acct.schwab.itemB_1", "acct.schwab.itemA_1"],
      ["acct.schwab.itemB_2", "acct.schwab.itemA_2"],
    ]);
    // Net worth counts each real account exactly once, at the relinked value.
    const nw = views.netWorth(ledger);
    expect(nw.net_worth).toBe("1536");
    // History is continuous: old and new movements live under one subject.
    const txns = views.transactions(ledger, { subject: "acct.schwab.itemA_2" });
    expect(txns.map((f) => f.key).sort()).toEqual(["itemA-t1", "itemA-t2", "itemB-t3"]);

    // Night 3: the provider keeps reporting item-B ids; the alias resolves
    // them exactly and nothing new appears.
    const night3 = runNight(
      ledger,
      "n3",
      { snapshots: [completeSnap(NIGHT3, schwabNight("itemB", ASOF3, { totals: ["1150", "436"] }))], failures: [] },
      NIGHT3,
    );
    expect(night3.norm.accounts.map((a) => a.account_id).sort()).toEqual(["acct.schwab.itemA_1", "acct.schwab.itemA_2"]);
    expect(night3.norm.accounts.every((a) => !a.is_new)).toBe(true);
    night3.commit();
    expect(views.accounts(ledger).filter((a) => a.closed_at === null)).toHaveLength(2);
    expect(views.netWorth(ledger).net_worth).toBe("1586");
  });

  test("without masks the match falls back to name and currency", () => {
    const ledger = freshLedger();
    runNight(
      ledger,
      "n1",
      { snapshots: [{ ...snap("inst.bank", NIGHT1, [checking("acct.bank.sessionA", ASOF1, "300", { name: "Compte Courant" })]), complete: true }], failures: [] },
      NIGHT1,
    ).commit();
    const night2 = runNight(
      ledger,
      "n2",
      { snapshots: [{ ...snap("inst.bank", NIGHT2, [checking("acct.bank.sessionB", ASOF2, "320", { name: "Compte Courant" })]), complete: true }], failures: [] },
      NIGHT2,
    );
    expect(night2.norm.accounts[0]?.account_id).toBe("acct.bank.sessionA");
    expect(night2.norm.accounts[0]?.remapped_from).toBe("acct.bank.sessionB");
    night2.commit();
    expect(views.accounts(ledger).filter((a) => a.closed_at === null)).toHaveLength(1);
  });

  test("differing masks refuse the match even when names agree", () => {
    const ledger = freshLedger();
    runNight(
      ledger,
      "n1",
      { snapshots: [{ ...snap("inst.bank", NIGHT1, [checking("acct.bank.a", ASOF1, "300", { name: "Checking", masked_number: "1111" })]), complete: true }], failures: [] },
      NIGHT1,
    ).commit();
    const night2 = runNight(
      ledger,
      "n2",
      { snapshots: [{ ...snap("inst.bank", NIGHT2, [checking("acct.bank.b", ASOF2, "999", { name: "Checking", masked_number: "9999" })]), complete: true }], failures: [] },
      NIGHT2,
    );
    // A genuinely different account: reported new, and the vanished one closed.
    expect(night2.norm.accounts[0]?.account_id).toBe("acct.bank.b");
    expect(night2.norm.accounts[0]?.is_new).toBe(true);
    expect(night2.norm.closed.map((c) => c.account_id)).toEqual(["acct.bank.a"]);
    expect(night2.rec.findings.filter((f) => f.code === "account_gone")).toHaveLength(1);
    night2.commit();
    const open = views.accounts(ledger).filter((a) => a.closed_at === null);
    expect(open.map((a) => a.account_id)).toEqual(["acct.bank.b"]);
    expect(views.netWorth(ledger).net_worth).toBe("999");
  });

  test("an incomplete feed never closes accounts", () => {
    const ledger = freshLedger();
    runNight(
      ledger,
      "n1",
      {
        snapshots: [
          snap("inst.drop", NIGHT1, [
            checking("acct.drop.a", ASOF1, "100", { name: "A" }),
            checking("acct.drop.b", ASOF1, "200", { name: "B" }),
          ]),
        ],
        failures: [],
      },
      NIGHT1,
    ).commit();
    // A partial file drop mentions only one account; the other must survive.
    const night2 = runNight(
      ledger,
      "n2",
      { snapshots: [snap("inst.drop", NIGHT2, [checking("acct.drop.a", ASOF2, "110", { name: "A" })])], failures: [] },
      NIGHT2,
    );
    expect(night2.norm.closed).toHaveLength(0);
    night2.commit();
    expect(views.accounts(ledger).filter((a) => a.closed_at === null)).toHaveLength(2);
  });

  test("two identical-looking movements only absorb one re-observation each", () => {
    const ledger = freshLedger();
    const two = [txn("a-1", "2026-08-20T12:00:00.000Z", "-5", "Coffee"), txn("a-2", "2026-08-20T13:00:00.000Z", "-5", "Coffee")];
    runNight(
      ledger,
      "n1",
      { snapshots: [{ ...snap("inst.bank", NIGHT1, [checking("acct.bank.a", ASOF1, "90", { name: "Checking", masked_number: "1111", transactions: two })]), complete: true }], failures: [] },
      NIGHT1,
    ).commit();
    // The relink re-observes both, plus a third identical purchase.
    const three = [
      txn("b-1", "2026-08-20T12:00:00.000Z", "-5", "Coffee"),
      txn("b-2", "2026-08-20T13:00:00.000Z", "-5", "Coffee"),
      txn("b-3", "2026-08-20T14:00:00.000Z", "-5", "Coffee"),
    ];
    const night2 = runNight(
      ledger,
      "n2",
      { snapshots: [{ ...snap("inst.bank", NIGHT2, [checking("acct.bank.new", ASOF2, "85", { name: "Checking", masked_number: "1111", transactions: three })]), complete: true }], failures: [] },
      NIGHT2,
    );
    expect(night2.norm.stats.transactions_known).toBe(2);
    expect(night2.norm.stats.transactions_new).toBe(1);
  });
});

describe("voided transactions count nowhere", () => {
  test("views and cash flow skip a voided fact", () => {
    const ledger = freshLedger();
    const one = [txn("t-1", "2026-08-20T12:00:00.000Z", "-50", "Rent")];
    runNight(
      ledger,
      "n1",
      { snapshots: [snap("inst.bank", NIGHT1, [checking("acct.bank.a", ASOF1, "100", { name: "A", transactions: one })])], failures: [] },
      NIGHT1,
    ).commit();
    const live = views.transactions(ledger, { subject: "acct.bank.a" })[0];
    expect(live).toBeDefined();
    const payload = { ...(live!.payload as TransactionPayload), voided: true };
    ledger.commit({
      batchId: "void:t-1",
      writer: "cash_flow",
      facts: [
        {
          kind: "transaction",
          subject: "acct.bank.a",
          key: "t-1",
          payload,
          observed_at: NIGHT2,
          effective_at: live!.effective_at,
          source_id: "inst.bank",
          source_doc_id: null,
          supersedes: live!.id,
          writer: "cash_flow",
          provisional: false,
        },
      ],
    });
    expect(views.transactions(ledger, { subject: "acct.bank.a" })).toHaveLength(0);
    const flow = views.cashFlow(ledger, { months: 12, now: new Date(NIGHT2) });
    expect(flow.months.every((m) => m.txns === 0)).toBe(true);
  });
});

describe("account payload contract", () => {
  test("merged_into round-trips through the account view", () => {
    const p: AccountPayload = {
      account_id: "acct.bank.dup",
      institution_id: "inst.bank",
      name: "Checking",
      type: "checking",
      currency: "USD",
      masked_number: null,
      closed_at: "2026-08-23",
      merged_into: "acct.bank.orig",
    };
    const ledger = freshLedger();
    ledger.commit({
      batchId: "b1",
      writer: "assets_manager",
      facts: [
        {
          kind: "account",
          subject: "acct.bank.dup",
          key: "account",
          payload: p,
          observed_at: NIGHT1,
          effective_at: NIGHT1,
          source_id: "inst.bank",
          source_doc_id: null,
          supersedes: null,
          writer: "assets_manager",
          provisional: false,
        },
      ],
    });
    const a = views.accounts(ledger)[0];
    expect(a?.merged_into).toBe("acct.bank.orig");
    expect(a?.closed_at).toBe("2026-08-23");
  });
});
