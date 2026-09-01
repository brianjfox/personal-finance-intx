// Issue #47: a closed (or hidden) account's last position facts stay
// current facts; the live-facts readers drop them, exactly as the
// positions view does, so drift and the agents' tools see only holdings.

import { describe, expect, test } from "bun:test";

import type { AccountPayload, FactInput, PositionPayload } from "@fin/contracts";

import { openLedger, views } from "../src/index";

const AT = "2026-09-01T00:00:00.000Z";
function account(subject: string, closed_at: string | null = null): FactInput {
  return {
    kind: "account",
    subject,
    key: "account",
    payload: { account_id: subject, institution_id: "inst.x", name: subject, type: "brokerage", currency: "USD", ...(closed_at !== null ? { closed_at } : {}) } satisfies AccountPayload,
    observed_at: AT,
    effective_at: AT,
    source_id: "inst.x",
    source_doc_id: null,
    supersedes: null,
    writer: "assets_manager",
    provisional: false,
  };
}
function position(subject: string, symbol: string, quantity: string): FactInput {
  return {
    kind: "position",
    subject,
    key: symbol,
    payload: { account_id: subject, instrument: { symbol, asset_class: "crypto" }, quantity, price: "10", market_value: String(Number(quantity) * 10), currency: "USD", cost_basis: null, basis_known: false } satisfies PositionPayload,
    observed_at: AT,
    effective_at: AT,
    source_id: "inst.x",
    source_doc_id: null,
    supersedes: null,
    writer: "assets_manager",
    provisional: false,
  };
}

describe("live facts", () => {
  test("closed accounts and zero lines are dropped from live positions and accounts; asOf still returns them", () => {
    const ledger = openLedger(":memory:");
    ledger.commit({
      batchId: "seed",
      writer: "assets_manager",
      facts: [account("acct.live"), account("acct.dead", "2026-08-31"), position("acct.live", "BTC", "83"), position("acct.live", "DUST", "0"), position("acct.dead", "BTC", "16")],
    });
    expect(ledger.asOf({ kind: "position" })).toHaveLength(3);
    expect(views.closedSubjects(ledger)).toEqual(new Set(["acct.dead"]));
    expect(views.liveAccountFacts(ledger).map((f) => f.subject)).toEqual(["acct.live"]);
    const live = views.livePositionFacts(ledger);
    expect(live.map((f) => `${f.subject}:${(f.payload as PositionPayload).quantity}`)).toEqual(["acct.live:83"]);
    // The StoredFact form agrees with the view.
    expect(views.positions(ledger).map((p) => p.fact_id)).toEqual(live.map((f) => f.id));
    ledger.close();
  });
});
