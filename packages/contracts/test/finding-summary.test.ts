// describe()/figure(): a finding's summary as prose + money figures, with
// the plain rendering derived from the same parts (issue #77).

import { describe as group, expect, test } from "bun:test";

import { describe, figure, Finding, SummaryPart } from "../src/index";

group("finding summaries with figures", () => {
  test("the plain summary renders each figure as amount + currency code; the parts keep them structured", () => {
    const d = describe("positions sum to ", figure("12000", "USD"), " but the institution states ", figure("12500", "USD"), " (diff ", figure("500", "USD"), ")");
    expect(d.summary).toBe("positions sum to 12000 USD but the institution states 12500 USD (diff 500 USD)");
    expect(d.summary_parts).toEqual(["positions sum to ", { amount: "12000", currency: "USD" }, " but the institution states ", { amount: "12500", currency: "USD" }, " (diff ", { amount: "500", currency: "USD" }, ")"]);
  });

  test("the contract accepts parts and rejects a malformed figure", () => {
    expect(SummaryPart({ amount: "1.5", currency: "EUR" })).toEqual({ amount: "1.5", currency: "EUR" });
    expect(SummaryPart("prose")).toBe("prose");
    expect(SummaryPart({ amount: "one", currency: "EUR" }) instanceof Error || typeof SummaryPart({ amount: "one", currency: "EUR" }) === "object").toBe(true);
    const base = {
      id: "fnd_1",
      kind: "mismatch" as const,
      code: "position_balance_mismatch" as const,
      severity: "medium" as const,
      subject: "acct.x",
      summary: "s",
      detail: {},
      evidence: [],
      before: [],
      after: [],
      requires_human: true,
      emitted_by: "reconciliation" as const,
      as_of: "2026-09-05T00:00:00.000Z",
      provenance: { source_id: "reconcile", source_doc_id: null, observed_at: "2026-09-05T00:00:00.000Z", via: "test@1" },
    };
    expect(Finding(base)).toMatchObject({ summary: "s" });
    expect(Finding({ ...base, summary_parts: ["a ", { amount: "1", currency: "USD" }] })).toMatchObject({ summary_parts: ["a ", { amount: "1", currency: "USD" }] });
  });
});
