// Tax lots derived from a Coinbase account's transaction history (issue
// #53). Coinbase reports positions without lots and exposes no lot or
// cost-basis computation over the API, but /v2/accounts/:id/transactions
// is the account's complete ledger: every fill, buy, sell, send, and
// transfer to or from Coinbase Pro/Exchange. Walked oldest-first with
// FIFO consumption it yields the lots the Auditor needs -- and it is
// honest about what Coinbase cannot know: a transfer IN carries no
// basis (Coinbase's `native_amount` is fair value at arrival, not what
// the operator paid), so such a lot is `cost_basis: null,
// transferred_in: true`, which the drift engine reads as treatment
// `unknown` and the Auditor turns into its lot_basis_unknown caveat.
//
// Pure and decimal-exact; the adapter decides whether to trust the
// result (the derived net must equal the balance Coinbase reports).

import { decimal } from "@fin/contracts";

export interface CoinbaseTxn {
  id: string;
  type: string;
  status: string;
  created_at: string;
  amount: { amount: string; currency: string };
  native_amount?: { amount: string; currency: string } | null;
  advanced_trade_fill?: { commission?: string | null; fill_price?: string | null; product_id?: string | null; order_side?: string | null } | null;
  buy?: { total?: { amount: string; currency: string } | null; fee?: { amount: string; currency: string } | null } | null;
}

export interface DerivedLot {
  lot_id: string;
  quantity: string;
  acquired_at: string;
  /** USD basis of what remains of the lot, or null when Coinbase cannot know it. */
  cost_basis: string | null;
  transferred_in: boolean;
}

export interface LotDerivation {
  /** Open lots, oldest first, quantities > 0. */
  lots: DerivedLot[];
  /** Sum of inflows minus outflows over the whole history. */
  net: string;
  /** Outflows the history could not cover with earlier inflows (a gap in the record). */
  shortfall: string;
  /** Completed transactions counted, by type. */
  counted: Record<string, number>;
}

const DEC = /^-?\d+(\.\d+)?$/;
const USD_LIKE = new Set(["USD", "USDC", "USDT"]);
/** Arrivals that ARE income at fair value: their native amount is the basis. */
const INCOME_TYPES = new Set(["staking_reward", "earn_payout", "interest", "inflation_reward", "reward", "incentives_rewards_payout", "rewards", "cardspend_reward"]);

/** Basis of an inflow, in the operator's native currency, or null when Coinbase cannot know it. */
function basisOf(t: CoinbaseTxn, native: string): { cost: string | null; transferred: boolean } {
  const nat = t.native_amount != null && t.native_amount.currency === native && DEC.test(t.native_amount.amount) ? decimal.abs(t.native_amount.amount) : null;
  if (t.type === "advanced_trade_fill") {
    // The native amount is the notional at the fill price (also the right
    // basis for a crypto-to-crypto acquisition); a commission charged in a
    // dollar-like quote currency is part of the cost.
    if (nat === null) return { cost: null, transferred: false };
    const sub = t.advanced_trade_fill ?? {};
    const quote = (sub.product_id ?? "").split("-")[1] ?? "";
    const commission = typeof sub.commission === "string" && DEC.test(sub.commission) && USD_LIKE.has(quote) ? decimal.abs(sub.commission) : "0";
    return { cost: decimal.add(nat, commission), transferred: false };
  }
  if (t.type === "buy") {
    const total = t.buy?.total;
    if (total != null && total.currency === native && DEC.test(total.amount)) return { cost: decimal.abs(total.amount), transferred: false };
    return { cost: nat, transferred: false };
  }
  if (INCOME_TYPES.has(t.type)) return { cost: nat, transferred: false };
  // pro_deposit, exchange_deposit, receive, ... : arrived from elsewhere.
  return { cost: null, transferred: true };
}

export function deriveCoinbaseLots(txns: readonly CoinbaseTxn[], nativeCurrency = "USD"): LotDerivation {
  const rows = txns
    .filter((t) => t.status === "completed" && DEC.test(t.amount?.amount ?? ""))
    .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  const open: { lot: DerivedLot; unitCost: string | null }[] = [];
  let net = "0";
  let shortfall = "0";
  const counted: Record<string, number> = {};
  for (const t of rows) {
    const amt = t.amount.amount;
    if (decimal.isZero(amt)) continue;
    counted[t.type] = (counted[t.type] ?? 0) + 1;
    if (decimal.cmp(amt, "0") > 0) {
      const { cost, transferred } = basisOf(t, nativeCurrency);
      open.push({
        lot: { lot_id: `cb:${t.id}`, quantity: amt, acquired_at: t.created_at.slice(0, 10), cost_basis: cost, transferred_in: transferred },
        unitCost: cost === null ? null : decimal.div(cost, amt),
      });
      net = decimal.add(net, amt);
      continue;
    }
    let remaining = decimal.abs(amt);
    net = decimal.sub(net, remaining);
    while (decimal.cmp(remaining, "0") > 0 && open.length > 0) {
      const head = open[0]!;
      if (decimal.cmp(head.lot.quantity, remaining) <= 0) {
        remaining = decimal.sub(remaining, head.lot.quantity);
        open.shift();
      } else {
        const left = decimal.sub(head.lot.quantity, remaining);
        head.lot.quantity = left;
        if (head.unitCost !== null) head.lot.cost_basis = decimal.mul(head.unitCost, left);
        remaining = "0";
      }
    }
    if (decimal.cmp(remaining, "0") > 0) shortfall = decimal.add(shortfall, remaining);
  }
  return {
    lots: open.map((o) => ({ ...o.lot, cost_basis: o.lot.cost_basis === null ? null : decimal.round(o.lot.cost_basis, 2) })),
    net,
    shortfall,
    counted,
  };
}
