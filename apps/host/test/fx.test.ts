// Display FX: ECB rates fetched once, inverted to display-per-unit,
// cached for offline; the net-worth view converts exactly and names
// what it couldn't convert; managed saves read money the way people
// write it and keep the currency with the value.

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { views } from "@fin/ledger";

import { createApp } from "../src/app";
import { fxRates } from "../src/fx";

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "fin-fx-"));

describe("fx rates", () => {
  test("fetch -> invert -> cache -> offline stale fallback", async () => {
    let calls = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/latest") {
          calls += 1;
          expect(url.searchParams.get("from")).toBe("USD");
          return Response.json({ date: "2026-08-25", base: "USD", rates: { EUR: 0.8, GBP: 0.5, JPY: 160 } });
        }
        return new Response("nope", { status: 404 });
      },
    });
    const dataDir = tmp();
    try {
      const r1 = await fxRates({ dataDir, to: "USD", base_url: `http://127.0.0.1:${server.port}` });
      expect(r1.stale).toBe(false);
      expect(r1.rates["USD"]).toBe("1");
      expect(r1.rates["EUR"]).toBe("1.25"); // 1 / 0.8
      expect(r1.rates["GBP"]).toBe("2");
      expect(Number(r1.rates["JPY"])).toBeCloseTo(1 / 160, 6);
      const r2 = await fxRates({ dataDir, to: "USD", base_url: `http://127.0.0.1:${server.port}` });
      expect(calls).toBe(1); // cache hit inside the refresh window
      expect(r2.rates["EUR"]).toBe("1.25");
      // Network gone: last cache, marked stale.
      server.stop();
      const later = () => new Date(Date.now() + 13 * 60 * 60 * 1000);
      const r3 = await fxRates({ dataDir, to: "USD", base_url: "http://127.0.0.1:9", clock: later });
      expect(r3.stale).toBe(true);
      expect(r3.rates["EUR"]).toBe("1.25");
    } finally {
      server.stop();
    }
  });
});

describe("multi-currency display", () => {
  test("typed '€1.250.000,50' stores EUR with the value; totals convert; missing rates are named", async () => {
    const dataDir = tmp();
    const app = createApp({ dataDir });
    try {
      const home = app.addInstitution({ name: "US Bank", mode: "managed" });
      await app.saveManagedAccount(home.institution_id, { name: "Checking", type: "checking", value: "$10,000" });
      const eu = app.addInstitution({ name: "EU Flat", mode: "managed", category: "real_estate" });
      const saved = await app.saveManagedAccount(eu.institution_id, { name: "Flat in Lisbon", type: "real_estate", value: "€1.250.000,50" });
      expect(saved.account.currency).toBe("EUR");
      expect(saved.account.value).toBe("1250000.50");
      const ch = app.addInstitution({ name: "Swiss", mode: "managed" });
      await app.saveManagedAccount(ch.institution_id, { name: "Cash", type: "savings", value: "CHF 5'000" });

      const rates = { USD: "1", EUR: "1.25" }; // no CHF on purpose
      const nw = views.netWorth(app.ledger, { currency: "USD", rates });
      const flat = nw.lines.find((l) => l.name === "Flat in Lisbon")!;
      expect(flat.currency).toBe("EUR");
      expect(flat.value).toBe("1250000.50");
      expect(flat.display_value).toBe("1562500.63"); // 1250000.50 * 1.25, exact
      expect(nw.assets).toBe("1572500.63"); // 10000 + converted flat; CHF excluded
      expect(nw.fx_missing).toEqual(["CHF"]);
      const chf = nw.lines.find((l) => l.name === "Cash")!;
      expect(chf.display_value).toBeNull();

      // Garbage amounts are refused in plain words.
      expect(app.saveManagedAccount(home.institution_id, { name: "X", type: "checking", value: "a lot" })).rejects.toThrow(/couldn't read/);
    } finally {
      app.close();
    }
  });
});

describe("strategist aggregates are FX-honest", () => {
  test("totals convert before summing; by-type never mixes currencies at face value; missing rates are named", async () => {
    const { aggregatesTool } = await import("@fin/tools");
    const app = createApp({ dataDir: tmp() });
    try {
      const us = app.addInstitution({ name: "US Bank", mode: "managed" });
      await app.saveManagedAccount(us.institution_id, { name: "Checking", type: "checking", value: "$10,000" });
      const pt = app.addInstitution({ name: "Cascais", mode: "managed", category: "real_estate" });
      await app.saveManagedAccount(pt.institution_id, { name: "Flat", type: "real_estate", value: "€2.750.000" });
      const ch = app.addInstitution({ name: "Swiss", mode: "managed" });
      await app.saveManagedAccount(ch.institution_id, { name: "Cash", type: "savings", value: "CHF 5'000" });

      const fin = {
        ledger: app.ledger,
        clock: () => new Date("2026-08-26T12:00:00.000Z"),
        fx: async () => ({ to: "USD", date: "2026-08-26", rates: { USD: "1", EUR: "1.2" }, stale: false }),
      } as never;
      const r = await aggregatesTool.handler({}, fin);
      const res = r.result as Record<string, unknown>;
      expect(res["assets"]).toBe("3310000"); // 10000 + 2.75M * 1.2; CHF excluded
      expect(res["by_account_type"]).toEqual({ checking: "10000", real_estate: "3300000" });
      expect(res["excluded_currencies_without_rates"]).toEqual(["CHF"]);
      expect(res["converted_at_ecb_rates_of"]).toBe("2026-08-26");
    } finally {
      app.close();
    }
  });
});
