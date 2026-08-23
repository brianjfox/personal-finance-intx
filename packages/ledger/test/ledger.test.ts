import { describe, expect, test } from "bun:test";

import type { FactInput } from "@fin/contracts";
import { openLedger, resolveFinding, views, WriterViolation } from "../src/index";

const T0 = "2026-03-01T00:00:00.000Z";
const T1 = "2026-03-02T00:00:00.000Z";
const T2 = "2026-03-03T00:00:00.000Z";
const T3 = "2026-03-04T00:00:00.000Z";

function bal(
  amount: string,
  observed: string,
  effective: string,
  extra: Partial<FactInput> = {},
): FactInput {
  return {
    kind: "balance",
    subject: "acct.demo.checking",
    key: "total",
    payload: { account_id: "acct.demo.checking", balance_type: "total", amount, currency: "USD" },
    observed_at: observed,
    effective_at: effective,
    source_id: "inst.demo",
    source_doc_id: null,
    supersedes: null,
    writer: "assets_manager",
    provisional: false,
    ...extra,
  };
}

function acct(id: string, type: "checking" | "brokerage" | "credit_card", observed = T0): FactInput {
  return {
    kind: "account",
    subject: id,
    key: "account",
    payload: { account_id: id, institution_id: "inst.demo", name: id, type, currency: "USD" },
    observed_at: observed,
    effective_at: observed,
    source_id: "inst.demo",
    source_doc_id: null,
    supersedes: null,
    writer: "assets_manager",
    provisional: false,
  };
}

describe("append-only", () => {
  test("UPDATE and DELETE on fact tables are refused by triggers", () => {
    const l = openLedger(":memory:");
    l.commit({ batchId: "b1", writer: "assets_manager", facts: [bal("1", T0, T0)] });
    expect(() => l.db.exec("UPDATE fact SET payload = '{}'")).toThrow(/append-only/);
    expect(() => l.db.exec("DELETE FROM fact")).toThrow(/append-only/);
    expect(() => l.db.exec("DELETE FROM batch")).toThrow(/append-only/);
    expect(l.factCount()).toBe(1);
  });
});

describe("one writer per fact", () => {
  test("a non-owner cannot write a kind", () => {
    const l = openLedger(":memory:");
    expect(() =>
      l.commit({ batchId: "b1", writer: "cash_flow", facts: [bal("1", T0, T0, { writer: "cash_flow" })] }),
    ).toThrow(WriterViolation);
    expect(() =>
      l.commit({ batchId: "b2", writer: "assets_manager", facts: [bal("1", T0, T0, { writer: "cash_flow" })] }),
    ).toThrow(WriterViolation);
    expect(l.factCount()).toBe(0);
  });

  test("payloads are validated against the kind's contract; the batch is all-or-nothing", () => {
    const l = openLedger(":memory:");
    const bad = bal("1", T0, T0, { payload: { account_id: "acct.x", balance_type: "total", amount: 1, currency: "USD" } });
    expect(() => l.commit({ batchId: "b1", writer: "assets_manager", facts: [bal("1", T0, T0), bad] })).toThrow(
      /contract/,
    );
    expect(l.factCount()).toBe(0);
  });
});

describe("idempotent batches", () => {
  test("re-committing a batch id returns the original fact ids and writes nothing", () => {
    const l = openLedger(":memory:");
    const a = l.commit({ batchId: "nightly:2026-03-01:assets", writer: "assets_manager", facts: [bal("1", T0, T0)] });
    const b = l.commit({ batchId: "nightly:2026-03-01:assets", writer: "assets_manager", facts: [bal("1", T0, T0)] });
    expect(a.replayed).toBe(false);
    expect(b.replayed).toBe(true);
    expect(b.factIds).toEqual(a.factIds);
    expect(l.factCount()).toBe(1);
  });
});

describe("bitemporal as-of", () => {
  test("what did we know on March 3rd? -- observed_at history survives a corrected statement", () => {
    const l = openLedger(":memory:");
    // Day 1: balance 100 effective Mar 1.
    const d1 = l.commit({ batchId: "d1", writer: "assets_manager", facts: [bal("100", T0, T0)] });
    // Day 2: balance 120 effective Mar 2.
    l.commit({ batchId: "d2", writer: "assets_manager", facts: [bal("120", T1, T1)] });
    // Day 4: a corrected statement says Mar 1 was really 90 (supersedes the first fact).
    const d4 = l.commit({
      batchId: "d4",
      writer: "assets_manager",
      facts: [bal("90", T3, T0, { supersedes: d1.factIds[0] as string, source_id: "inst.demo" })],
    });

    // Current knowledge, as of Mar 1 effective: 90 (the correction).
    const nowMar1 = l.asOf({ kind: "balance", subject: "acct.demo.checking", effectiveAt: T0 });
    expect(nowMar1).toHaveLength(1);
    expect((nowMar1[0]?.payload as { amount: string }).amount).toBe("90");
    expect(nowMar1[0]?.id).toBe(d4.factIds[0] as string);

    // Knowledge as of Mar 3 (before the correction arrived): Mar 1 was 100.
    const knewMar3 = l.asOf({ kind: "balance", subject: "acct.demo.checking", effectiveAt: T0, observedAt: T2 });
    expect((knewMar3[0]?.payload as { amount: string }).amount).toBe("100");

    // Latest effective, current knowledge: 120 (Mar 2), unaffected by the Mar 1 correction.
    const latest = l.asOf({ kind: "balance", subject: "acct.demo.checking" });
    expect((latest[0]?.payload as { amount: string }).amount).toBe("120");

    // History of the corrected fact is the full chain.
    const h = l.history(d1.factIds[0] as string);
    expect(h.map((f) => (f.payload as { amount: string }).amount)).toEqual(["100", "90"]);
  });

  test("supersedes must point at an existing fact of the same identity", () => {
    const l = openLedger(":memory:");
    l.commit({ batchId: "b1", writer: "assets_manager", facts: [acct("acct.demo.checking", "checking")] });
    expect(() =>
      l.commit({ batchId: "b2", writer: "assets_manager", facts: [bal("1", T0, T0, { supersedes: "fact_nope" })] }),
    ).toThrow(/does not exist/);
    const a = l.commit({ batchId: "b3", writer: "assets_manager", facts: [bal("1", T0, T0)] });
    expect(() =>
      l.commit({
        batchId: "b4",
        writer: "assets_manager",
        facts: [bal("1", T0, T0, { key: "available", supersedes: a.factIds[0] as string })],
      }),
    ).toThrow(/own kind\/subject\/key/);
  });
});

describe("provisional + resolution", () => {
  test("provisional facts hold the subject; a resolution appends clean facts and keeps history", () => {
    const l = openLedger(":memory:");
    const prior = l.commit({ batchId: "d1", writer: "assets_manager", facts: [bal("100", T0, T0)] });
    const incoming = l.commit({
      batchId: "d2",
      writer: "assets_manager",
      facts: [bal("999", T1, T1, { provisional: true })],
    });
    expect(l.isProvisional("acct.demo.checking")).toBe(true);
    expect(l.provisionalSubjects().get("acct.demo.checking")).toHaveLength(1);
    // The clean view excludes it; the default view includes it.
    expect(l.asOf({ kind: "balance", subject: "acct.demo.checking", includeProvisional: false })).toHaveLength(1);

    const fid = l.appendFinding({
      kind: "break",
      code: "stale_balance",
      severity: "high",
      subject: "acct.demo.checking",
      summary: "balance jumped",
      detail: {},
      evidence: [...prior.factIds, ...incoming.factIds],
      before: prior.factIds,
      after: incoming.factIds,
      requires_human: true,
      emitted_by: "reconciliation",
      as_of: T1,
      provenance: { source_id: "handler.reconcile", source_doc_id: null, observed_at: T1 },
    });
    expect(l.openFindings({ requiresHuman: true })).toHaveLength(1);

    const r = resolveFinding(l, { findingId: fid, decision: "keep_prior", note: "feed glitch", decidedBy: "brian", decidedAt: T2 });
    expect(r.resultingFacts).toHaveLength(1);
    expect(l.isProvisional("acct.demo.checking")).toBe(false);
    expect(l.openFindings()).toHaveLength(0);
    const cur = l.asOf({ kind: "balance", subject: "acct.demo.checking" });
    expect((cur[0]?.payload as { amount: string }).amount).toBe("100"); // prior re-asserted
    expect(cur[0]?.effective_at).toBe(T1);
    expect(cur[0]?.source_id).toBe("operator.brian");
    // History intact: 999 is still there, superseded.
    expect(l.getFact(incoming.factIds[0] as string)?.provisional).toBe(true);
    expect(l.history(incoming.factIds[0] as string)).toHaveLength(2);
    // Resolving twice is refused.
    expect(() => resolveFinding(l, { findingId: fid, decision: "dismiss", note: "", decidedBy: "b", decidedAt: T3 })).toThrow(
      /already resolved/,
    );
    expect(l.listJournal()).toHaveLength(1);
    expect(l.eventsSince(0).map((e) => e.kind)).toEqual(["finding.resolved"]);
  });
});

describe("views", () => {
  test("net worth = assets - liabilities, each line traceable to fact ids", () => {
    const l = openLedger(":memory:");
    l.commit({
      batchId: "a",
      writer: "assets_manager",
      facts: [
        acct("acct.demo.checking", "checking"),
        acct("acct.demo.brokerage", "brokerage"),
        acct("acct.demo.card", "credit_card"),
        bal("1000.50", T0, T0),
        {
          ...bal("0", T0, T0),
          subject: "acct.demo.card",
          payload: { account_id: "acct.demo.card", balance_type: "owed", amount: "250.25", currency: "USD" },
          key: "owed",
        },
        {
          kind: "position",
          subject: "acct.demo.brokerage",
          key: "VTI",
          payload: {
            account_id: "acct.demo.brokerage",
            instrument: { symbol: "VTI", asset_class: "etf" },
            quantity: "10",
            price: "250",
            market_value: "2500",
            currency: "USD",
            cost_basis: "2000",
            basis_known: true,
          },
          observed_at: T0,
          effective_at: T0,
          source_id: "inst.demo",
          source_doc_id: null,
          supersedes: null,
          writer: "assets_manager",
          provisional: false,
        },
      ],
    });
    const nw = views.netWorth(l);
    expect(nw.assets).toBe("3500.5");
    expect(nw.liabilities).toBe("250.25");
    expect(nw.net_worth).toBe("3250.25");
    const brokerage = nw.lines.find((x) => x.account_id === "acct.demo.brokerage");
    expect(brokerage?.basis).toBe("positions");
    expect(brokerage?.fact_ids).toHaveLength(1);
    expect(views.positions(l)).toHaveLength(1);
  });
});

describe("documents", () => {
  test("identical bytes dedupe by sha256", () => {
    const l = openLedger(":memory:");
    const d = {
      sha256: "a".repeat(64),
      mime: "application/json",
      bytes: 10,
      filename: "x.json",
      kind: "snapshot" as const,
      pages: null,
      source_id: "inst.demo",
      ingested_at: T0,
      ingested_by: "document_vault" as const,
    };
    const a = l.appendDocument(d);
    const b = l.appendDocument({ ...d, filename: "y.json" });
    expect(a.existed).toBe(false);
    expect(b.existed).toBe(true);
    expect(b.id).toBe(a.id);
  });
});
