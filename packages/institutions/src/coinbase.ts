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

import { loggingFetch, validateDraftSnapshot, type FetchOutput, type HttpLogSink, type InstitutionAdapter } from "./adapter";
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

/**
 * Coinbase hands out two key formats: modern CDP keys are Ed25519,
 * downloaded as a base64 string (64 bytes: seed||public key, sometimes
 * just the 32-byte seed) inside a JSON file; older keys are ECDSA as a
 * SEC1/PKCS8 PEM block. Auto-detect, and pick the JWT algorithm the key
 * dictates (EdDSA vs ES256).
 */
export function parseCoinbaseKey(raw: string): { key: crypto.KeyObject; alg: "ES256" | "EdDSA" } {
  const input = raw.trim().replace(/\\n/g, "\n");
  if (input.includes("BEGIN")) {
    let key: crypto.KeyObject;
    try {
      key = crypto.createPrivateKey(input);
    } catch (e) {
      throw new Error(`coinbase: that PEM block doesn't parse as a private key (${e instanceof Error ? e.message : String(e)})`);
    }
    return { key, alg: key.asymmetricKeyType === "ed25519" ? "EdDSA" : "ES256" };
  }
  if (/^[A-Za-z0-9+/]+=*$/.test(input)) {
    const bytes = Buffer.from(input, "base64");
    if (bytes.length === 32 || bytes.length === 64) {
      // PKCS8 DER wrapper for a raw Ed25519 seed (the first 32 bytes).
      const der = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), bytes.subarray(0, 32)]);
      return { key: crypto.createPrivateKey({ key: der, format: "der", type: "pkcs8" }), alg: "EdDSA" };
    }
  }
  throw new Error(
    "coinbase: unrecognized private key -- paste either the base64 Ed25519 key from the downloaded CDP key file (or the whole JSON file), or a PEM block (BEGIN ... PRIVATE KEY)",
  );
}

/**
 * The downloaded CDP key file is JSON ({"name": "organizations/...",
 * "privateKey": "..."}). Accept it pasted whole: the JSON's own fields
 * win, since they are exactly what the portal issued.
 */
export function parseCoinbaseCredential(apiKeyName: string, privateKeyRaw: string): { apiKeyName: string; privateKey: string } {
  const trimmed = privateKeyRaw.trim();
  if (trimmed.startsWith("{")) {
    try {
      const j = JSON.parse(trimmed) as { name?: unknown; privateKey?: unknown };
      if (typeof j.privateKey === "string" && j.privateKey !== "") {
        return { apiKeyName: typeof j.name === "string" && j.name !== "" ? j.name : apiKeyName.trim(), privateKey: j.privateKey };
      }
    } catch {
      /* not JSON after all; fall through */
    }
  }
  return { apiKeyName: apiKeyName.trim(), privateKey: trimmed };
}

/** The CDP request JWT: EdDSA or ES256 per the key, 2-minute validity, bound to one method+host+path. */
export function coinbaseJwt(keyName: string, privateKeyRaw: string, method: string, host: string, path: string, now: Date): string {
  const b64url = (b: Buffer | string): string =>
    (typeof b === "string" ? Buffer.from(b) : b).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  const { key, alg } = parseCoinbaseKey(privateKeyRaw);
  const iat = Math.floor(now.getTime() / 1000);
  const header = b64url(JSON.stringify({ alg, kid: keyName, typ: "JWT", nonce: crypto.randomBytes(16).toString("hex") }));
  const payload = b64url(JSON.stringify({ sub: keyName, iss: "cdp", nbf: iat, exp: iat + 120, uri: `${method} ${host}${path}` }));
  const data = Buffer.from(`${header}.${payload}`);
  // ES256 JWTs need the raw (r||s) signature, not DER; Ed25519 signs the data directly.
  const sig = alg === "ES256" ? crypto.sign("sha256", data, { key, dsaEncoding: "ieee-p1363" }) : crypto.sign(null, data, key);
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
  let httpSink: HttpLogSink | null = null;
  const doFetch = loggingFetch(opts.fetchImpl ?? fetch, () => httpSink);
  const instSlug = opts.institution_id.replace(/^inst\./, "");
  const host = new URL(base).host;

  const authed = async <T>(path: string, now: Date): Promise<T> => {
    const keyName = secrets.get(COINBASE_SERVICE, `api_key_name:${opts.institution_id}`);
    const key = secrets.get(COINBASE_SERVICE, `private_key:${opts.institution_id}`);
    if (keyName === null || key === null) {
      throw new Error(`coinbase ${opts.institution_id}: not connected -- add your Coinbase API key from the Assets page`);
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
      httpSink = ctx.http ?? null;
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
