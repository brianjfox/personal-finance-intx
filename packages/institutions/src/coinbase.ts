// Coinbase connector: crypto holdings via the Coinbase App / Advanced
// Trade API, read-only by key permission (create the CDP API key with
// the View scope only -- the trade/transfer scopes must be absent, not
// unused). Auth is Coinbase's CDP scheme: a short-lived ES256 JWT per
// request (kid = the API key name, iss "cdp", the request's method+host+
// path in the `uri` claim), signed with the EC private key from the
// SecretStore. Balances come from /api/v3/brokerage/accounts; spot
// prices from the public v2 price endpoint. All arithmetic is
// decimal-string exact -- crypto quantities never touch floats.

import crypto from "node:crypto";

import { decimal } from "@fin/contracts";

import { validateDraftSnapshot, type FetchOutput, type InstitutionAdapter } from "./adapter";
import { defaultSecretStore, type SecretStore } from "./secrets";

export const COINBASE_VIA = "adapter.coinbase@1";
export const COINBASE_SERVICE = "fin-coinbase";
export const COINBASE_BASE_URL = "https://api.coinbase.com";

/** Fiat currencies reported as cash instead of positions. */
const FIAT = new Set(["USD", "EUR", "GBP", "CAD", "CHF", "JPY", "AUD"]);

export interface CoinbaseOptions {
  institution_id: string;
  base_url?: string;
  secrets?: SecretStore;
  fetchImpl?: typeof fetch;
}

/** The CDP request JWT: ES256, 2-minute validity, bound to one method+host+path. */
export function coinbaseJwt(keyName: string, privateKeyPem: string, method: string, host: string, path: string, now: Date): string {
  const b64url = (b: Buffer | string): string =>
    (typeof b === "string" ? Buffer.from(b) : b).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  const iat = Math.floor(now.getTime() / 1000);
  const header = b64url(JSON.stringify({ alg: "ES256", kid: keyName, typ: "JWT", nonce: crypto.randomBytes(16).toString("hex") }));
  const payload = b64url(JSON.stringify({ sub: keyName, iss: "cdp", nbf: iat, exp: iat + 120, uri: `${method} ${host}${path}` }));
  // ES256 JWTs need the raw (r||s) signature, not DER.
  const sig = crypto.sign("sha256", Buffer.from(`${header}.${payload}`), { key: privateKeyPem, dsaEncoding: "ieee-p1363" });
  return `${header}.${payload}.${b64url(sig)}`;
}

interface CbAccount {
  uuid: string;
  name?: string;
  currency: string;
  available_balance?: { value: string; currency: string } | null;
  hold?: { value: string; currency: string } | null;
  type?: string;
  active?: boolean;
}

const dec = (s: string | undefined | null): string => {
  const v = (s ?? "0").trim();
  if (!/^-?\d+(\.\d+)?$/.test(v)) throw new Error(`coinbase: not a decimal amount: ${JSON.stringify(s)}`);
  return v;
};

export function coinbaseAdapter(opts: CoinbaseOptions): InstitutionAdapter {
  const secrets = opts.secrets ?? defaultSecretStore();
  const base = opts.base_url ?? COINBASE_BASE_URL;
  const doFetch = opts.fetchImpl ?? fetch;
  const instSlug = opts.institution_id.replace(/^inst\./, "");
  const host = new URL(base).host;

  const authed = async <T>(path: string, now: Date): Promise<T> => {
    const keyName = secrets.get(COINBASE_SERVICE, `api_key_name:${opts.institution_id}`);
    const key = secrets.get(COINBASE_SERVICE, `private_key:${opts.institution_id}`);
    if (keyName === null || key === null) {
      throw new Error(`coinbase ${opts.institution_id}: not connected -- add your Coinbase API key from the Institutions page`);
    }
    const jwt = coinbaseJwt(keyName, key, "GET", host, path.split("?")[0] as string, now);
    const r = await doFetch(`${base}${path}`, { headers: { Authorization: `Bearer ${jwt}` } });
    if (!r.ok) throw new Error(`coinbase ${path}: ${r.status} ${(await r.text()).slice(0, 300)}`);
    return (await r.json()) as T;
  };

  return {
    institution_id: opts.institution_id,
    via: COINBASE_VIA,
    async fetch(ctx): Promise<FetchOutput> {
      const asOf = ctx.now.toISOString();
      const accounts: CbAccount[] = [];
      let cursor: string | null = null;
      do {
        const page: { accounts: CbAccount[]; has_next?: boolean; cursor?: string | null } = await authed(
          `/api/v3/brokerage/accounts?limit=250${cursor !== null ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
          ctx.now,
        );
        accounts.push(...page.accounts);
        cursor = page.has_next === true && page.cursor != null && page.cursor !== "" ? page.cursor : null;
      } while (cursor !== null);

      let cash = "0";
      const positions = [];
      const prices: Record<string, string | null> = {};
      for (const a of accounts) {
        const qty = decimal.add(dec(a.available_balance?.value), dec(a.hold?.value));
        if (decimal.isZero(qty)) continue;
        // USD folds straight into cash; other fiat becomes a cash-class
        // position priced by its -USD spot rate (never face value).
        if (a.currency === "USD") {
          cash = decimal.add(cash, qty);
          continue;
        }
        // Spot price in USD from the public price endpoint; unpriced assets
        // stay as positions with an unknown value rather than a made-up one.
        let price: string | null = null;
        try {
          const spot = await doFetch(`${base}/v2/prices/${encodeURIComponent(a.currency)}-USD/spot`);
          if (spot.ok) {
            const body = (await spot.json()) as { data?: { amount?: string } };
            price = body.data?.amount != null ? dec(body.data.amount) : null;
          }
        } catch {
          price = null;
        }
        prices[a.currency] = price;
        positions.push({
          instrument: { symbol: a.currency, name: a.name ?? a.currency, asset_class: (FIAT.has(a.currency) ? "cash" : "crypto") as "cash" | "crypto" },
          quantity: qty,
          price,
          market_value: price !== null ? decimal.round(decimal.mul(qty, price), 2) : null,
          cost_basis: null,
        });
      }

      const total = decimal.add(cash, decimal.sum(positions.map((p) => p.market_value ?? "0")));
      const account = {
        account_id: `acct.${instSlug}.coinbase`,
        name: "Coinbase",
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
        { institution_id: opts.institution_id, fetched_at: asOf, via: COINBASE_VIA, accounts: [account] },
        `coinbase ${opts.institution_id}`,
      );
      const raw = JSON.stringify({ accounts, prices }, null, 2);
      return {
        raw: [{ bytes: new TextEncoder().encode(raw), filename: `coinbase-${asOf.slice(0, 10)}.json`, mime: "application/json", kind: "snapshot" }],
        snapshot: draft,
      };
    },
  };
}
