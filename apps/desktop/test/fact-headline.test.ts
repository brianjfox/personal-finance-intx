// Issue #77: queue-card fact headlines format fiat through money(), so
// they follow the preferred display currency and the privacy veil like
// every other figure in the GUI -- never the raw payload string.

import { afterEach, describe, expect, test } from "bun:test";

import { factHeadline, setFxRates, setMasked } from "../src/api";

const fact = (kind: string, payload: Record<string, unknown>) => ({ kind, payload });

afterEach(() => {
  setFxRates(null);
  setMasked(false);
});

describe("factHeadline", () => {
  test("native currency when no display FX is loaded", () => {
    expect(factHeadline(fact("balance", { balance_type: "total", amount: "12000.00", currency: "USD" }))).toBe("total $12,000.00");
    expect(factHeadline(fact("transaction", { amount: "-1200.5", description: "NETFLIX.COM", currency: "USD" }))).toBe("-$1,200.50 NETFLIX.COM");
    expect(factHeadline(fact("position", { quantity: "10", instrument: { symbol: "VTI" }, market_value: "2345.67", currency: "USD" }))).toBe("10 VTI @ $2,345.67");
    expect(factHeadline(fact("lot", { lot_id: "L1", cost_basis: "300000", currency: "USD" }))).toBe("lot L1 basis $300,000.00");
  });

  test("converts into the preferred currency at the cached rate; unknown values stay words", () => {
    setFxRates({ to: "EUR", date: "2026-09-05", rates: { USD: "0.5" }, stale: false });
    expect(factHeadline(fact("balance", { balance_type: "total", amount: "12000.00", currency: "USD" }))).toBe("total €6,000.00");
    // Already in the display currency: no conversion.
    expect(factHeadline(fact("balance", { balance_type: "total", amount: "70", currency: "EUR" }))).toBe("total €70.00");
    expect(factHeadline(fact("position", { quantity: "10", instrument: { symbol: "VTI" }, market_value: null, currency: "USD" }))).toBe("10 VTI @ ?");
    expect(factHeadline(fact("lot", { lot_id: "L1", cost_basis: null, currency: "USD" }))).toBe("lot L1 basis unknown");
  });

  test("the privacy veil hides the digits", () => {
    setMasked(true);
    expect(factHeadline(fact("balance", { balance_type: "total", amount: "12000.00", currency: "USD" }))).toBe("total $**,***.**");
  });

  test("non-fiat kinds are unchanged", () => {
    expect(factHeadline(fact("tax_document", { form: "1099-DIV", tax_year: 2025, version: 2, totals: { "1a": "10" } }))).toBe('1099-DIV 2025 v2 {"1a":"10"}');
    expect(factHeadline(fact("account", {}))).toBe("account");
  });
});
