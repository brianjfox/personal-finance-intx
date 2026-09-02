// Tax lots derived from Kraken's account ledger (issue #64) -- the
// Kraken twin of coinbase-lots.ts. /0/private/Ledgers (key permission
// "Query ledger entries") is the account's complete record; walked
// oldest-first with FIFO consumption it yields lots per normalized
// symbol. Kraken specifics, all observed on the operator's account:
//
//   - A trade lands as SIBLING entries sharing a `refid`: +XETH paired
//     with -ZUSD (fiat buy: the fiat leg plus its fee is the basis) or
//     with -DOT (crypto-to-crypto: basis unknown; the historic-spot
//     suggestion covers it). Kraken Convert lands the same way as
//     `receive`/`spend` pairs.
//   - Fees are charged in the entry's OWN asset: a +3.4666 ETH trade
//     with fee 0.0049 nets 3.4617 into the lot; a -withdrawal consumes
//     |amount| + fee.
//   - `staking` rewards arrive with an asset-denominated fee and no
//     fiat value: a lot of (amount - fee), basis unknown.
//   - Internal spot<->staking transfers (subtypes spottostaking,
//     stakingfromspot, stakingtospot, spotfromstaking) move value
//     between wallets of the SAME normalized symbol (DOT vs DOT.S):
//     skipped entirely, or FIFO would churn real lots into unknowns.
//   - `deposit` and other arrivals are transferred-in lots with no
//     basis and no arrival value (Kraken states none).
//
// Per-symbol net of (amount - fee) over every entry equals the
// aggregated balance exactly (verified live across 461 entries); the
// adapter withholds a symbol's lots when it does not.

import { decimal } from "@fin/contracts";

import type { DerivedLot, LotDerivation } from "./coinbase-lots";

export interface KrakenLedgerEntry {
  id: string;
  refid: string;
  time: number;
  type: string;
  subtype?: string;
  asset: string;
  amount: string;
  fee: string;
}

const DEC = /^-?\d+(\.\d+)?$/;
const USD_LIKE = new Set(["USD", "USDC", "USDT", "DAI"]);
const INTERNAL_SUBTYPES = new Set(["spottostaking", "stakingfromspot", "stakingtospot", "spotfromstaking"]);

/**
 * Derive FIFO lots for every non-fiat symbol from the full ledger.
 * `toSymbol` is the adapter's asset normalization (XXBT -> BTC, DOT.S ->
 * DOT), so lots aggregate exactly as balances do.
 */
export function deriveKrakenLots(entries: readonly KrakenLedgerEntry[], toSymbol: (code: string) => string): Map<string, LotDerivation> {
  const rows = entries
    .filter((e) => DEC.test(e.amount) && DEC.test(e.fee) && !INTERNAL_SUBTYPES.has(e.subtype ?? ""))
    .sort((a, b) => a.time - b.time || a.id.localeCompare(b.id));
  const byRef = new Map<string, KrakenLedgerEntry[]>();
  for (const e of rows) {
    const list = byRef.get(e.refid) ?? [];
    list.push(e);
    byRef.set(e.refid, list);
  }
  const state = new Map<string, { open: { lot: DerivedLot; unitCost: string | null }[]; net: string; shortfall: string; counted: Record<string, number> }>();
  const of = (sym: string) => {
    let s = state.get(sym);
    if (s === undefined) {
      s = { open: [], net: "0", shortfall: "0", counted: {} };
      state.set(sym, s);
    }
    return s;
  };
  for (const e of rows) {
    const sym = toSymbol(e.asset);
    const s = of(sym);
    const delta = decimal.sub(e.amount, e.fee); // fee is charged in the entry's own asset
    if (decimal.isZero(delta)) continue;
    const kind = e.type + ((e.subtype ?? "") !== "" ? `:${e.subtype}` : "");
    s.counted[kind] = (s.counted[kind] ?? 0) + 1;
    if (decimal.cmp(delta, "0") > 0) {
      // Basis: a trade/convert whose siblings are ALL dollar-like pays
      // their |amount| + fee; anything else is unknown.
      let cost: string | null = null;
      let transferred = false;
      if (e.type === "trade" || e.type === "receive") {
        const siblings = (byRef.get(e.refid) ?? []).filter((x) => x.id !== e.id && decimal.cmp(x.amount, "0") < 0);
        if (siblings.length > 0 && siblings.every((x) => USD_LIKE.has(toSymbol(x.asset)))) {
          cost = decimal.round(decimal.sum(siblings.map((x) => decimal.add(decimal.abs(x.amount), x.fee))), 2);
        }
      } else if (e.type !== "staking") {
        transferred = true; // deposit, external transfer in, ...
      }
      s.open.push({
        lot: { lot_id: `kr:${e.id}`, quantity: delta, acquired_at: new Date(e.time * 1000).toISOString().slice(0, 10), cost_basis: cost, transferred_in: transferred },
        unitCost: cost === null ? null : decimal.div(cost, delta),
      });
      s.net = decimal.add(s.net, delta);
      continue;
    }
    let remaining = decimal.abs(delta);
    s.net = decimal.sub(s.net, remaining);
    while (decimal.cmp(remaining, "0") > 0 && s.open.length > 0) {
      const head = s.open[0]!;
      if (decimal.cmp(head.lot.quantity, remaining) <= 0) {
        remaining = decimal.sub(remaining, head.lot.quantity);
        s.open.shift();
      } else {
        const left = decimal.sub(head.lot.quantity, remaining);
        head.lot.quantity = left;
        if (head.unitCost !== null) head.lot.cost_basis = decimal.mul(head.unitCost, left);
        remaining = "0";
      }
    }
    if (decimal.cmp(remaining, "0") > 0) s.shortfall = decimal.add(s.shortfall, remaining);
  }
  const out = new Map<string, LotDerivation>();
  for (const [sym, s] of state) {
    out.set(sym, {
      lots: s.open.map((o) => ({ ...o.lot, cost_basis: o.lot.cost_basis === null ? null : decimal.round(o.lot.cost_basis, 2) })),
      net: s.net,
      shortfall: s.shortfall,
      counted: s.counted,
    });
  }
  return out;
}
