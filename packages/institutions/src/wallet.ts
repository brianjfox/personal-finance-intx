// Watch-only crypto wallet adapter: a Ledger (or Trezor, or any
// self-custody wallet) read WITHOUT the device -- the operator supplies
// public addresses (or a legacy Bitcoin xpub) and each nightly queries
// public chain data for balances. Read-only is structural: an address
// cannot move funds. The privacy trade-off is real and documented: the
// queried addresses are disclosed to the public API operators
// (mempool.space, blockchain.info, an Ethereum RPC), all configurable.
//
//   btc_address -> mempool.space  /api/address/<addr>   (funded - spent)
//   btc_xpub    -> blockchain.info /multiaddr?active=<xpub>  (LEGACY xpubs
//                  only: the API derives P2PKH addresses, so a modern
//                  segwit zpub reports 0 -- paste addresses instead)
//   eth_address -> JSON-RPC eth_getBalance (native ETH only in v1)
//
// Prices come from Coinbase's public spot endpoint. Satoshis and wei are
// converted with BigInt string math -- floats never touch a quantity.

import { decimal } from "@fin/contracts";
import { type } from "arktype";

import { validateDraftSnapshot, type FetchOutput, type InstitutionAdapter } from "./adapter";

export const WALLET_VIA = "adapter.wallet@1";

export const WalletHolding = type({
  kind: "'btc_address' | 'btc_xpub' | 'eth_address' | 'ltc_address' | 'sol_address'",
  value: "string > 0",
  "label?": "string",
});
export type WalletHolding = typeof WalletHolding.infer;

export interface WalletOptions {
  institution_id: string;
  holdings: WalletHolding[];
  /** Endpoint overrides (tests, self-hosted explorers/nodes). */
  btc_api?: string;
  btc_xpub_api?: string;
  eth_rpc?: string;
  ltc_api?: string;
  sol_rpc?: string;
  price_api?: string;
  fetchImpl?: typeof fetch;
}

export const WALLET_DEFAULTS = {
  btc_api: "https://mempool.space/api",
  btc_xpub_api: "https://blockchain.info",
  eth_rpc: "https://ethereum-rpc.publicnode.com",
  ltc_api: "https://litecoinspace.org/api",
  sol_rpc: "https://api.mainnet-beta.solana.com",
  price_api: "https://api.coinbase.com",
} as const;

/** Integer base units -> decimal string: 123456789 sats, 8 -> "1.23456789". */
export function scaleDown(baseUnits: bigint, decimals: number): string {
  const neg = baseUnits < 0n;
  const abs = neg ? -baseUnits : baseUnits;
  const s = abs.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac === "" ? "" : `.${frac}`}`;
}

export function walletAdapter(opts: WalletOptions): InstitutionAdapter {
  const doFetch = opts.fetchImpl ?? fetch;
  const instSlug = opts.institution_id.replace(/^inst\./, "");
  const cfg = { ...WALLET_DEFAULTS, ...opts };

  const getJson = async <T>(url: string, init?: RequestInit): Promise<T> => {
    const r = await doFetch(url, init);
    if (!r.ok) throw new Error(`wallet ${opts.institution_id}: ${url.split("?")[0]}: ${r.status} ${(await r.text()).slice(0, 200)}`);
    return (await r.json()) as T;
  };

  return {
    institution_id: opts.institution_id,
    via: WALLET_VIA,
    async fetch(ctx): Promise<FetchOutput> {
      const asOf = ctx.now.toISOString();
      const raw: Record<string, unknown> = {};
      let sats = 0n;
      let wei = 0n;
      let litoshis = 0n;
      let lamports = 0n;
      for (const h of opts.holdings) {
        if (h.kind === "btc_address" || h.kind === "ltc_address") {
          // mempool.space and litecoinspace.org run the same API.
          const api = h.kind === "btc_address" ? cfg.btc_api : cfg.ltc_api;
          const a = await getJson<{ chain_stats: { funded_txo_sum: number; spent_txo_sum: number } }>(`${api}/address/${encodeURIComponent(h.value)}`);
          raw[h.value] = a;
          const bal = BigInt(a.chain_stats.funded_txo_sum) - BigInt(a.chain_stats.spent_txo_sum);
          if (h.kind === "btc_address") sats += bal;
          else litoshis += bal;
        } else if (h.kind === "sol_address") {
          const a = await getJson<{ result?: { value?: number }; error?: { message?: string } }>(cfg.sol_rpc, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getBalance", params: [h.value] }),
          });
          if (a.result?.value === undefined) throw new Error(`wallet ${opts.institution_id}: getBalance failed: ${a.error?.message ?? "no result"}`);
          raw[h.value] = a;
          lamports += BigInt(a.result.value);
        } else if (h.kind === "btc_xpub") {
          const a = await getJson<{ wallet: { final_balance: number } }>(`${cfg.btc_xpub_api}/multiaddr?active=${encodeURIComponent(h.value)}&n=0`);
          raw[h.value.slice(0, 20)] = a.wallet;
          sats += BigInt(a.wallet.final_balance);
        } else {
          const a = await getJson<{ result?: string; error?: { message?: string } }>(cfg.eth_rpc, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: [h.value, "latest"] }),
          });
          if (a.result === undefined) throw new Error(`wallet ${opts.institution_id}: eth_getBalance failed: ${a.error?.message ?? "no result"}`);
          raw[h.value] = a;
          wei += BigInt(a.result);
        }
      }

      const spot = async (pair: string): Promise<string | null> => {
        try {
          const r = await doFetch(`${cfg.price_api}/v2/prices/${pair}/spot`);
          if (!r.ok) return null;
          const body = (await r.json()) as { data?: { amount?: string } };
          const v = body.data?.amount ?? null;
          return v !== null && /^-?\d+(\.\d+)?$/.test(v) ? v : null;
        } catch {
          return null;
        }
      };

      const positions = [];
      const holdingsOut: Array<[bigint, number, string, string]> = [
        [sats, 8, "BTC", "Bitcoin"],
        [wei, 18, "ETH", "Ethereum"],
        [litoshis, 8, "LTC", "Litecoin"],
        [lamports, 9, "SOL", "Solana"],
      ];
      for (const [units, decimals, symbol, name] of holdingsOut) {
        if (units === 0n) continue;
        const qty = scaleDown(units, decimals);
        const price = await spot(`${symbol}-USD`);
        positions.push({
          instrument: { symbol, name, asset_class: "crypto" as const },
          quantity: qty,
          price,
          market_value: price !== null ? decimal.round(decimal.mul(qty, price), 2) : null,
          cost_basis: null,
        });
      }

      const total = decimal.sum(positions.map((p) => p.market_value ?? "0"));
      const account = {
        account_id: `acct.${instSlug}.wallet`,
        name: "Self-custody wallet (watch-only)",
        type: "crypto" as const,
        currency: "USD",
        as_of: asOf,
        balances: [{ balance_type: "total", amount: total }],
        ...(positions.length > 0 ? { positions } : {}),
      };
      const draft = validateDraftSnapshot(
        { institution_id: opts.institution_id, fetched_at: asOf, via: WALLET_VIA, accounts: [account] },
        `wallet ${opts.institution_id}`,
      );
      const rawBody = JSON.stringify({ holdings: opts.holdings.map((h) => ({ ...h })), responses: raw }, null, 2);
      return {
        raw: [{ bytes: new TextEncoder().encode(rawBody), filename: `wallet-${asOf.slice(0, 10)}.json`, mime: "application/json", kind: "snapshot" }],
        snapshot: draft,
      };
    },
  };
}
