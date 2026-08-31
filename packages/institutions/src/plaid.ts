// Plaid connector (US/Canada; Chase et al. via OAuth). Read-only by
// construction: only data products are called -- balances, transactions,
// investment holdings -- never Transfer. Credentials resolve through a
// SecretStore (Keychain/env; see secrets.ts): the registry entry holds
// configuration only, never a secret. Each fetch is a stateless snapshot
// -- balances now, transactions over a lookback window (re-observing a
// transaction is idempotent: facts key on txn_id) -- and the raw API
// responses are returned as a document so the vault keeps the evidence.

import type { AccountType, AssetClass, TransactionType } from "@fin/contracts";

import { loggingFetch, validateDraftSnapshot, type FetchOutput, type HttpLogSink, type InstitutionAdapter } from "./adapter";
import { defaultSecretStore, type SecretStore } from "./secrets";

export const PLAID_VIA = "adapter.plaid@1";
export const PLAID_SERVICE = "fin-plaid";

export const PLAID_BASE_URLS = {
  sandbox: "https://sandbox.plaid.com",
  production: "https://production.plaid.com",
} as const;

export interface PlaidOptions {
  institution_id: string;
  /** Which Plaid environment; ignored when base_url is given (tests, mocks). */
  environment?: keyof typeof PLAID_BASE_URLS;
  base_url?: string;
  /** Transaction window, days back from today. Default 30. */
  lookback_days?: number;
  secrets?: SecretStore;
  fetchImpl?: typeof fetch;
}

interface PlaidAccount {
  account_id: string;
  name: string;
  official_name?: string | null;
  mask?: string | null;
  type: string;
  subtype?: string | null;
  balances: {
    current?: number | null;
    available?: number | null;
    limit?: number | null;
    iso_currency_code?: string | null;
    unofficial_currency_code?: string | null;
  };
}

interface PlaidTransaction {
  transaction_id: string;
  account_id: string;
  /** Plaid: positive = money OUT of the account. The ledger's convention is the opposite. */
  amount: number;
  date: string;
  name: string;
  merchant_name?: string | null;
  pending: boolean;
  iso_currency_code?: string | null;
  personal_finance_category?: { primary?: string } | null;
}

interface PlaidHolding {
  account_id: string;
  security_id: string;
  quantity: number;
  institution_price?: number | null;
  institution_value?: number | null;
  cost_basis?: number | null;
}

interface PlaidSecurity {
  security_id: string;
  ticker_symbol?: string | null;
  name?: string | null;
  type?: string | null;
  is_cash_equivalent?: boolean | null;
}

/** (type, subtype) -> the ledger's account type. */
export function mapPlaidAccountType(type: string, subtype: string | null | undefined): AccountType {
  const sub = (subtype ?? "").toLowerCase();
  switch (type) {
    case "depository":
      if (sub === "savings" || sub === "cd") return "savings";
      if (sub === "money market") return "money_market";
      if (sub === "hsa") return "hsa";
      return "checking";
    case "credit":
      return "credit_card";
    case "loan":
      return sub === "mortgage" || sub === "home equity" ? (sub === "home equity" ? "heloc" : "mortgage") : "loan";
    case "investment":
    case "brokerage":
      if (sub.includes("401")) return "401k";
      if (sub === "roth" || sub === "roth 401k") return "roth_ira";
      if (sub === "ira" || sub === "sep ira" || sub === "simple ira" || sub === "rollover ira") return "ira";
      if (sub === "529") return "529";
      if (sub === "hsa") return "hsa";
      if (sub === "crypto exchange") return "crypto";
      return "brokerage";
    case "other":
    default:
      return "other";
  }
}

function mapSecurityClass(t: string | null | undefined): AssetClass {
  switch ((t ?? "").toLowerCase()) {
    case "equity": return "equity";
    case "etf": return "etf";
    case "mutual fund": return "mutual_fund";
    case "fixed income": return "bond";
    case "cash": return "cash";
    case "cryptocurrency": return "crypto";
    case "derivative": return "option";
    default: return "other";
  }
}

/** Numbers from Plaid become plain decimal strings (the ledger never holds floats). */
function dec(n: number): string {
  if (!Number.isFinite(n)) throw new Error(`plaid: non-finite number ${n}`);
  // toFixed(2) would lose share quantities; round-trip via String and strip exponents.
  const s = String(n);
  if (/^-?\d+(\.\d+)?$/.test(s)) return s;
  return n.toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
}

/**
 * The transaction description the ledger records. The raw statement
 * descriptor is authoritative (it can carry per-charge detail like the
 * billed domain); Plaid's cleaned merchant_name is prepended only when
 * the raw descriptor doesn't already say it.
 */
export function describePlaid(t: { name: string; merchant_name?: string | null }): string {
  const raw = t.name.trim();
  const merchant = (t.merchant_name ?? "").trim();
  if (raw === "") return merchant === "" ? "transaction" : merchant;
  if (merchant === "" || raw.toLowerCase().includes(merchant.toLowerCase())) return raw;
  return `${merchant} · ${raw}`;
}

/** Plaid errors tolerated per product: the account data still lands without that product. */
const TOLERATED = new Set(["PRODUCT_NOT_READY", "PRODUCTS_NOT_SUPPORTED", "NO_INVESTMENT_ACCOUNTS", "NO_ACCOUNTS"]);

export function plaidAdapter(opts: PlaidOptions): InstitutionAdapter {
  const secrets = opts.secrets ?? defaultSecretStore();
  const base = opts.base_url ?? PLAID_BASE_URLS[opts.environment ?? "production"];
  let httpSink: HttpLogSink | null = null;
  const doFetch = loggingFetch(opts.fetchImpl ?? fetch, () => httpSink);
  const instSlug = opts.institution_id.replace(/^inst\./, "");

  const call = async <T>(path: string, body: Record<string, unknown>): Promise<T> => {
    const clientId = secrets.get(PLAID_SERVICE, "client_id");
    const secret = secrets.get(PLAID_SERVICE, "secret");
    if (clientId === null || secret === null) {
      throw new Error(`plaid ${opts.institution_id}: no Plaid credentials -- add your Plaid keys on the Credentials page`);
    }
    const r = await doFetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_id: clientId, secret, ...body }),
    });
    const json = (await r.json()) as Record<string, unknown> & { error_code?: string; error_message?: string };
    if (!r.ok) {
      const code = json.error_code ?? String(r.status);
      throw Object.assign(new Error(`plaid ${path}: ${code} ${json.error_message ?? ""}`.trim()), { plaidCode: json.error_code });
    }
    return json as T;
  };

  const tolerated = async <T>(path: string, body: Record<string, unknown>): Promise<T | null> => {
    try {
      return await call<T>(path, body);
    } catch (e) {
      if (e instanceof Error && TOLERATED.has((e as { plaidCode?: string }).plaidCode ?? "")) return null;
      throw e;
    }
  };

  return {
    institution_id: opts.institution_id,
    via: PLAID_VIA,
    async fetch(ctx): Promise<FetchOutput> {
      httpSink = ctx.http ?? null;
      const accessToken = secrets.get(PLAID_SERVICE, `access_token:${opts.institution_id}`);
      if (accessToken === null) {
        throw new Error(`plaid ${opts.institution_id}: not connected -- run the Plaid connect flow from the Assets page`);
      }
      const asOf = ctx.now.toISOString();
      const lookback = opts.lookback_days ?? ctx.lookback_days ?? 30;
      const start = new Date(ctx.now.getTime() - lookback * 86_400_000).toISOString().slice(0, 10);
      const end = asOf.slice(0, 10);

      const balanceResp = await call<{ accounts: PlaidAccount[]; item: unknown }>("/accounts/balance/get", {
        access_token: accessToken,
      });

      // Transactions over the window, paged. Tolerated errors (product not
      // ready on a fresh item) leave the accounts/balances intact.
      const transactions: PlaidTransaction[] = [];
      let offset = 0;
      for (;;) {
        const page = await tolerated<{ transactions: PlaidTransaction[]; total_transactions: number }>(
          "/transactions/get",
          { access_token: accessToken, start_date: start, end_date: end, options: { count: 500, offset } },
        );
        if (page === null) break;
        transactions.push(...page.transactions);
        offset = transactions.length;
        if (offset >= page.total_transactions || page.transactions.length === 0) break;
      }

      const invest = await tolerated<{ holdings: PlaidHolding[]; securities: PlaidSecurity[] }>(
        "/investments/holdings/get",
        { access_token: accessToken },
      );
      const securities = new Map((invest?.securities ?? []).map((s) => [s.security_id, s]));

      const accounts = balanceResp.accounts.map((a) => {
        const type = mapPlaidAccountType(a.type, a.subtype);
        const currency = a.balances.iso_currency_code ?? a.balances.unofficial_currency_code ?? "USD";
        const liability = type === "credit_card" || type === "mortgage" || type === "loan" || type === "heloc";
        const balances: Array<{ balance_type: string; amount: string }> = [];
        if (a.balances.current != null) {
          balances.push({ balance_type: liability ? "owed" : "total", amount: dec(liability ? Math.abs(a.balances.current) : a.balances.current) });
        }
        if (!liability && a.balances.available != null) balances.push({ balance_type: "available", amount: dec(a.balances.available) });
        if (liability && a.balances.limit != null) balances.push({ balance_type: "credit_limit", amount: dec(a.balances.limit) });

        const myTx = transactions
          .filter((t) => t.account_id === a.account_id && !t.pending)
          .map((t) => ({
            txn_id: t.transaction_id,
            posted_at: `${t.date}T00:00:00.000Z`,
            // Flip the sign: Plaid positive = outflow; the ledger's positive = inflow.
            amount: dec(-t.amount),
            type: (t.amount > 0 ? "debit" : "credit") as TransactionType,
            // The RAW statement descriptor, not Plaid's cleaned merchant_name:
            // the raw name is what distinguishes two same-day charges from the
            // same merchant (e.g. Google Workspace billed per domain), and the
            // duplicate detector keys on it. Prefix the merchant only when it
            // adds information the descriptor lacks.
            description: describePlaid(t),
            raw_category: t.personal_finance_category?.primary ?? null,
          }));

        const myHoldings = (invest?.holdings ?? []).filter((h) => h.account_id === a.account_id);
        const positions = myHoldings
          .map((h) => ({ h, s: securities.get(h.security_id) }))
          .filter(({ s }) => s?.is_cash_equivalent !== true && (s?.type ?? "") !== "cash")
          .map(({ h, s }) => ({
            instrument: {
              symbol: s?.ticker_symbol ?? h.security_id,
              name: s?.name ?? null,
              asset_class: mapSecurityClass(s?.type),
            },
            quantity: dec(h.quantity),
            price: h.institution_price != null ? dec(h.institution_price) : null,
            market_value: h.institution_value != null ? dec(h.institution_value) : null,
            cost_basis: h.cost_basis != null ? dec(h.cost_basis) : null,
          }));

        return {
          account_id: `acct.${instSlug}.${a.account_id.replace(/[^A-Za-z0-9_-]+/g, "_")}`,
          name: a.official_name ?? a.name,
          type,
          currency,
          masked_number: a.mask != null ? `••••${a.mask}` : null,
          as_of: asOf,
          balances,
          ...(positions.length > 0 ? { positions } : {}),
          ...(myTx.length > 0 ? { transactions: myTx } : {}),
        };
      });

      const draft = validateDraftSnapshot(
        // Plaid enumerates the item's full account list: an open ledger
        // account this feed stops reporting has genuinely gone away.
        { institution_id: opts.institution_id, fetched_at: asOf, via: PLAID_VIA, accounts, complete: true },
        `plaid ${opts.institution_id}`,
      );
      const rawBody = JSON.stringify(
        { accounts: balanceResp.accounts, item: balanceResp.item, transactions, holdings: invest?.holdings ?? [], securities: invest?.securities ?? [] },
        null,
        2,
      );
      return {
        raw: [{ bytes: new TextEncoder().encode(rawBody), filename: `plaid-${end}.json`, mime: "application/json", kind: "snapshot" }],
        snapshot: draft,
      };
    },
  };
}
