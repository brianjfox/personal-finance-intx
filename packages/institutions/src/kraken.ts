// Kraken connector: crypto holdings via the Kraken REST API, read-only
// by key permission (create the API key with the "Query Funds"
// permission ONLY -- trade/withdraw permissions must be absent, not
// unused). Auth is Kraken's HMAC scheme: API-Sign =
// base64(HMAC-SHA512(path + SHA256(nonce + POST body), base64-decoded
// secret)). Balances come from /0/private/Balance; Kraken's legacy
// asset codes (XXBT, ZUSD) and earn/staking suffixes (.S/.M/.F/.B)
// normalize onto plain symbols, with same-asset variants summed
// decimal-exactly. Spot prices come from the same public price endpoint
// the other crypto connectors use.

import crypto from "node:crypto";

import { decimal } from "@fin/contracts";

import { loggingFetch, validateDraftSnapshot, type FetchOutput, type HttpLogSink, type InstitutionAdapter } from "./adapter";
import type { LotWalkNote } from "./coinbase";
import { deriveKrakenLots, type KrakenLedgerEntry } from "./kraken-lots";
import { defaultSecretStore, type SecretStore } from "./secrets";

export const KRAKEN_VIA = "adapter.kraken@1";
export const KRAKEN_SERVICE = "fin-kraken";
export const KRAKEN_BASE_URL = "https://api.kraken.com";

export interface KrakenOptions {
  institution_id: string;
  base_url?: string;
  /** Spot prices (the Coinbase public endpoint by default; configurable for tests). */
  price_api?: string;
  secrets?: SecretStore;
  fetchImpl?: typeof fetch;
  /** Walk the account ledger into tax lots (issue #64; needs the key permission "Query ledger entries"). Default on, best effort. */
  lots?: boolean;
  /** Safety bound on the ledger walk (50 entries a page). */
  max_history_pages?: number;
  /** Pause between ledger pages, ms (Kraken's private-API rate limit); tests set 0. */
  page_pause_ms?: number;
}

/** Dollar stablecoins: positions, but no tax lots are derived for them. */
const STABLE = new Set(["USDC", "USDT", "DAI", "PYUSD", "USDP", "GUSD", "TUSD"]);

/** Kraken's legacy X/Z-prefixed asset codes -> plain symbols. */
const ASSET_CODES: Record<string, string> = {
  XXBT: "BTC", XBT: "BTC", XETH: "ETH", XXDG: "DOGE", XDG: "DOGE", XLTC: "LTC",
  XXRP: "XRP", XXLM: "XLM", XXMR: "XMR", XZEC: "ZEC", XETC: "ETC", XMLN: "MLN",
  ZUSD: "USD", ZEUR: "EUR", ZGBP: "GBP", ZCAD: "CAD", ZJPY: "JPY", ZAUD: "AUD", ZCHF: "CHF",
  ETH2: "ETH",
};

const FIAT = new Set(["USD", "EUR", "GBP", "CAD", "JPY", "AUD", "CHF"]);

/** "XBT.M" -> "BTC"; "SOL.S" -> "SOL"; "ZUSD" -> "USD". */
export function normalizeKrakenAsset(code: string): string {
  const base = code.split(".")[0] as string;
  return ASSET_CODES[base] ?? base;
}

/** API-Sign for one private request. */
export function krakenSign(path: string, nonce: string, postData: string, secretB64: string): string {
  const inner = crypto.createHash("sha256").update(nonce + postData).digest();
  return crypto
    .createHmac("sha512", Buffer.from(secretB64, "base64"))
    .update(Buffer.concat([Buffer.from(path), inner]))
    .digest("base64");
}

const dec = (s: string): string => {
  const v = s.trim();
  if (!/^-?\d+(\.\d+)?$/.test(v)) throw new Error(`kraken: not a decimal amount: ${JSON.stringify(s)}`);
  return v;
};

export function krakenAdapter(opts: KrakenOptions): InstitutionAdapter {
  const secrets = opts.secrets ?? defaultSecretStore();
  const base = opts.base_url ?? KRAKEN_BASE_URL;
  const priceApi = opts.price_api ?? "https://api.coinbase.com";
  let httpSink: HttpLogSink | null = null;
  const doFetch = loggingFetch(opts.fetchImpl ?? fetch, () => httpSink);
  const instSlug = opts.institution_id.replace(/^inst\./, "");

  return {
    institution_id: opts.institution_id,
    via: KRAKEN_VIA,
    async fetch(ctx): Promise<FetchOutput> {
      httpSink = ctx.http ?? null;
      const apiKey = secrets.get(KRAKEN_SERVICE, `api_key:${opts.institution_id}`);
      const secret = secrets.get(KRAKEN_SERVICE, `private_key:${opts.institution_id}`);
      if (apiKey === null || secret === null) {
        throw new Error(`kraken ${opts.institution_id}: not connected -- add your Kraken API key from the Assets page`);
      }
      const asOf = ctx.now.toISOString();
      let lastNonce = ctx.now.getTime() * 1000;
      const priv = async <T>(path: string, params: Record<string, string> = {}): Promise<T> => {
        for (let attempt = 0; ; attempt++) {
          lastNonce += 1000;
          const nonce = String(lastNonce);
          const postData = new URLSearchParams({ nonce, ...params }).toString();
          const r = await doFetch(`${base}${path}`, {
            method: "POST",
            headers: {
              "API-Key": apiKey,
              "API-Sign": krakenSign(path, nonce, postData, secret),
              "content-type": "application/x-www-form-urlencoded",
            },
            body: postData,
          });
          if (!r.ok) throw new Error(`kraken ${path}: ${r.status} ${(await r.text()).slice(0, 200)}`);
          const j = (await r.json()) as { error?: string[]; result?: T };
          const err = (j.error ?? []).join("; ");
          if (err !== "") {
            if (err.includes("Rate limit") && attempt < 4) {
              await new Promise((res) => setTimeout(res, 4000));
              continue;
            }
            throw new Error(`kraken: the API refused: ${err} -- check the key on the Assets page`);
          }
          return j.result as T;
        }
      };
      const body = { result: await priv<Record<string, string>>("/0/private/Balance") };

      // Sum same-asset variants (spot + earn/staking suffixes) exactly.
      const bySymbol = new Map<string, string>();
      for (const [code, amountRaw] of Object.entries(body.result ?? {})) {
        const amount = dec(amountRaw);
        if (decimal.isZero(amount)) continue;
        const symbol = normalizeKrakenAsset(code);
        bySymbol.set(symbol, decimal.add(bySymbol.get(symbol) ?? "0", amount));
      }

      const spot = async (pair: string): Promise<string | null> => {
        try {
          const resp = await doFetch(`${priceApi}/v2/prices/${pair}/spot`);
          if (!resp.ok) return null;
          const j = (await resp.json()) as { data?: { amount?: string } };
          const v = j.data?.amount ?? null;
          return v !== null && /^-?\d+(\.\d+)?$/.test(v) ? v : null;
        } catch {
          return null;
        }
      };

      // Tax lots from the account ledger (issue #64): best effort -- a
      // failed walk (e.g. a funds-only key without "Query ledger
      // entries") leaves positions lot-less and says why in the raw
      // snapshot; it never fails the fetch. Per symbol, the derived net
      // must match the aggregated balance or the lots are withheld.
      const lotNotes: Record<string, LotWalkNote> = {};
      let derived: Map<string, import("./coinbase-lots").LotDerivation> | null = null;
      let walkPages = 0;
      let walkEntries = 0;
      if (opts.lots !== false) {
        const cap = opts.max_history_pages ?? 200;
        const pause = opts.page_pause_ms ?? 1200;
        const entries: KrakenLedgerEntry[] = [];
        try {
          let expected = Infinity;
          for (let ofs = 0; entries.length < expected; ofs += 50) {
            if (walkPages >= cap) throw new Error(`ledger longer than ${String(cap)} pages`);
            const page = await priv<{ count: number; ledger: Record<string, Omit<KrakenLedgerEntry, "id">> }>("/0/private/Ledgers", { ofs: String(ofs) });
            walkPages += 1;
            expected = page.count;
            const rows = Object.entries(page.ledger ?? {}).map(([id, e]) => ({ id, ...e }));
            if (rows.length === 0) break;
            entries.push(...rows);
            if (entries.length < expected && pause > 0) await new Promise((res) => setTimeout(res, pause));
          }
          walkEntries = entries.length;
          derived = deriveKrakenLots(entries, normalizeKrakenAsset);
        } catch (e) {
          derived = null;
          lotNotes["*"] = { pages: walkPages, transactions: entries.length, net: "?", balance: "?", counted: {}, withheld: `ledger walk failed: ${e instanceof Error ? e.message : String(e)}` };
        }
      }
      const lotsFor = (symbol: string, qty: string): import("./coinbase-lots").DerivedLot[] | undefined => {
        if (derived === null || FIAT.has(symbol) || STABLE.has(symbol)) return undefined;
        const d = derived.get(symbol);
        if (d === undefined) return undefined;
        const note: LotWalkNote = { pages: walkPages, transactions: walkEntries, net: d.net, balance: qty, counted: d.counted };
        const gap = decimal.abs(decimal.sub(d.net, qty));
        if (!decimal.isZero(d.shortfall)) note.withheld = `the ledger is missing ${d.shortfall} ${symbol} of earlier inflows`;
        else if (decimal.cmp(gap, "0.00000001") > 0) note.withheld = `the ledger nets ${d.net} ${symbol} but the balance is ${qty}; lots withheld rather than guessed`;
        lotNotes[symbol] = note;
        return note.withheld === undefined ? d.lots : undefined;
      };

      let cash = "0";
      const positions = [];
      for (const [symbol, qty] of [...bySymbol.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        if (symbol === "USD") {
          cash = decimal.add(cash, qty);
          continue;
        }
        const price = await spot(`${symbol}-USD`);
        const lots = lotsFor(symbol, qty);
        const costBasis = lots !== undefined && lots.length > 0 && lots.every((l) => l.cost_basis !== null) ? decimal.sum(lots.map((l) => l.cost_basis as string)) : null;
        positions.push({
          instrument: { symbol, name: symbol, asset_class: (FIAT.has(symbol) ? "cash" : "crypto") as "cash" | "crypto" },
          quantity: qty,
          price,
          market_value: price !== null ? decimal.round(decimal.mul(qty, price), 2) : null,
          cost_basis: costBasis,
          ...(lots !== undefined ? { lots } : {}),
        });
      }

      const total = decimal.add(cash, decimal.sum(positions.map((p) => p.market_value ?? "0")));
      const account = {
        account_id: `acct.${instSlug}.kraken`,
        name: "Kraken",
        type: "crypto" as const,
        currency: "USD",
        as_of: asOf,
        balances: [
          { balance_type: "total", amount: total },
          ...(decimal.isZero(cash) ? [] : [{ balance_type: "cash", amount: cash }]),
        ],
        ...(positions.length > 0 ? { positions } : {}),
      };
      const draft = validateDraftSnapshot(
        { institution_id: opts.institution_id, fetched_at: asOf, via: KRAKEN_VIA, accounts: [account] },
        `kraken ${opts.institution_id}`,
      );
      const raw = JSON.stringify({ balances: body.result ?? {}, lots: lotNotes }, null, 2);
      return {
        raw: [{ bytes: new TextEncoder().encode(raw), filename: `kraken-${asOf.slice(0, 10)}.json`, mime: "application/json", kind: "snapshot" }],
        snapshot: draft,
      };
    },
  };
}
