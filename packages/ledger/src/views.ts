// Read models over the ledger: accounts, balances, positions, net worth.
// Every figure carries the fact ids it was computed from, so the GUI can
// make every number clickable back to fact -> source document -> observed
// date (deck slide 19).

import {
  decimal,
  LIABILITY_ACCOUNT_TYPES,
  POSITION_ACCOUNT_TYPES,
  type AccountPayload,
  type BalancePayload,
  type PositionPayload,
} from "@fin/contracts";

import type { Ledger, StoredFact } from "./ledger";

export interface AsOfOpts {
  effectiveAt?: string;
  observedAt?: string;
}

export interface AccountView {
  account_id: string;
  fact_id: string;
  institution_id: string;
  name: string;
  type: AccountPayload["type"];
  currency: string;
  masked_number: string | null;
  provisional: boolean;
  observed_at: string;
}

export interface BalanceView {
  account_id: string;
  balance_type: BalancePayload["balance_type"];
  amount: string;
  currency: string;
  fact_id: string;
  observed_at: string;
  effective_at: string;
  stated_as_of: string | null;
  source_doc_id: string | null;
  provisional: boolean;
}

export interface PositionView {
  account_id: string;
  symbol: string;
  name: string | null;
  asset_class: PositionPayload["instrument"]["asset_class"];
  quantity: string;
  price: string | null;
  market_value: string | null;
  cost_basis: string | null;
  basis_known: boolean;
  currency: string;
  fact_id: string;
  observed_at: string;
  effective_at: string;
  source_doc_id: string | null;
  provisional: boolean;
}

export interface NetWorthLine {
  account_id: string;
  name: string;
  type: AccountPayload["type"];
  /** Signed: assets positive, liabilities negative. */
  value: string;
  currency: string;
  /** Which figure was used and where it came from. */
  basis: "balance.total" | "positions" | "balance.owed" | "none";
  fact_ids: string[];
  observed_at: string | null;
  provisional: boolean;
}

export interface NetWorthView {
  as_of: { effective_at: string | null; observed_at: string | null };
  assets: string;
  liabilities: string;
  net_worth: string;
  currency: string;
  lines: NetWorthLine[];
  /** True when any line rests on provisional facts. */
  provisional: boolean;
}

export function accounts(ledger: Ledger, opts: AsOfOpts = {}): AccountView[] {
  return ledger.asOf({ kind: "account", ...opts }).map((f) => {
    const p = f.payload as AccountPayload;
    return {
      account_id: p.account_id,
      fact_id: f.id,
      institution_id: p.institution_id,
      name: p.name,
      type: p.type,
      currency: p.currency,
      masked_number: p.masked_number ?? null,
      provisional: f.provisional,
      observed_at: f.observed_at,
    };
  });
}

export function balances(ledger: Ledger, opts: AsOfOpts & { subject?: string } = {}): BalanceView[] {
  return ledger.asOf({ kind: "balance", ...opts }).map((f) => {
    const p = f.payload as BalancePayload;
    return {
      account_id: p.account_id,
      balance_type: p.balance_type,
      amount: p.amount,
      currency: p.currency,
      fact_id: f.id,
      observed_at: f.observed_at,
      effective_at: f.effective_at,
      stated_as_of: p.stated_as_of ?? null,
      source_doc_id: f.source_doc_id,
      provisional: f.provisional,
    };
  });
}

export function positions(ledger: Ledger, opts: AsOfOpts & { subject?: string } = {}): PositionView[] {
  return ledger
    .asOf({ kind: "position", ...opts })
    .filter((f) => !decimal.isZero((f.payload as PositionPayload).quantity))
    .map((f) => {
      const p = f.payload as PositionPayload;
      return {
        account_id: p.account_id,
        symbol: p.instrument.symbol,
        name: p.instrument.name ?? null,
        asset_class: p.instrument.asset_class,
        quantity: p.quantity,
        price: p.price ?? null,
        market_value: p.market_value ?? null,
        cost_basis: p.cost_basis,
        basis_known: p.basis_known,
        currency: p.currency,
        fact_id: f.id,
        observed_at: f.observed_at,
        effective_at: f.effective_at,
        source_doc_id: f.source_doc_id,
        provisional: f.provisional,
      };
    });
}

/**
 * Net worth = assets - liabilities over current accounts. An account's
 * value is its `total` balance when stated; otherwise the sum of its
 * position market values (for position-bearing accounts). Liability
 * accounts contribute `owed` (or `total`) negatively. Single-currency in
 * Phase 1: lines in another currency are reported but not summed.
 */
export function netWorth(ledger: Ledger, opts: AsOfOpts & { currency?: string } = {}): NetWorthView {
  const currency = opts.currency ?? "USD";
  const accts = accounts(ledger, opts);
  const bals = balances(ledger, opts);
  const poss = positions(ledger, opts);
  const lines: NetWorthLine[] = [];
  let assets = "0";
  let liabilities = "0";
  let anyProvisional = false;

  for (const a of accts) {
    const myBals = bals.filter((b) => b.account_id === a.account_id);
    const myPoss = poss.filter((p) => p.account_id === a.account_id);
    const isLiability = LIABILITY_ACCOUNT_TYPES.has(a.type);
    const total = myBals.find((b) => b.balance_type === "total");
    const owed = myBals.find((b) => b.balance_type === "owed");
    let value = "0";
    let basis: NetWorthLine["basis"] = "none";
    let factIds: string[] = [];
    let observed: string | null = null;
    let prov = a.provisional;

    if (isLiability) {
      const src = owed ?? total;
      if (src !== undefined) {
        value = decimal.neg(decimal.abs(src.amount));
        basis = owed !== undefined ? "balance.owed" : "balance.total";
        factIds = [src.fact_id];
        observed = src.observed_at;
        prov = prov || src.provisional;
      }
    } else if (total !== undefined) {
      value = total.amount;
      basis = "balance.total";
      factIds = [total.fact_id];
      observed = total.observed_at;
      prov = prov || total.provisional;
    } else if (POSITION_ACCOUNT_TYPES.has(a.type) && myPoss.length > 0) {
      value = decimal.sum(myPoss.map((p) => p.market_value ?? "0"));
      basis = "positions";
      factIds = myPoss.map((p) => p.fact_id);
      observed = myPoss.map((p) => p.observed_at).sort().at(-1) ?? null;
      prov = prov || myPoss.some((p) => p.provisional);
    }
    anyProvisional = anyProvisional || prov;
    lines.push({
      account_id: a.account_id,
      name: a.name,
      type: a.type,
      value,
      currency: a.currency,
      basis,
      fact_ids: factIds,
      observed_at: observed,
      provisional: prov,
    });
    if (a.currency === currency) {
      if (decimal.cmp(value, "0") < 0) liabilities = decimal.add(liabilities, decimal.abs(value));
      else assets = decimal.add(assets, value);
    }
  }
  return {
    as_of: { effective_at: opts.effectiveAt ?? null, observed_at: opts.observedAt ?? null },
    assets,
    liabilities,
    net_worth: decimal.sub(assets, liabilities),
    currency,
    lines,
    provisional: anyProvisional,
  };
}

/** Subject -> current transaction facts (one per txn key). */
export function transactions(ledger: Ledger, opts: AsOfOpts & { subject?: string } = {}): StoredFact[] {
  return ledger.asOf({ kind: "transaction", ...opts });
}
