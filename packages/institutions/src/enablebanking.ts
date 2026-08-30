// Enable Banking connector (PSD2 AIS -- 2,700+ European banks). Access
// is read-only by regulation: AIS consent cannot move money. The app
// authenticates with RS256 JWTs signed by a private key registered with
// Enable Banking; the operator's bank consent becomes a session valid
// 90-180 days. Credentials (app id, private key PEM, session id) resolve
// through a SecretStore -- the registry entry holds configuration only.
// Each fetch reads the session's accounts, balances, and a transaction
// window, maps ISO 20022 shapes onto the snapshot contract, and returns
// the raw API responses as vault evidence.

import crypto from "node:crypto";

import type { AccountType, TransactionType } from "@fin/contracts";

import { validateDraftSnapshot, type FetchOutput, type InstitutionAdapter } from "./adapter";
import { defaultSecretStore, type SecretStore } from "./secrets";

export const ENABLEBANKING_VIA = "adapter.enablebanking@1";
export const ENABLEBANKING_SERVICE = "fin-enablebanking";
export const ENABLEBANKING_BASE_URL = "https://api.enablebanking.com";

export interface EnableBankingOptions {
  institution_id: string;
  base_url?: string;
  /** Transaction window, days back from today. Default 30. */
  lookback_days?: number;
  secrets?: SecretStore;
  fetchImpl?: typeof fetch;
}

const b64url = (b: Buffer | string): string =>
  (typeof b === "string" ? Buffer.from(b) : b).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

/** RS256 JWT the Enable Banking API expects: kid = application id, one-hour validity. */
export function enableBankingJwt(appId: string, privateKeyPem: string, now: Date): string {
  const iat = Math.floor(now.getTime() / 1000);
  const header = b64url(JSON.stringify({ typ: "JWT", alg: "RS256", kid: appId }));
  const payload = b64url(JSON.stringify({ iss: "enablebanking.com", aud: "api.enablebanking.com", iat, exp: iat + 3600 }));
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${b64url(signer.sign(privateKeyPem))}`;
}

interface EbSession {
  status: string;
  accounts: string[];
  aspsp?: { name?: string; country?: string };
  access?: { valid_until?: string };
}

interface EbAccountDetails {
  account_id?: { iban?: string | null } | null;
  identification_hash?: string | null;
  name?: string | null;
  product?: string | null;
  currency?: string | null;
  cash_account_type?: string | null;
}

interface EbBalance {
  name?: string;
  balance_amount: { currency: string; amount: string };
  balance_type: string;
  reference_date?: string;
}

interface EbTransaction {
  entry_reference?: string | null;
  transaction_amount: { currency: string; amount: string };
  credit_debit_indicator: "CRDT" | "DBIT";
  status: string;
  booking_date?: string | null;
  value_date?: string | null;
  remittance_information?: string[] | null;
  creditor?: { name?: string | null } | null;
  debtor?: { name?: string | null } | null;
  bank_transaction_code?: { description?: string | null } | null;
}

/** ISO ExternalCashAccountType -> the ledger's account type. */
export function mapCashAccountType(t: string | null | undefined): AccountType {
  switch ((t ?? "").toUpperCase()) {
    case "CACC": case "CASH": case "TRAN": return "checking";
    case "SVGS": case "LLSV": case "ONDP": return "savings";
    case "CARD": case "MGLD": return "credit_card";
    case "LOAN": return "loan";
    case "MOMA": return "money_market";
    default: return "checking";
  }
}

/** ISO balance codes: which reported balance is "the" balance, and which is available. */
const TOTAL_ORDER = ["CLBD", "ITBD", "XPCD", "PRCD", "OTHR", "VALU", "OPBD"];
const AVAILABLE_ORDER = ["ITAV", "CLAV", "FWAV"];

function pickBalance(balances: EbBalance[], order: string[]): EbBalance | null {
  for (const code of order) {
    const b = balances.find((x) => x.balance_type?.toUpperCase() === code);
    if (b !== undefined) return b;
  }
  return null;
}

/** Decimal strings from the API, normalized to the ledger's pattern (no "+", no bare "."). */
function dec(s: string): string {
  const clean = s.trim().replace(/^\+/, "");
  if (!/^-?\d+(\.\d+)?$/.test(clean)) throw new Error(`enablebanking: not a decimal amount: ${JSON.stringify(s)}`);
  return clean;
}

function stableTxnId(t: EbTransaction): string {
  if (t.entry_reference != null && t.entry_reference !== "") return t.entry_reference;
  const h = crypto.createHash("sha256").update(JSON.stringify([t.booking_date, t.value_date, t.transaction_amount, t.credit_debit_indicator, t.remittance_information]))
    .digest("hex");
  return `eb-${h.slice(0, 24)}`;
}

export function enableBankingAdapter(opts: EnableBankingOptions): InstitutionAdapter {
  const secrets = opts.secrets ?? defaultSecretStore();
  const base = opts.base_url ?? ENABLEBANKING_BASE_URL;
  const doFetch = opts.fetchImpl ?? fetch;
  const instSlug = opts.institution_id.replace(/^inst\./, "");

  const get = async <T>(path: string, now: Date): Promise<T> => {
    const appId = secrets.get(ENABLEBANKING_SERVICE, "app_id");
    const key = secrets.get(ENABLEBANKING_SERVICE, "private_key");
    if (appId === null || key === null) {
      throw new Error(`enablebanking ${opts.institution_id}: no Enable Banking credentials -- add your Enable Banking keys on the Credentials page`);
    }
    const r = await doFetch(`${base}${path}`, { headers: { Authorization: `Bearer ${enableBankingJwt(appId, key, now)}` } });
    if (!r.ok) {
      const body = await r.text();
      throw new Error(`enablebanking ${path}: ${r.status} ${body.slice(0, 300)}`);
    }
    return (await r.json()) as T;
  };

  return {
    institution_id: opts.institution_id,
    via: ENABLEBANKING_VIA,
    async fetch(ctx): Promise<FetchOutput> {
      const sessionId = secrets.get(ENABLEBANKING_SERVICE, `session:${opts.institution_id}`);
      if (sessionId === null) {
        throw new Error(`enablebanking ${opts.institution_id}: not connected -- run the bank consent flow from the Institutions page`);
      }
      const asOf = ctx.now.toISOString();
      const session = await get<EbSession>(`/sessions/${sessionId}`, ctx.now);
      const validUntil = session.access?.valid_until;
      if (session.status !== "AUTHORIZED" || (validUntil !== undefined && validUntil < asOf)) {
        throw new Error(
          `enablebanking ${opts.institution_id}: the bank consent has expired or was revoked (status ${session.status}) -- reconnect from the Institutions page`,
        );
      }

      const lookback = opts.lookback_days ?? ctx.lookback_days ?? 30;
      const dayFrom = (days: number) => new Date(ctx.now.getTime() - days * 86_400_000).toISOString().slice(0, 10);
      const dateFrom = dayFrom(lookback);
      const raw: Record<string, unknown> = { session };
      const accounts = [];

      const fetchTxns = async (uid: string, from: string): Promise<EbTransaction[]> => {
        const txns: EbTransaction[] = [];
        let continuation: string | null = null;
        do {
          const page: { transactions: EbTransaction[]; continuation_key?: string | null } = await get(
            `/accounts/${uid}/transactions?date_from=${from}${continuation !== null ? `&continuation_key=${encodeURIComponent(continuation)}` : ""}`,
            ctx.now,
          );
          txns.push(...page.transactions);
          continuation = page.continuation_key ?? null;
        } while (continuation !== null);
        return txns;
      };

      for (const uid of session.accounts) {
        const details = await get<EbAccountDetails>(`/accounts/${uid}/details`, ctx.now);
        const balResp = await get<{ balances: EbBalance[] }>(`/accounts/${uid}/balances`, ctx.now);
        let txns: EbTransaction[];
        try {
          txns = await fetchTxns(uid, dateFrom);
        } catch (e) {
          // ASPSPs cap transaction history (often 90-180 days) and some
          // refuse a deeper date_from outright. A widened backfill window
          // must not cost the fetch: fall back to the default window.
          if (lookback <= 30) throw e;
          txns = await fetchTxns(uid, dayFrom(30));
        }
        raw[uid] = { details, balances: balResp.balances, transactions: txns };

        const type = mapCashAccountType(details.cash_account_type);
        const liability = type === "credit_card" || type === "loan";
        const currency = details.currency ?? balResp.balances[0]?.balance_amount.currency ?? "EUR";
        const total = pickBalance(balResp.balances, TOTAL_ORDER);
        const available = pickBalance(balResp.balances, AVAILABLE_ORDER);
        const balances: Array<{ balance_type: string; amount: string }> = [];
        if (total !== null) {
          const amt = dec(total.balance_amount.amount);
          balances.push({ balance_type: liability ? "owed" : "total", amount: liability ? amt.replace(/^-/, "") : amt });
        }
        if (!liability && available !== null) balances.push({ balance_type: "available", amount: dec(available.balance_amount.amount) });

        const transactions = txns
          .filter((t) => t.status === "BOOK")
          .map((t) => {
            const magnitude = dec(t.transaction_amount.amount).replace(/^-/, "");
            const outflow = t.credit_debit_indicator === "DBIT";
            const description =
              (t.remittance_information ?? []).filter((s) => s !== "").join(" ") ||
              t.creditor?.name || t.debtor?.name || t.bank_transaction_code?.description || "transaction";
            return {
              txn_id: stableTxnId(t),
              posted_at: `${t.booking_date ?? t.value_date ?? asOf.slice(0, 10)}T00:00:00.000Z`,
              amount: outflow ? `-${magnitude}` : magnitude,
              type: (outflow ? "debit" : "credit") as TransactionType,
              description,
            };
          });

        const stableId = (details.identification_hash ?? details.account_id?.iban ?? uid).replace(/[^A-Za-z0-9_-]+/g, "_");
        accounts.push({
          account_id: `acct.${instSlug}.${stableId}`,
          name: details.name ?? details.product ?? details.account_id?.iban ?? uid,
          type,
          currency,
          masked_number: details.account_id?.iban != null ? `••••${details.account_id.iban.slice(-4)}` : null,
          as_of: asOf,
          balances,
          ...(transactions.length > 0 ? { transactions } : {}),
        });
      }

      const draft = validateDraftSnapshot(
        { institution_id: opts.institution_id, fetched_at: asOf, via: ENABLEBANKING_VIA, accounts },
        `enablebanking ${opts.institution_id}`,
      );
      return {
        raw: [{
          bytes: new TextEncoder().encode(JSON.stringify(raw, null, 2)),
          filename: `enablebanking-${asOf.slice(0, 10)}.json`,
          mime: "application/json",
          kind: "snapshot",
        }],
        snapshot: draft,
      };
    },
  };
}
