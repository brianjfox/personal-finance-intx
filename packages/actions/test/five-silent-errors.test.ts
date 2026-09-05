// Deck slide 10: the five silent errors. One fixture each; all detected;
// each routed to the morning queue (requires_human) rather than absorbed.

import { describe, expect, test } from "bun:test";

import { ASOF1, ASOF2, brokerage, checking, freshLedger, NIGHT1, NIGHT2, runNight, snap } from "./helpers";

describe("1. a transfer between your own accounts booked twice as income", () => {
  test("the inflow leg typed as income by the brokerage is reclassified as a transfer and queued", () => {
    const ledger = freshLedger();
    const night = runNight(
      ledger,
      "n1",
      {
        snapshots: [
          snap("inst.bank", NIGHT1, [
            checking("acct.bank.checking", ASOF1, "5000", {
              transactions: [{ txn_id: "b-1", posted_at: "2026-08-20T00:00:00.000Z", amount: "-10000", type: "debit", description: "ONLINE TRANSFER TO BROKERAGE" }],
            }),
          ]),
          snap("inst.broker", NIGHT1, [
            brokerage("acct.broker.taxable", ASOF1, {
              balances: [{ balance_type: "total", amount: "10000" }],
              transactions: [{ txn_id: "k-9", posted_at: "2026-08-21T00:00:00.000Z", amount: "10000", type: "income", description: "FUNDS RECEIVED", raw_category: "Income" }],
            }),
          ]),
        ],
        failures: [],
      },
      NIGHT1,
    );
    expect(night.norm.transfers).toHaveLength(1);
    const inLeg = night.norm.facts.find((f) => f.fact.kind === "transaction" && f.fact.subject === "acct.broker.taxable")!;
    expect((inLeg.fact.payload as { type: string }).type).toBe("transfer_in");
    expect((inLeg.fact.payload as { transfer_group: string }).transfer_group).toMatch(/^xfer:/);
    expect((inLeg.fact.payload as { raw_category: string }).raw_category).toBe("Income");
    const f = night.rec.findings.filter((x) => x.code === "internal_transfer_booked_as_income");
    expect(f).toHaveLength(1);
    expect(f[0]!.requires_human).toBe(true);
    expect(f[0]!.subject).toBe("acct.broker.taxable");
    expect(night.rec.provisional_subjects).toEqual(["acct.broker.taxable"]);
    expect(night.rec.clean).toBe(false);
  });

  test("an aggregator duplicate (same movement, new id) is caught and queued, not absorbed", () => {
    const ledger = freshLedger();
    const tx = { txn_id: "b-1", posted_at: "2026-08-20T00:00:00.000Z", amount: "2500", type: "credit" as const, description: "PAYROLL ACME" };
    runNight(ledger, "n1", { snapshots: [snap("inst.bank", NIGHT1, [checking("acct.bank.checking", ASOF1, "5000", { transactions: [tx] })])], failures: [] }, NIGHT1).commit();
    const n2 = runNight(
      ledger,
      "n2",
      { snapshots: [snap("inst.bank", NIGHT2, [checking("acct.bank.checking", ASOF2, "7500", { transactions: [tx, { ...tx, txn_id: "b-1-dup" }] })])], failures: [] },
      NIGHT2,
    );
    expect(n2.norm.stats.transactions_known).toBe(1);
    expect(n2.norm.stats.transactions_new).toBe(1);
    const dup = n2.rec.findings.filter((f) => f.code === "duplicate_transaction");
    expect(dup).toHaveLength(1);
    expect(dup[0]!.before).toHaveLength(1); // the ledger's copy
    expect(dup[0]!.after_refs).toHaveLength(1); // tonight's copy
    expect(dup[0]!.requires_human).toBe(true);
    expect(n2.rec.provisional_subjects).toEqual(["acct.bank.checking"]);
    const ids = n2.commit();
    // Queued rather than absorbed: the duplicate is in the ledger but provisional, and the queue has one item with both versions.
    expect(ledger.isProvisional("acct.bank.checking")).toBe(true);
    const queue = ledger.openFindings({ requiresHuman: true });
    expect(queue).toHaveLength(1);
    expect(queue[0]!.before).toHaveLength(1);
    expect(queue[0]!.after).toEqual([ids[dup[0]!.after_refs[0]!]!]);
  });
});

describe("2. a balance that stopped updating four days ago but still looks live", () => {
  test("institution as-of older than the threshold", () => {
    const ledger = freshLedger();
    const n = runNight(ledger, "n1", { snapshots: [snap("inst.bank", NIGHT1, [checking("acct.bank.sav", "2026-08-17T00:00:00.000Z", "100")])], failures: [] }, NIGHT1);
    const f = n.rec.findings.filter((x) => x.code === "stale_balance");
    expect(f).toHaveLength(1);
    expect(f[0]!.detail["age_days"]).toBeCloseTo(5.25, 1);
    expect(n.rec.provisional_subjects).toEqual(["acct.bank.sav"]);
  });

  test("fresh-looking as-of but a value frozen for days while transactions keep posting", () => {
    const ledger = freshLedger();
    const day = (d: number) => `2026-08-${String(d).padStart(2, "0")}T00:00:00.000Z`;
    const fetch = (d: number) => `2026-08-${String(d).padStart(2, "0")}T06:00:00.000Z`;
    // Nights 18-21: the feed stamps each night's as-of (looks live) but the total never moves.
    for (let d = 18; d <= 21; d += 1) {
      const n = runNight(
        ledger,
        `n${d}`,
        { snapshots: [snap("inst.bank", fetch(d), [checking("acct.bank.chk", day(d), "4242.00", { transactions: [{ txn_id: `t${d}`, posted_at: day(d), amount: "-12", type: "debit", description: "coffee" }] })])], failures: [] },
        fetch(d),
      );
      expect(n.rec.findings.filter((x) => x.code === "stale_balance")).toHaveLength(0); // not yet past the threshold
      n.commit();
    }
    const n = runNight(
      ledger,
      "n22",
      { snapshots: [snap("inst.bank", fetch(22), [checking("acct.bank.chk", day(22), "4242.00", { transactions: [{ txn_id: "t22", posted_at: day(22), amount: "-12", type: "debit", description: "coffee" }] })])], failures: [] },
      fetch(22),
    );
    const f = n.rec.findings.filter((x) => x.code === "stale_balance");
    expect(f).toHaveLength(1);
    expect(f[0]!.detail["unchanged_since"]).toBe(fetch(18));
    expect(n.rec.provisional_subjects).toEqual(["acct.bank.chk"]);
    n.commit();
    // Night 23, still frozen: the open finding stands; no second item in the queue.
    const n23 = runNight(
      ledger,
      "n23",
      { snapshots: [snap("inst.bank", fetch(23), [checking("acct.bank.chk", day(23), "4242.00", { transactions: [{ txn_id: "t23", posted_at: day(23), amount: "-12", type: "debit", description: "coffee" }] })])], failures: [] },
      fetch(23),
    );
    expect(n23.rec.findings.filter((x) => x.code === "stale_balance")).toHaveLength(0);
    expect(ledger.openFindings({ requiresHuman: true }).filter((x) => x.code === "stale_balance")).toHaveLength(1);
  });
});

describe("3. a corrected 1099 that silently changes last year's answer", () => {
  test("the corrected form supersedes the original; both versions side by side in the queue", () => {
    const ledger = freshLedger();
    const doc = (corrected: boolean, div: string) => ({
      tax_year: 2025,
      form: "1099-DIV" as const,
      corrected,
      issued_at: corrected ? "2026-03-15" : "2026-02-01",
      totals: { "1a": div, "1b": div },
    });
    runNight(ledger, "n1", { snapshots: [snap("inst.broker", NIGHT1, [brokerage("acct.broker.taxable", ASOF1, { tax_documents: [doc(false, "1200.00")] })])], failures: [] }, NIGHT1).commit();
    const n2 = runNight(ledger, "n2", { snapshots: [snap("inst.broker", NIGHT2, [brokerage("acct.broker.taxable", ASOF2, { tax_documents: [doc(true, "1450.00")] })])], failures: [] }, NIGHT2);
    const f = n2.rec.findings.filter((x) => x.code === "corrected_tax_document");
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe("high");
    expect(f[0]!.detail["diff"]).toEqual({ "1a": { before: "1200.00", after: "1450.00" }, "1b": { before: "1200.00", after: "1450.00" } });
    expect(f[0]!.before).toHaveLength(1);
    const ids = n2.commit();
    const newId = ids[f[0]!.after_refs[0]!]!;
    const chain = ledger.history(f[0]!.before[0]!);
    expect(chain.map((c) => c.id)).toEqual([f[0]!.before[0]!, newId]);
    // Current answer is the correction; the answer as known before it arrived is still retrievable.
    const cur = ledger.asOf({ kind: "tax_document", subject: "acct.broker.taxable", key: "1099-DIV:2025" });
    expect((cur[0]!.payload as { totals: Record<string, string> }).totals["1a"]).toBe("1450.00");
    const then = ledger.asOf({ kind: "tax_document", subject: "acct.broker.taxable", key: "1099-DIV:2025", observedAt: NIGHT1 });
    expect((then[0]!.payload as { totals: Record<string, string> }).totals["1a"]).toBe("1200.00");
  });
});

describe("4. cost basis missing on transferred lots, quietly assumed as zero", () => {
  test("a transferred lot with no basis is a high-severity gap; the basis stays null", () => {
    const ledger = freshLedger();
    const n = runNight(
      ledger,
      "n1",
      {
        snapshots: [
          snap("inst.broker", NIGHT1, [
            brokerage("acct.broker.taxable", ASOF1, {
              positions: [
                {
                  instrument: { symbol: "VTI", asset_class: "etf" },
                  quantity: "100",
                  price: "250",
                  market_value: "25000",
                  cost_basis: null,
                  lots: [
                    { lot_id: "L1", quantity: "60", acquired_at: "2021-04-01", cost_basis: "12000", transferred_in: false },
                    { lot_id: "L2", quantity: "40", acquired_at: "2019-09-10", cost_basis: null, transferred_in: true },
                  ],
                },
                { instrument: { symbol: "ZERO", asset_class: "equity" }, quantity: "10", price: "50", market_value: "500", cost_basis: "0" },
              ],
            }),
          ]),
        ],
        failures: [],
      },
      NIGHT1,
    );
    const f = n.rec.findings.filter((x) => x.code === "missing_cost_basis");
    expect(f.map((x) => [x.severity, x.detail["lot_id"] ?? x.detail["symbol"]])).toEqual([
      ["high", "L2"],
      ["high", "ZERO"],
    ]);
    const lot = n.norm.facts.find((x) => x.fact.kind === "lot" && x.fact.key === "L2")!;
    expect((lot.fact.payload as { cost_basis: unknown }).cost_basis).toBeNull();
    expect((lot.fact.payload as { basis_known: boolean }).basis_known).toBe(false);
  });
});

describe("5. a crypto swap that is a taxable event no bank feed will mention", () => {
  test("explicit swap and disguised swap (two legs, same instant, no fiat) are both tax events", () => {
    const ledger = freshLedger();
    const n = runNight(
      ledger,
      "n1",
      {
        snapshots: [
          snap("inst.coinbase", NIGHT1, [
            {
              account_id: "acct.coinbase.main",
              name: "Coinbase",
              type: "crypto",
              currency: "USD",
              as_of: ASOF1,
              balances: [{ balance_type: "total", amount: "9000" }],
              transactions: [
                { txn_id: "c1", posted_at: "2026-08-20T10:00:00.000Z", amount: "0", type: "swap", description: "Converted 0.1 BTC to 1.5 ETH", instrument: { symbol: "ETH", asset_class: "crypto" }, quantity: "1.5", swap_from: { instrument: { symbol: "BTC", asset_class: "crypto" }, quantity: "0.1" } },
                { txn_id: "c2a", posted_at: "2026-08-21T10:00:00.000Z", amount: "-3000", type: "debit", description: "SOL sent", instrument: { symbol: "SOL", asset_class: "crypto" }, quantity: "-20" },
                { txn_id: "c2b", posted_at: "2026-08-21T10:00:00.000Z", amount: "3000", type: "credit", description: "AVAX received", instrument: { symbol: "AVAX", asset_class: "crypto" }, quantity: "100" },
                { txn_id: "c3", posted_at: "2026-08-22T10:00:00.000Z", amount: "-1000", type: "buy", description: "Bought BTC", instrument: { symbol: "BTC", asset_class: "crypto" }, quantity: "0.01" },
              ],
            },
          ]),
        ],
        failures: [],
      },
      NIGHT1,
    );
    const f = n.rec.findings.filter((x) => x.code === "crypto_swap_taxable_event");
    expect(f).toHaveLength(2);
    expect(f[0]!.kind).toBe("tax_event");
    expect(f[1]!.after_refs).toHaveLength(2);
    // A tax event is not a data break: the account is not held.
    expect(n.rec.provisional_subjects).toEqual([]);
  });
});

describe("extras", () => {
  test("positions that do not sum to the stated total; fetch failure; new account", () => {
    const ledger = freshLedger();
    const n = runNight(
      ledger,
      "n1",
      {
        snapshots: [
          snap("inst.broker", NIGHT1, [
            brokerage("acct.broker.ira", ASOF1, {
              balances: [{ balance_type: "total", amount: "50000" }, { balance_type: "cash", amount: "1000" }],
              positions: [{ instrument: { symbol: "VTI", asset_class: "etf" }, quantity: "100", price: "250", market_value: "25000", cost_basis: "20000" }],
            }),
          ]),
        ],
        failures: [{ institution_id: "inst.bank", fetched_at: NIGHT1, via: "adapter.jsondrop@1", error: "no *.json in inbox" }],
      },
      NIGHT1,
    );
    const codes = n.rec.findings.map((f) => f.code).sort();
    expect(codes).toEqual(["fetch_failed", "position_balance_mismatch", "unknown_account"]);
    expect(n.rec.provisional_subjects).toEqual(["acct.broker.ira"]);
    const mm = n.rec.findings.find((f) => f.code === "position_balance_mismatch")!;
    expect(mm.detail["diff"]).toBe("24000");
    // The summary's money figures are structured (issue #77): the display
    // formats each in the operator's currency; the plain text keeps the code.
    expect(mm.summary).toContain("(diff 24000 USD)");
    const figures = (mm.summary_parts ?? []).filter((p): p is { amount: string; currency: string } => typeof p !== "string");
    expect(figures.map((f) => f.currency)).toEqual(["USD", "USD", "USD"]);
    expect(figures[2]).toEqual({ amount: "24000", currency: "USD" });
  });

  test("a clean night is clean: nothing queued, nothing held, closed positions zeroed", () => {
    const ledger = freshLedger();
    const pos = (symbol: string, mv: string) => ({ instrument: { symbol, asset_class: "etf" as const }, quantity: "10", price: "10", market_value: mv, cost_basis: "50" });
    runNight(ledger, "n1", { snapshots: [snap("inst.broker", NIGHT1, [brokerage("acct.broker.taxable", ASOF1, { balances: [{ balance_type: "total", amount: "200" }], positions: [pos("AAA", "100"), pos("BBB", "100")] })])], failures: [] }, NIGHT1).commit();
    const n2 = runNight(ledger, "n2", { snapshots: [snap("inst.broker", NIGHT2, [brokerage("acct.broker.taxable", ASOF2, { balances: [{ balance_type: "total", amount: "100" }], positions: [pos("AAA", "100")] })])], failures: [] }, NIGHT2);
    expect(n2.rec.clean).toBe(true);
    expect(n2.rec.findings.filter((f) => f.requires_human)).toHaveLength(0);
    const closed = n2.norm.facts.find((f) => f.fact.kind === "position" && f.fact.key === "BBB")!;
    expect((closed.fact.payload as { quantity: string }).quantity).toBe("0");
  });
});

describe("the queue you stop reading", () => {
  test("a known, unresolved gap is not re-raised night after night; a changed condition is", () => {
    const ledger = freshLedger();
    const lot = (basis: string | null) => ({
      instrument: { symbol: "AAPL", asset_class: "equity" as const },
      quantity: "50",
      price: "230",
      market_value: "11500",
      cost_basis: basis,
      lots: [{ lot_id: "aapl-xfer", quantity: "50", acquired_at: "2019-09-10", cost_basis: basis, transferred_in: true }],
    });
    const n1 = runNight(ledger, "n1", { snapshots: [snap("inst.broker", NIGHT1, [brokerage("acct.broker.taxable", ASOF1, { positions: [lot(null)] })])], failures: [] }, NIGHT1);
    expect(n1.rec.findings.filter((f) => f.code === "missing_cost_basis")).toHaveLength(1);
    n1.commit();
    const n2 = runNight(ledger, "n2", { snapshots: [snap("inst.broker", NIGHT2, [brokerage("acct.broker.taxable", ASOF2, { positions: [lot(null)] })])], failures: [] }, NIGHT2);
    expect(n2.rec.findings.filter((f) => f.code === "missing_cost_basis")).toHaveLength(0);
    // An unchanged lot writes no new fact (issue #53), so there is nothing
    // to draft, let alone suppress; the night-1 finding stays open alone.
    expect(n2.norm.facts.some((f) => f.fact.kind === "lot")).toBe(false);
    expect(n2.rec.stats["suppressed_known"]).toBeUndefined();
    expect(ledger.openFindings({ requiresHuman: true })).toHaveLength(1);
    // Basis arrives: no gap at all.
    const n3 = runNight(ledger, "n3", { snapshots: [snap("inst.broker", NIGHT2, [brokerage("acct.broker.taxable", ASOF2, { positions: [lot("9000")] })])], failures: [] }, NIGHT2);
    expect(n3.rec.findings.filter((f) => f.code === "missing_cost_basis")).toHaveLength(0);
  });
});
