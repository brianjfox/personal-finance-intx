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
// Movements (issue #95): Bitcoin and Litecoin addresses read their
// confirmed transactions from the same explorer API, a legacy xpub from
// blockchain.info's multiaddr rows; each becomes a transfer valued at the
// day's spot. Ethereum and Solana expose balances only over a bare RPC --
// history needs an indexer -- so those carry no transactions, and the raw
// snapshot says so.
//
// Prices come from Coinbase's public spot endpoint. Satoshis and wei are
// converted with BigInt string math -- floats never touch a quantity.

import { decimal } from "@fin/contracts";
import { type } from "arktype";

import { loggingFetch, validateDraftSnapshot, type FetchOutput, type HttpLogSink, type InstitutionAdapter } from "./adapter";
import { chainTransactions, esploraMovements, historicSpotFetcher, windowStart, type ChainMovement, type EsploraTx, type SnapshotTxn } from "./crypto-flows";

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
  /** Emit the window's on-chain movements as transactions (issue #95). Default on. */
  transactions?: boolean;
  /** Safety bound on explorer history pages per address. */
  max_history_pages?: number;
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
  let httpSink: HttpLogSink | null = null;
  const doFetch = loggingFetch(opts.fetchImpl ?? fetch, () => httpSink);
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
      httpSink = ctx.http ?? null;
      const asOf = ctx.now.toISOString();
      const raw: Record<string, unknown> = {};
      const lookback = ctx.lookback_days ?? 30;
      const since = windowStart(ctx.now, lookback);
      const sinceSec = Math.floor(new Date(since).getTime() / 1000);
      const wantTx = opts.transactions !== false;
      const pageCap = opts.max_history_pages ?? 20;
      const esploraTxs: Record<"btc_address" | "ltc_address", EsploraTx[]> = { btc_address: [], ltc_address: [] };
      const xpubMoves: ChainMovement[] = [];
      const txNotes: Record<string, unknown> = { window_days: lookback, since };
      const unsupported = new Set<string>();
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
          if (wantTx) {
            // Newest first; `/txs/chain/<last txid>` pages further back.
            // Stop once a page has passed the window's start. Best effort:
            // an explorer without history leaves the balance standing and
            // says so in the raw snapshot.
            let path = `${api}/address/${encodeURIComponent(h.value)}/txs`;
            try {
              for (let pages = 0; pages < pageCap; pages++) {
                const page = await getJson<EsploraTx[]>(path);
                esploraTxs[h.kind].push(...page);
                const oldest = page.filter((t) => t.status.confirmed).at(-1);
                if (page.length === 0 || oldest === undefined || (oldest.status.block_time ?? 0) < sinceSec) break;
                path = `${api}/address/${encodeURIComponent(h.value)}/txs/chain/${oldest.txid}`;
              }
            } catch (e) {
              txNotes[`error:${h.value}`] = `history walk failed: ${e instanceof Error ? e.message : String(e)}`;
            }
          }
        } else if (h.kind === "sol_address") {
          const a = await getJson<{ result?: { value?: number }; error?: { message?: string } }>(cfg.sol_rpc, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getBalance", params: [h.value] }),
          });
          if (a.result?.value === undefined) throw new Error(`wallet ${opts.institution_id}: getBalance failed: ${a.error?.message ?? "no result"}`);
          raw[h.value] = a;
          lamports += BigInt(a.result.value);
          unsupported.add("sol_address");
        } else if (h.kind === "btc_xpub") {
          // n=50 rows a page when movements are wanted; the balance is the same either way.
          let offset = 0;
          for (let pages = 0; ; pages++) {
            const a = await getJson<{ wallet: { final_balance: number }; txs?: Array<{ hash: string; time: number; result: number; block_height?: number | null }> }>(
              `${cfg.btc_xpub_api}/multiaddr?active=${encodeURIComponent(h.value)}&n=${wantTx ? "50" : "0"}${offset > 0 ? `&offset=${String(offset)}` : ""}`,
            );
            if (pages === 0) {
              raw[h.value.slice(0, 20)] = a.wallet;
              sats += BigInt(a.wallet.final_balance);
            }
            const rows = a.txs ?? [];
            for (const t of rows) if (t.block_height != null && t.block_height > 0) xpubMoves.push({ txid: t.hash, time: t.time, net: BigInt(t.result) });
            const oldest = rows.at(-1);
            if (!wantTx || rows.length < 50 || oldest === undefined || oldest.time < sinceSec || pages + 1 >= pageCap) break;
            offset += rows.length;
          }
        } else {
          const a = await getJson<{ result?: string; error?: { message?: string } }>(cfg.eth_rpc, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: [h.value, "latest"] }),
          });
          if (a.result === undefined) throw new Error(`wallet ${opts.institution_id}: eth_getBalance failed: ${a.error?.message ?? "no result"}`);
          raw[h.value] = a;
          wei += BigInt(a.result);
          unsupported.add("eth_address");
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

      // Movements, valued at the day's spot (issue #95). A transaction
      // between two of this wallet's own addresses nets to its fee.
      const transactions: SnapshotTxn[] = [];
      if (wantTx) {
        const priceAt = historicSpotFetcher(doFetch, cfg.price_api);
        const mine = (kind: "btc_address" | "ltc_address"): Set<string> => new Set(opts.holdings.filter((h) => h.kind === kind).map((h) => h.value));
        const btcMoves = [...esploraMovements(esploraTxs.btc_address, mine("btc_address")), ...xpubMoves];
        const chains: Array<[ChainMovement[], string, string, number]> = [
          [btcMoves, "BTC", "Bitcoin", 8],
          [esploraMovements(esploraTxs.ltc_address, mine("ltc_address")), "LTC", "Litecoin", 8],
        ];
        for (const [moves, symbol, name, decimals] of chains) {
          if (moves.length === 0) continue;
          const f = await chainTransactions(moves, symbol, name, decimals, scaleDown, since, priceAt);
          transactions.push(...f.rows);
          txNotes[symbol] = { rows: f.rows.length, unvalued: f.unvalued };
        }
        if (unsupported.size > 0) txNotes["unsupported"] = [...unsupported].sort().map((k) => `${k}: balances only -- history needs an indexer`);
        transactions.sort((x, y) => x.posted_at.localeCompare(y.posted_at) || x.txn_id.localeCompare(y.txn_id));
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
        ...(transactions.length > 0 ? { transactions } : {}),
      };
      const draft = validateDraftSnapshot(
        { institution_id: opts.institution_id, fetched_at: asOf, via: WALLET_VIA, accounts: [account] },
        `wallet ${opts.institution_id}`,
      );
      const rawBody = JSON.stringify({ holdings: opts.holdings.map((h) => ({ ...h })), responses: raw, ...(wantTx ? { transactions: txNotes } : {}) }, null, 2);
      return {
        raw: [{ bytes: new TextEncoder().encode(rawBody), filename: `wallet-${asOf.slice(0, 10)}.json`, mime: "application/json", kind: "snapshot" }],
        snapshot: draft,
      };
    },
  };
}
