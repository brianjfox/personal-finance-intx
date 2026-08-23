import { describe, expect, test } from "bun:test";

import type { SnapshotAccount } from "@fin/contracts";
import { failingAdapter, fixtureAdapter } from "@fin/institutions";
import { views } from "@fin/ledger";

import { NIGHTLY_PRINCIPALS, nightlyWorkflow, stepOutcomes, workflowById } from "../src/index";
import { harness } from "./harness";

const NIGHTLY = workflowById(nightlyWorkflow.id);
const ASOF = "2026-08-23T00:00:00.000Z";

const checking = (total: string, transactions: SnapshotAccount["transactions"] = []): SnapshotAccount => ({
  account_id: "acct.bank.checking",
  name: "Everyday Checking",
  type: "checking",
  currency: "USD",
  as_of: ASOF,
  balances: [{ balance_type: "total", amount: total }],
  transactions,
});
const brokerage = (extra: Partial<SnapshotAccount> = {}): SnapshotAccount => ({
  account_id: "acct.broker.taxable",
  name: "Taxable Brokerage",
  type: "brokerage",
  currency: "USD",
  as_of: ASOF,
  balances: [{ balance_type: "total", amount: "12464.25" }, { balance_type: "cash", amount: "2500.25" }],
  positions: [{ instrument: { symbol: "VTI", asset_class: "etf" }, quantity: "40", price: "249.10", market_value: "9964", cost_basis: "8100" }],
  transactions: [],
  ...extra,
});

describe("nightly workflow under runLocal with the real policy", () => {
  test("clean night: two institutions -> facts committed under their owning writers -> gate -> notify", async () => {
    const h = harness();
    h.setAdapters([fixtureAdapter("inst.bank", { accounts: [checking("5000")] }), fixtureAdapter("inst.broker", { accounts: [brokerage()] })]);
    const r = await h.run(NIGHTLY, {});
    expect(r.terminalStatus).toBe("completed");
    // gate took the clean branch: notify ran, hold was skipped
    expect((r.outputs["gate"] as { branch: string }).branch).toBe("notify");
    expect(stepOutcomes(r.events)["hold"]).toEqual({ status: "skipped", gateId: "gate", branch: "hold" });
    expect(stepOutcomes(r.events)["notify"]).toEqual({ status: "completed" });
    expect((r.outputs["notify"] as { subjects: string[] }).subjects).toEqual(["acct.bank.checking", "acct.broker.taxable"]);
    // ledger state
    const nw = views.netWorth(h.ledger);
    expect(nw.net_worth).toBe("17464.25");
    expect(nw.provisional).toBe(false);
    expect(h.ledger.openFindings({ requiresHuman: true })).toHaveLength(0);
    // raw snapshots are in the vault and every fact points at one
    expect(h.vault.list()).toHaveLength(2);
    const facts = h.ledger.asOf({ kind: "balance" });
    expect(facts.every((f) => f.source_doc_id !== null)).toBe(true);
    // batches carry the writer; one writer per batch
    const batches = h.ledger.listBatches();
    expect(batches.map((b) => b.writer).sort()).toEqual(["assets_manager"]);
    // every effect was authorized through the matrix, as the step's principal
    const allowed = h.decisions.filter((d) => d.effect === "allow");
    expect(allowed.length).toBeGreaterThan(0);
    expect(h.decisions.every((d) => d.effect === "allow")).toBe(true);
    expect(h.decisions.find((d) => d.stepId === "commit_assets")?.principal).toBe("assets_manager");
    expect(h.decisions.find((d) => d.stepId === "fetch")?.principal).toBe("assets_manager");
    // the outbox has the wake-up events downstream would subscribe to
    // (findings.opened carries the two informational "new account" findings; nothing queued)
    expect(h.ledger.eventsSince(0).map((e) => e.kind)).toEqual(["findings.opened", "facts.committed", "facts.committed", "nightly.clean"]);
    expect((r.outputs["record_findings"] as { queued: number }).queued).toBe(0);
  });

  test("break night: an injected duplicate transfer is caught and queued; downstream is held, not run", async () => {
    const h = harness();
    const xfer = { txn_id: "w-1", posted_at: "2026-08-22T00:00:00.000Z", amount: "-2000", type: "debit" as const, description: "TRANSFER TO BROKERAGE" };
    h.setAdapters([fixtureAdapter("inst.bank", { accounts: [checking("5000", [xfer])] }), fixtureAdapter("inst.broker", { accounts: [brokerage({ transactions: [{ txn_id: "in-1", posted_at: "2026-08-22T00:00:00.000Z", amount: "2000", type: "credit", description: "FUNDS RECEIVED" }] })] })]);
    const r1 = await h.run(NIGHTLY, {});
    expect(r1.terminalStatus).toBe("completed");
    expect((r1.outputs["gate"] as { branch: string }).branch).toBe("notify");

    // Night 2: the aggregator books the same transfer twice under a new id.
    h.setAdapters([fixtureAdapter("inst.bank", { accounts: [checking("5000", [xfer, { ...xfer, txn_id: "w-1-again" }])] }), fixtureAdapter("inst.broker", { accounts: [brokerage()] })]);
    const r2 = await h.run(NIGHTLY, {}, { now: "2026-08-24T06:00:00.000Z" });
    expect(r2.terminalStatus).toBe("completed");
    expect((r2.outputs["gate"] as { branch: string }).branch).toBe("hold");
    expect(stepOutcomes(r2.events)["notify"]).toEqual({ status: "skipped", gateId: "gate", branch: "notify" });
    expect(stepOutcomes(r2.events)["hold"]).toEqual({ status: "completed" });
    const rec = r2.outputs["reconcile"] as { clean: boolean; provisional_subjects: string[] };
    expect(rec.clean).toBe(false);
    expect(rec.provisional_subjects).toEqual(["acct.bank.checking"]);
    // queued rather than absorbed: one item, both versions side by side
    const queue = h.ledger.openFindings({ requiresHuman: true });
    expect(queue).toHaveLength(1);
    expect(queue[0]!.code).toBe("duplicate_transaction");
    expect(queue[0]!.before).toHaveLength(1);
    expect(queue[0]!.after).toHaveLength(1);
    expect(h.ledger.getFact(queue[0]!.after[0]!)?.provisional).toBe(true);
    expect(h.ledger.isProvisional("acct.bank.checking")).toBe(true);
    expect(h.ledger.isProvisional("acct.broker.taxable")).toBe(false);
    expect(views.netWorth(h.ledger).provisional).toBe(true);
    expect(h.ledger.eventsSince(0).map((e) => e.kind)).toContain("nightly.held");
    expect(h.ledger.eventsSince(0).filter((e) => e.kind === "nightly.clean")).toHaveLength(1); // only night 1
  });

  test("a failed institution is a queue item, not a crash; the rest of the night proceeds", async () => {
    const h = harness();
    h.setAdapters([failingAdapter("inst.bank", "ECONNREFUSED"), fixtureAdapter("inst.broker", { accounts: [brokerage()] })]);
    const r = await h.run(NIGHTLY, {});
    expect(r.terminalStatus).toBe("completed");
    const queue = h.ledger.openFindings({ requiresHuman: true });
    expect(queue.map((f) => f.code)).toEqual(["fetch_failed"]);
    expect(views.positions(h.ledger)).toHaveLength(1);
  });

  test("the policy refuses a step that runs as the wrong principal (a commit under cash_flow writing positions)", async () => {
    const h = harness();
    h.setAdapters([fixtureAdapter("inst.broker", { accounts: [brokerage()] })]);
    const tampered = { definition: NIGHTLY.definition, stepPrincipals: { ...NIGHTLY_PRINCIPALS, commit_assets: "cash_flow" as const } };
    const r = await h.run(tampered, {});
    expect(r.terminalStatus).toBe("failed");
    expect(h.decisions.some((d) => d.stepId === "commit_assets" && d.effect === "deny")).toBe(true);
    expect(h.ledger.factCount()).toBe(0);
  });
});
