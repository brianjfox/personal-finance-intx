// Fiat FX rates for DISPLAY conversion. The ledger always stores native
// currencies; only what the operator sees is converted, at the current
// ECB reference rates (frankfurter.app -- free, keyless, ~30
// currencies). Rates are cached in <dataDir>/fx-cache.json and
// refreshed at most every 12 hours; when the network is down the last
// cache is used and marked stale rather than blanking the dashboard.
//
// rates[c] = units of the display currency per 1 unit of c, as a
// decimal string -- exactly what views.netWorth multiplies by.

import fs from "node:fs";
import path from "node:path";

export const FX_BASE_URL = "https://api.frankfurter.app";
const REFRESH_MS = 12 * 60 * 60 * 1000;

export interface FxRates {
  /** The display currency everything converts INTO. */
  to: string;
  /** ECB reference date of the rates. */
  date: string;
  rates: Record<string, string>;
  fetched_at: string;
  /** True when the network failed and this is the last cache. */
  stale: boolean;
}

interface FxCache {
  to: string;
  date: string;
  rates: Record<string, string>;
  fetched_at: string;
}

export interface FxOptions {
  dataDir: string;
  /** Convert into this currency. */
  to: string;
  base_url?: string;
  fetchImpl?: typeof fetch;
  clock?: () => Date;
}

export async function fxRates(opts: FxOptions): Promise<FxRates> {
  const clock = opts.clock ?? (() => new Date());
  const file = path.join(opts.dataDir, "fx-cache.json");
  let cache: FxCache | null = null;
  try {
    if (fs.existsSync(file)) cache = JSON.parse(fs.readFileSync(file, "utf8")) as FxCache;
  } catch {
    cache = null;
  }
  const now = clock();
  if (cache !== null && cache.to === opts.to && now.getTime() - Date.parse(cache.fetched_at) < REFRESH_MS) {
    return { ...cache, stale: false };
  }
  try {
    const doFetch = opts.fetchImpl ?? fetch;
    // One call: display-currency -> every ECB currency; invert to get
    // "display per unit of c". 8 significant-enough digits for display.
    const r = await doFetch(`${opts.base_url ?? FX_BASE_URL}/latest?from=${encodeURIComponent(opts.to)}`);
    if (!r.ok) throw new Error(`${r.status}`);
    const body = (await r.json()) as { date?: string; rates?: Record<string, number> };
    const rates: Record<string, string> = { [opts.to]: "1" };
    for (const [c, perDisplay] of Object.entries(body.rates ?? {})) {
      if (typeof perDisplay === "number" && Number.isFinite(perDisplay) && perDisplay > 0) {
        rates[c] = (1 / perDisplay).toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
      }
    }
    const fresh: FxCache = { to: opts.to, date: body.date ?? now.toISOString().slice(0, 10), rates, fetched_at: now.toISOString() };
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(fresh, null, 2));
    fs.renameSync(tmp, file);
    return { ...fresh, stale: false };
  } catch {
    if (cache !== null && cache.to === opts.to) return { ...cache, stale: true };
    // No network, no cache: the identity rate only -- other currencies
    // will surface in fx_missing rather than being silently wrong.
    return { to: opts.to, date: now.toISOString().slice(0, 10), rates: { [opts.to]: "1" }, fetched_at: now.toISOString(), stale: true };
  }
}
