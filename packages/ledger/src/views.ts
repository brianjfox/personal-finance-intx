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
  type ObligationPayload,
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
  /** Set when the account is closed (or its institution was removed): it holds no value now. */
  closed_at: string | null;
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
  /** The value converted to the display currency (null when no rate was available). */
  display_value?: string | null;
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
  /** Currencies present but lacking a conversion rate: their lines kept native values and were EXCLUDED from the totals. */
  fx_missing: string[];
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
      closed_at: p.closed_at ?? null,
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
  const { subject: _subject, ...acctOpts } = opts;
  const closed = new Set(accounts(ledger, acctOpts).filter((a) => a.closed_at !== null).map((a) => a.account_id));
  return ledger
    .asOf({ kind: "position", ...opts })
    .filter((f) => !decimal.isZero((f.payload as PositionPayload).quantity))
    .filter((f) => !closed.has((f.payload as PositionPayload).account_id))
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

export interface ConsolidatedPositionView {
  symbol: string;
  name: string | null;
  asset_class: PositionView["asset_class"];
  currency: string;
  /** How many accounts hold this asset. */
  accounts: number;
  account_ids: string[];
  quantity: string;
  /** The most recently observed price across the accounts, if any. */
  price: string | null;
  /** Sum of the stated market values; null when no account states one. */
  market_value: string | null;
  /** Sum of the KNOWN bases only; see basis_complete. */
  cost_basis: string | null;
  /** False when any account's basis is unknown (the sum understates). */
  basis_complete: boolean;
  fact_ids: string[];
  /** Newest observation among the bundled facts. */
  observed_at: string;
  provisional: boolean;
}

/**
 * The Positions pane's "consolidated view": all holdings of one
 * instrument bundled into a single row across accounts -- one row for
 * ETH, one per stock. Sums are decimal-exact; a partially-unknown cost
 * basis is flagged rather than silently understated. Grouped by
 * (symbol, currency) so a same-symbol holding in another currency never
 * folds into the wrong total.
 */
export function consolidatedPositions(ledger: Ledger, opts: AsOfOpts = {}): ConsolidatedPositionView[] {
  const groups = new Map<string, ConsolidatedPositionView>();
  for (const p of positions(ledger, opts)) {
    const key = `${p.symbol}|${p.currency}`;
    const g = groups.get(key);
    if (g === undefined) {
      groups.set(key, {
        symbol: p.symbol,
        name: p.name,
        asset_class: p.asset_class,
        currency: p.currency,
        accounts: 1,
        account_ids: [p.account_id],
        quantity: p.quantity,
        price: p.price,
        market_value: p.market_value,
        cost_basis: p.basis_known ? p.cost_basis : null,
        basis_complete: p.basis_known,
        fact_ids: [p.fact_id],
        observed_at: p.observed_at,
        provisional: p.provisional,
      });
      continue;
    }
    g.accounts += 1;
    if (!g.account_ids.includes(p.account_id)) g.account_ids.push(p.account_id);
    g.quantity = decimal.add(g.quantity, p.quantity);
    g.name = g.name ?? p.name;
    if (p.observed_at > g.observed_at) {
      g.observed_at = p.observed_at;
      if (p.price !== null) g.price = p.price;
    } else if (g.price === null && p.price !== null) {
      g.price = p.price;
    }
    if (p.market_value !== null) g.market_value = g.market_value === null ? p.market_value : decimal.add(g.market_value, p.market_value);
    if (p.basis_known && p.cost_basis !== null) {
      g.cost_basis = g.cost_basis === null ? p.cost_basis : decimal.add(g.cost_basis, p.cost_basis);
    }
    g.basis_complete = g.basis_complete && p.basis_known;
    g.fact_ids.push(p.fact_id);
    g.provisional = g.provisional || p.provisional;
  }
  return [...groups.values()]
    .map((g) => ({ ...g, accounts: g.account_ids.length }))
    .sort((a, b) => {
      const av = a.market_value !== null ? Number(a.market_value) : -1;
      const bv = b.market_value !== null ? Number(b.market_value) : -1;
      return bv - av || a.symbol.localeCompare(b.symbol);
    });
}

/**
 * Net worth = assets - liabilities over current accounts. An account's
 * value is its `total` balance when stated; otherwise the sum of its
 * position market values (for position-bearing accounts). Liability
 * accounts contribute `owed` (or `total`) negatively. Single-currency in
 * Phase 1: lines in another currency are reported but not summed.
 */
export function netWorth(ledger: Ledger, opts: AsOfOpts & { currency?: string; rates?: Record<string, string> } = {}): NetWorthView {
  const currency = opts.currency ?? "USD";
  const rates = opts.rates ?? {};
  const fxMissing = new Set<string>();
  /** Native -> display currency; exact decimal multiply, null when no rate exists. */
  const convert = (value: string, from: string): string | null => {
    if (from === currency) return value;
    const rate = rates[from];
    if (rate === undefined) {
      fxMissing.add(from);
      return null;
    }
    return decimal.round(decimal.mul(value, rate), 2);
  };
  const accts = accounts(ledger, opts);
  const bals = balances(ledger, opts);
  const poss = positions(ledger, opts);
  const lines: NetWorthLine[] = [];
  let assets = "0";
  let liabilities = "0";
  let anyProvisional = false;

  for (const a of accts) {
    if (a.closed_at !== null) continue; // closed: holds no value now (history keeps its earlier facts)
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
    const displayValue = convert(value, a.currency);
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
      display_value: displayValue,
    });
    // Totals sum CONVERTED values; a currency without a rate is excluded
    // and named in fx_missing rather than silently mixed in.
    if (displayValue !== null) {
      if (decimal.cmp(displayValue, "0") < 0) liabilities = decimal.add(liabilities, decimal.abs(displayValue));
      else assets = decimal.add(assets, displayValue);
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
    fx_missing: [...fxMissing].sort(),
  };
}

/** Subject -> current transaction facts (one per txn key). */
export function transactions(ledger: Ledger, opts: AsOfOpts & { subject?: string } = {}): StoredFact[] {
  return ledger.asOf({ kind: "transaction", ...opts });
}

export interface ObligationView {
  subject: string;
  key: string;
  obligation_id: string;
  kind: ObligationPayload["kind"];
  description: string;
  account_id: string;
  amount: string | null;
  due: string | null;
  currency: string;
  fact_id: string;
  observed_at: string;
  effective_at: string;
  supersedes: string | null;
  provisional: boolean;
}

/** Current obligations (one per subject/key), payment amount and due date surfaced. */
export function obligations(ledger: Ledger, opts: AsOfOpts & { subject?: string } = {}): ObligationView[] {
  return ledger.asOf({ kind: "obligation", ...opts }).map((f) => {
    const p = f.payload as ObligationPayload;
    return {
      subject: f.subject,
      key: f.key,
      obligation_id: p.obligation_id,
      kind: p.kind,
      description: p.description,
      account_id: p.account_id,
      amount: p.payment_amount ?? null,
      due: p.payment_due ?? null,
      currency: p.currency,
      fact_id: f.id,
      observed_at: f.observed_at,
      effective_at: f.effective_at,
      supersedes: f.supersedes,
      provisional: f.provisional,
    };
  });
}
