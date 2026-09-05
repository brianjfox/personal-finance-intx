// Issue #77 follow-up: a finding summary's money figures are formatted
// through money() when the host sent them as structured parts.

import { afterEach, describe, expect, test } from "bun:test";

import { findingSummary, setFxRates, setMasked } from "../src/api";

afterEach(() => {
  setFxRates(null);
  setMasked(false);
});

describe("findingSummary", () => {
  const parts = ["acct.x: positions sum to ", { amount: "12000", currency: "USD" }, " but the institution states ", { amount: "12500", currency: "USD" }, " (diff ", { amount: "500", currency: "USD" }, ")"];

  test("plain summary when the host sent no parts", () => {
    expect(findingSummary({ summary: "sum to 12000 USD" })).toBe("sum to 12000 USD");
  });

  test("figures formatted natively, then converted into the preferred currency, then veiled", () => {
    expect(findingSummary({ summary: "-", summary_parts: parts })).toBe("acct.x: positions sum to $12,000.00 but the institution states $12,500.00 (diff $500.00)");
    setFxRates({ to: "EUR", date: "2026-09-05", rates: { USD: "0.5" }, stale: false });
    expect(findingSummary({ summary: "-", summary_parts: parts })).toBe("acct.x: positions sum to €6,000.00 but the institution states €6,250.00 (diff €250.00)");
    setMasked(true);
    expect(findingSummary({ summary: "-", summary_parts: parts })).toBe("acct.x: positions sum to €*,***.** but the institution states €*,***.** (diff €***.**)");
  });
});
