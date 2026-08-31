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
}

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
      const path = "/0/private/Balance";
      const nonce = String(ctx.now.getTime() * 1000);
      const postData = `nonce=${nonce}`;
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
      const body = (await r.json()) as { error?: string[]; result?: Record<string, string> };
      if ((body.error ?? []).length > 0) {
        throw new Error(`kraken: the API refused: ${body.error!.join("; ")} -- check the key on the Assets page`);
      }

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

      let cash = "0";
      const positions = [];
      for (const [symbol, qty] of [...bySymbol.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        if (symbol === "USD") {
          cash = decimal.add(cash, qty);
          continue;
        }
        const price = await spot(`${symbol}-USD`);
        positions.push({
          instrument: { symbol, name: symbol, asset_class: (FIAT.has(symbol) ? "cash" : "crypto") as "cash" | "crypto" },
          quantity: qty,
          price,
          market_value: price !== null ? decimal.round(decimal.mul(qty, price), 2) : null,
          cost_basis: null,
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
      const raw = JSON.stringify({ balances: body.result ?? {} }, null, 2);
      return {
        raw: [{ bytes: new TextEncoder().encode(raw), filename: `kraken-${asOf.slice(0, 10)}.json`, mime: "application/json", kind: "snapshot" }],
        snapshot: draft,
      };
    },
  };
}
