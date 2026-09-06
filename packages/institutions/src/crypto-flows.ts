// Transaction facts for the crypto connectors (issue #95, D-034's open
// item). Coinbase and Kraken already walk their complete histories to
// derive tax lots; the watch-only wallet reads public chain data. These
// pure mappers turn the same records, restricted to the rolling
// lookback window, into `SnapshotTransaction`s in the canonical shape
// the bank and broker adapters emit -- so cash flow, the Flow Summary,
// and the Ledger Analyst see crypto movement too.
//
// Sign convention (the ledger's): `amount` is USD, positive = value into
// the account; `quantity` is the asset moved, same sign. A buy inside an
// exchange is value into the crypto wallet and out of the fiat wallet --
// both legs land, both are `buy`/`sell`, and cash flow excludes them as
// internal conversion (D-034); what counts is the fiat that arrived or
// left, and on-chain sends and receives.
//
// Valuation is honest about its source: Coinbase states a USD
// `native_amount` per row; Kraken and the chains state none, so crypto
// legs are valued at the day's spot (the public price endpoint's
// `?date=`) and the description says so. A leg no price can be found
// for is counted, not guessed.

import { decimal, type SnapshotAccount } from "@fin/contracts";

import type { KrakenLedgerEntry } from "./kraken-lots";

export type SnapshotTxn = NonNullable<SnapshotAccount["transactions"]>[number];
type TxnType = SnapshotTxn["type"];

/** Spot price of `symbol` in USD on an ISO date (YYYY-MM-DD), or null when unknown. */
export type PriceAt = (symbol: string, dateIso: string) => Promise<string | null>;

export interface FlowsResult {
  rows: SnapshotTxn[];
  /** Movements inside the window that could not be valued in USD (no stated or historic price). */
  unvalued: number;
}

const DEC = /^-?\d+(\.\d+)?$/;
const FIAT = new Set(["USD", "EUR", "GBP", "CAD", "CHF", "JPY", "AUD"]);
const USD_LIKE = new Set(["USD", "USDC", "USDT", "DAI", "PYUSD", "USDP", "GUSD", "TUSD"]);

const instrumentOf = (symbol: string, name?: string | null): NonNullable<SnapshotTxn["instrument"]> => ({
  symbol,
  name: name ?? symbol,
  asset_class: FIAT.has(symbol) ? "cash" : "crypto",
});

/** The start of the rolling window, `days` back from `now`, as ISO. */
export function windowStart(now: Date, days: number): string {
  return new Date(now.getTime() - days * 86_400_000).toISOString();
}

/**
 * Historic spot with a per-fetch cache: one call per (symbol, day). The
 * Coinbase public endpoint answers `?date=YYYY-MM-DD` for any pair it
 * quotes, fiat crosses (EUR-USD) included.
 */
export function historicSpotFetcher(doFetch: typeof fetch, priceApi: string): PriceAt {
  const cache = new Map<string, Promise<string | null>>();
  return (symbol, dateIso) => {
    const key = `${symbol}|${dateIso}`;
    let p = cache.get(key);
    if (p === undefined) {
      p = (async () => {
        try {
          const r = await doFetch(`${priceApi}/v2/prices/${encodeURIComponent(symbol)}-USD/spot?date=${dateIso}`);
          if (!r.ok) return null;
          const body = (await r.json()) as { data?: { amount?: string } };
          const v = body.data?.amount ?? null;
          return v !== null && DEC.test(v) ? v : null;
        } catch {
          return null;
        }
      })();
      cache.set(key, p);
    }
    return p;
  };
}

// --- Coinbase ------------------------------------------------------------

export interface CoinbaseFlowTxn {
  id: string;
  type: string;
  status: string;
  created_at: string;
  amount: { amount: string; currency: string };
  native_amount?: { amount: string; currency: string } | null;
  details?: { title?: string | null; subtitle?: string | null; header?: string | null } | null;
}

const COINBASE_INCOME = new Set(["staking_reward", "earn_payout", "interest", "inflation_reward", "reward", "incentives_rewards_payout", "rewards", "cardspend_reward"]);
const COINBASE_IN = new Set(["receive", "pro_deposit", "exchange_deposit", "fiat_deposit", "retail_simple_dust", "tx"]);
const COINBASE_OUT = new Set(["pro_withdrawal", "exchange_withdrawal", "fiat_withdrawal", "vault_withdrawal"]);

function coinbaseType(t: CoinbaseFlowTxn, positive: boolean): TxnType {
  switch (t.type) {
    case "buy":
      return "buy";
    case "sell":
      return "sell";
    case "advanced_trade_fill":
      return positive ? "buy" : "sell";
    case "trade":
      return "swap"; // Coinbase Convert: one leg per currency wallet
    case "send":
      return positive ? "transfer_in" : "transfer_out";
    case "fee":
      return "fee";
    default:
      if (COINBASE_INCOME.has(t.type)) return "income";
      if (COINBASE_IN.has(t.type)) return "transfer_in";
      if (COINBASE_OUT.has(t.type)) return "transfer_out";
      return positive ? "transfer_in" : "transfer_out";
  }
}

/**
 * One Coinbase currency wallet's completed history -> the window's
 * transactions. `currency` is the wallet's asset; the consolidated
 * account is USD, so a fiat wallet's rows carry no instrument and a
 * crypto wallet's rows carry the asset and its signed quantity.
 */
export function coinbaseTransactions(txns: readonly CoinbaseFlowTxn[], currency: string, windowStartIso: string, native = "USD"): FlowsResult {
  const rows: SnapshotTxn[] = [];
  let unvalued = 0;
  for (const t of txns) {
    if (t.status !== "completed" || !DEC.test(t.amount?.amount ?? "") || t.created_at < windowStartIso) continue;
    const qty = t.amount.amount;
    if (decimal.isZero(qty)) continue;
    const positive = decimal.cmp(qty, "0") > 0;
    let amount: string;
    if (currency === native) {
      amount = qty;
    } else if (t.native_amount != null && t.native_amount.currency === native && DEC.test(t.native_amount.amount)) {
      const abs = decimal.abs(t.native_amount.amount);
      amount = positive ? abs : decimal.neg(abs);
    } else {
      unvalued += 1;
      continue;
    }
    const title = (t.details?.title ?? "").trim();
    const subtitle = (t.details?.subtitle ?? "").trim();
    const description = title !== "" ? (subtitle !== "" ? `${title} — ${subtitle}` : title) : `${t.type.replace(/_/g, " ")} ${currency}`;
    rows.push({
      txn_id: t.id,
      posted_at: new Date(t.created_at).toISOString(),
      amount,
      type: coinbaseType(t, positive),
      description,
      instrument: currency === native ? null : instrumentOf(currency),
      quantity: currency === native ? null : qty,
      raw_category: t.type,
    });
  }
  return { rows, unvalued };
}

// --- Kraken --------------------------------------------------------------

const KRAKEN_INTERNAL = new Set(["spottostaking", "stakingfromspot", "stakingtospot", "spotfromstaking"]);
const KRAKEN_INCOME_TYPES = new Set(["staking", "earn", "reward", "dividend"]);

const isoDay = (iso: string): string => iso.slice(0, 10);
const fmtQty = (q: string): string => decimal.abs(q);

/**
 * Kraken's ledger entries -> the window's transactions. Entries sharing a
 * `refid` are one movement: a fiat-funded trade is one buy/sell valued
 * by its fiat leg; a crypto-to-crypto trade is one swap; a deposit,
 * withdrawal, or staking payout is one transfer/income row. Crypto legs
 * are valued at the day's spot via `priceAt`; USD-like stablecoins at par.
 */
export async function krakenTransactions(
  entries: readonly KrakenLedgerEntry[],
  toSymbol: (code: string) => string,
  windowStartIso: string,
  priceAt: PriceAt,
): Promise<FlowsResult> {
  const startSec = new Date(windowStartIso).getTime() / 1000;
  const rows: SnapshotTxn[] = [];
  let unvalued = 0;
  const inWindow = entries
    .filter((e) => DEC.test(e.amount) && DEC.test(e.fee) && !KRAKEN_INTERNAL.has(e.subtype ?? "") && e.time >= startSec)
    .sort((a, b) => a.time - b.time || a.id.localeCompare(b.id));
  const groups = new Map<string, KrakenLedgerEntry[]>();
  for (const e of inWindow) {
    const list = groups.get(e.refid) ?? [];
    list.push(e);
    groups.set(e.refid, list);
  }
  // A USD value for one leg: stated for USD-like, converted at the day's spot otherwise.
  const usdValue = async (sym: string, qtyAbs: string, day: string): Promise<string | null> => {
    if (USD_LIKE.has(sym)) return qtyAbs;
    const px = await priceAt(sym, day);
    return px === null ? null : decimal.round(decimal.mul(qtyAbs, px), 2);
  };
  for (const [refid, legs] of groups) {
    const at = new Date((legs[0]?.time ?? 0) * 1000).toISOString();
    const day = isoDay(at);
    const netOf = (e: KrakenLedgerEntry): string => decimal.sub(e.amount, e.fee);
    const typed = legs.map((e) => ({ e, sym: toSymbol(e.asset), net: netOf(e) })).filter((l) => !decimal.isZero(l.net));
    if (typed.length === 0) continue;
    const fiat = typed.filter((l) => FIAT.has(l.sym) || USD_LIKE.has(l.sym));
    const cryptoLegs = typed.filter((l) => !FIAT.has(l.sym) && !USD_LIKE.has(l.sym));
    const kind = legs[0]?.type ?? "";
    const tradeLike = kind === "trade" || kind === "receive" || kind === "spend";

    if (tradeLike && cryptoLegs.length === 1 && fiat.length >= 1) {
      // Fiat-funded buy or sell: the fiat leg (net of its fee) is the value.
      const c = cryptoLegs[0]!;
      let value = "0";
      let ok = true;
      for (const f of fiat) {
        const v = await usdValue(f.sym, decimal.abs(f.net), day);
        if (v === null) { ok = false; break; }
        value = decimal.add(value, decimal.cmp(f.net, "0") < 0 ? decimal.neg(v) : v);
      }
      if (!ok) { unvalued += 1; continue; }
      const buying = decimal.cmp(c.net, "0") > 0;
      rows.push({
        txn_id: refid,
        posted_at: at,
        // Value INTO the account for the crypto wallet: a buy brings the asset in (positive), paid for by the fiat leg.
        amount: decimal.neg(value),
        type: buying ? "buy" : "sell",
        description: `${buying ? "Bought" : "Sold"} ${fmtQty(c.net)} ${c.sym} for ${fiat.map((f) => f.sym).join("+")}`,
        instrument: instrumentOf(c.sym),
        quantity: c.net,
        raw_category: kind,
      });
      // The fiat leg itself, so the account's USD wallet history is complete (excluded from cash flow as a conversion).
      rows.push({
        txn_id: `${refid}:fiat`,
        posted_at: at,
        amount: value,
        type: buying ? "buy" : "sell",
        description: `${buying ? "Paid for" : "Proceeds of"} ${fmtQty(c.net)} ${c.sym}`,
        instrument: null,
        quantity: null,
        raw_category: kind,
      });
      continue;
    }
    if (tradeLike && cryptoLegs.length === 2 && fiat.length === 0) {
      const got = cryptoLegs.find((l) => decimal.cmp(l.net, "0") > 0);
      const gave = cryptoLegs.find((l) => decimal.cmp(l.net, "0") < 0);
      if (got !== undefined && gave !== undefined) {
        const v = await usdValue(got.sym, decimal.abs(got.net), day);
        rows.push({
          txn_id: refid,
          posted_at: at,
          amount: v ?? "0",
          type: "swap",
          description: `Swapped ${fmtQty(gave.net)} ${gave.sym} for ${fmtQty(got.net)} ${got.sym}${v === null ? " (no USD value found)" : " · valued at the day's spot"}`,
          instrument: instrumentOf(got.sym),
          quantity: got.net,
          raw_category: kind,
          swap_from: { instrument: instrumentOf(gave.sym), quantity: decimal.abs(gave.net) },
        });
        if (v === null) unvalued += 1;
        continue;
      }
    }
    // Everything else: one row per leg (deposits, withdrawals, staking, transfers).
    for (const l of typed) {
      const positive = decimal.cmp(l.net, "0") > 0;
      const t = l.e.type;
      const type: TxnType = KRAKEN_INCOME_TYPES.has(t) && positive ? "income" : t === "deposit" ? "transfer_in" : t === "withdrawal" ? "transfer_out" : positive ? "transfer_in" : "transfer_out";
      const isFiat = FIAT.has(l.sym) || USD_LIKE.has(l.sym);
      const v = await usdValue(l.sym, decimal.abs(l.net), day);
      if (v === null) { unvalued += 1; continue; }
      const verb = type === "income" ? "Staking reward" : type === "transfer_in" ? "Deposit" : "Withdrawal";
      rows.push({
        txn_id: legs.length === 1 ? l.e.id : `${refid}:${l.e.id}`,
        posted_at: at,
        amount: positive ? v : decimal.neg(v),
        type,
        description: `${verb} ${fmtQty(l.net)} ${l.sym}${isFiat ? "" : " · valued at the day's spot"}`,
        instrument: l.sym === "USD" ? null : instrumentOf(l.sym),
        quantity: l.sym === "USD" ? null : l.net,
        raw_category: t + ((l.e.subtype ?? "") !== "" ? `:${l.e.subtype}` : ""),
      });
    }
  }
  return { rows, unvalued };
}

// --- Chains (watch-only wallet) -------------------------------------------

/** One confirmed on-chain movement, net for the wallet's addresses, in base units (sats, litoshis). */
export interface ChainMovement {
  txid: string;
  /** Block time, unix seconds. */
  time: number;
  /** Net base units into the wallet (negative = out, fee included). */
  net: bigint;
}

/** mempool.space / litecoinspace.org `/address/:addr/txs` row. */
export interface EsploraTx {
  txid: string;
  status: { confirmed: boolean; block_time?: number };
  vin: Array<{ prevout?: { scriptpubkey_address?: string; value?: number } | null }>;
  vout: Array<{ scriptpubkey_address?: string; value?: number }>;
}

/** Net effect of Esplora transactions on a SET of addresses, deduped by txid; unconfirmed rows skipped. */
export function esploraMovements(txs: readonly EsploraTx[], mine: ReadonlySet<string>): ChainMovement[] {
  const seen = new Set<string>();
  const out: ChainMovement[] = [];
  for (const tx of txs) {
    if (seen.has(tx.txid) || tx.status.confirmed !== true || tx.status.block_time === undefined) continue;
    seen.add(tx.txid);
    let net = 0n;
    for (const o of tx.vout) if (o.scriptpubkey_address !== undefined && mine.has(o.scriptpubkey_address)) net += BigInt(o.value ?? 0);
    for (const i of tx.vin) {
      const p = i.prevout;
      if (p != null && p.scriptpubkey_address !== undefined && mine.has(p.scriptpubkey_address)) net -= BigInt(p.value ?? 0);
    }
    if (net !== 0n) out.push({ txid: tx.txid, time: tx.status.block_time, net });
  }
  return out;
}

/**
 * Chain movements -> transactions: transfer_in/out, quantity in coins,
 * valued at the day's spot. A movement between two of the household's
 * own wallets pairs up later through the normalizer's transfer matching.
 */
export async function chainTransactions(
  moves: readonly ChainMovement[],
  symbol: string,
  name: string,
  decimals: number,
  scale: (units: bigint, decimals: number) => string,
  windowStartIso: string,
  priceAt: PriceAt,
): Promise<FlowsResult> {
  const startSec = new Date(windowStartIso).getTime() / 1000;
  const rows: SnapshotTxn[] = [];
  let unvalued = 0;
  for (const m of [...moves].filter((m) => m.time >= startSec).sort((a, b) => a.time - b.time || a.txid.localeCompare(b.txid))) {
    const at = new Date(m.time * 1000).toISOString();
    const qty = scale(m.net, decimals);
    const px = await priceAt(symbol, isoDay(at));
    if (px === null) { unvalued += 1; continue; }
    const value = decimal.round(decimal.mul(decimal.abs(qty), px), 2);
    const incoming = m.net > 0n;
    rows.push({
      txn_id: m.txid,
      posted_at: at,
      amount: incoming ? value : decimal.neg(value),
      type: incoming ? "transfer_in" : "transfer_out",
      description: `${incoming ? "Received" : "Sent"} ${decimal.abs(qty)} ${symbol} on-chain${incoming ? "" : " (fee included)"} · valued at the day's spot`,
      instrument: instrumentOf(symbol, name),
      quantity: qty,
      raw_category: incoming ? "receive" : "send",
    });
  }
  return { rows, unvalued };
}
