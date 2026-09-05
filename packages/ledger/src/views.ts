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
  type TransactionPayload,
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
  /** Set when this subject was folded into another account (a relink alias): render the survivor, not this. */
  merged_into: string | null;
  /** The operator hid this account: closed, and no data recorded while set. */
  ignored: boolean;
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
      merged_into: p.merged_into ?? null,
      ignored: p.ignored === true,
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

/**
 * Accounts known to be closed as of the query -- including operator-hidden
 * ones (hiding closes the account and flags it `ignored`). A closed
 * account's last position/lot facts stay CURRENT facts forever, so any
 * reader describing what the household holds now must drop them
 * (issue #47): drift, the agents' position and subject tools, the
 * Auditor's checks. History readers (realized gains, the registry audit)
 * keep seeing everything on purpose.
 */
export function closedSubjects(ledger: Ledger, opts: AsOfOpts = {}): Set<string> {
  return new Set(accounts(ledger, opts).filter((a) => a.closed_at !== null).map((a) => a.account_id));
}

/** Current account facts of OPEN accounts only (not closed, not hidden). */
export function liveAccountFacts(ledger: Ledger, opts: AsOfOpts = {}): StoredFact[] {
  return ledger.asOf({ kind: "account", ...opts }).filter((f) => (f.payload as AccountPayload).closed_at == null);
}

/** Current position facts of open accounts, zero-quantity lines dropped: the StoredFact form of `positions()`. */
export function livePositionFacts(ledger: Ledger, opts: AsOfOpts & { subject?: string } = {}): StoredFact[] {
  const { subject: _subject, ...acctOpts } = opts;
  const closed = closedSubjects(ledger, acctOpts);
  return ledger
    .asOf({ kind: "position", ...opts })
    .filter((f) => !decimal.isZero((f.payload as PositionPayload).quantity))
    .filter((f) => !closed.has((f.payload as PositionPayload).account_id));
}

/** Current lot facts of open accounts (a SELL candidate's lot choice never reaches into a closed account). */
export function liveLotFacts(ledger: Ledger, opts: AsOfOpts = {}): StoredFact[] {
  const closed = closedSubjects(ledger, opts);
  return ledger.asOf({ kind: "lot", ...opts }).filter((f) => !closed.has(f.subject));
}

export function positions(ledger: Ledger, opts: AsOfOpts & { subject?: string } = {}): PositionView[] {
  return livePositionFacts(ledger, opts)
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

/** Subject -> current transaction facts (one per txn key). Voided facts (re-booked movements a merge folded away) are history, not activity. */
export function transactions(ledger: Ledger, opts: AsOfOpts & { subject?: string } = {}): StoredFact[] {
  return ledger
    .asOf({ kind: "transaction", ...opts })
    .filter((f) => (f.payload as TransactionPayload).voided !== true);
}

export interface CashFlowMonth {
  /** Calendar month, "YYYY-MM". */
  month: string;
  /** Money into the household this month (display currency, >= 0). */
  inflow: string;
  /** Money out of the household this month (magnitude, >= 0). */
  outflow: string;
  net: string;
  /** Transaction facts behind the two bars. */
  txns: number;
}

export interface CashFlowView {
  currency: string;
  /** Oldest -> newest, one entry per calendar month, ending at the current month. */
  months: CashFlowMonth[];
  /** Native currencies with no conversion rate; their transactions are excluded. */
  fx_missing: string[];
  /** Legs skipped as internal movement (transfers between household accounts, buys/sells/swaps). */
  excluded_internal: number;
  provisional: boolean;
}

/**
 * Household cash flow by calendar month, from the transaction facts the
 * connectors re-observe on a rolling window each nightly. Only money that
 * actually enters or leaves the household counts: legs of transfers
 * between household accounts (transfer_group), and asset conversions
 * inside an account (buy / sell / swap), are internal and excluded.
 */
export function cashFlow(
  ledger: Ledger,
  opts: AsOfOpts & { subject?: string; currency?: string; rates?: Record<string, string>; months?: number; now?: Date } = {},
): CashFlowView {
  const currency = opts.currency ?? "USD";
  const rates = opts.rates ?? {};
  const fxMissing = new Set<string>();
  const convert = (value: string, from: string): string | null => {
    if (from === currency) return value;
    const rate = rates[from];
    if (rate === undefined) {
      fxMissing.add(from);
      return null;
    }
    return decimal.round(decimal.mul(value, rate), 2);
  };
  const n = Math.max(1, Math.min(60, opts.months ?? 12));
  const now = opts.now ?? (opts.effectiveAt !== undefined ? new Date(opts.effectiveAt) : new Date());
  const head = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const buckets = new Map<string, { inflow: string; outflow: string; txns: number }>();
  const keys: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(head);
    d.setUTCMonth(d.getUTCMonth() - i);
    const key = d.toISOString().slice(0, 7);
    keys.push(key);
    buckets.set(key, { inflow: "0", outflow: "0", txns: 0 });
  }
  const INTERNAL_TYPES = new Set(["buy", "sell", "swap"]);
  let excluded = 0;
  let provisional = false;
  for (const f of ledger.asOf({ kind: "transaction", ...opts })) {
    const p = f.payload as TransactionPayload;
    if (p.voided === true) continue;
    if (p.transfer_group != null || INTERNAL_TYPES.has(p.type)) {
      excluded++;
      continue;
    }
    const bucket = buckets.get(p.posted_at.slice(0, 7));
    if (bucket === undefined) continue; // outside the window
    const amt = convert(p.amount, p.currency);
    if (amt === null) continue;
    if (decimal.cmp(amt, "0") >= 0) bucket.inflow = decimal.add(bucket.inflow, amt);
    else bucket.outflow = decimal.add(bucket.outflow, decimal.abs(amt));
    bucket.txns++;
    provisional = provisional || f.provisional;
  }
  return {
    currency,
    months: keys.map((month) => {
      const b = buckets.get(month)!;
      return { month, inflow: b.inflow, outflow: b.outflow, net: decimal.sub(b.inflow, b.outflow), txns: b.txns };
    }),
    fx_missing: [...fxMissing].sort(),
    excluded_internal: excluded,
    provisional,
  };
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

// --- transaction activity (the Ledger Analyst's ground, D-044) ---------
//
// Line-item reads over the transaction facts the connectors re-observe
// nightly. Every figure below is computed here, in decimal string math,
// and every row/bucket carries the fact ids it rests on -- the analyst
// quotes; it never sums. Internal movement (transfer legs between
// household accounts, in-account buy/sell/swap) is excluded by default,
// mirroring cashFlow, and counted so its absence is visible.

/** A transaction as the analyst sees it: no account numbers, the account's NAME only. */
export interface TransactionRow {
  fact_id: string;
  subject: string;
  account: string | null;
  posted_at: string;
  /** Signed: positive into the account, negative out. Native currency. */
  amount: string;
  currency: string;
  type: TransactionPayload["type"];
  description: string;
  raw_category: string | null;
  instrument: string | null;
  /** A transfer leg between household accounts or an in-account conversion. */
  internal: boolean;
  provisional: boolean;
}

export interface TransactionFilter extends AsOfOpts {
  subject?: string;
  /** Inclusive ISO date bounds on posted_at ("YYYY-MM-DD"). */
  from?: string;
  to?: string;
  types?: readonly TransactionPayload["type"][];
  /** Case-insensitive substring of the description (or the raw category). */
  description_contains?: string;
  /** Bounds on |amount|, native currency. */
  min_abs_amount?: string;
  max_abs_amount?: string;
  /** Default false: internal legs are excluded and counted. */
  include_internal?: boolean;
}

export interface TransactionTotals {
  count: number;
  inflow: string;
  outflow: string;
  net: string;
}

export interface TransactionQueryView {
  rows: TransactionRow[];
  /** Rows matching the filter (before paging). */
  matched: number;
  offset: number;
  limit: number;
  truncated: boolean;
  /** Over ALL matched rows, per native currency -- never mixed across currencies. */
  totals_by_currency: Record<string, TransactionTotals>;
  excluded_internal: number;
  provisional: boolean;
}

const INTERNAL_TXN_TYPES: ReadonlySet<string> = new Set(["buy", "sell", "swap"]);
const isInternalTxn = (p: TransactionPayload): boolean => p.transfer_group != null || INTERNAL_TXN_TYPES.has(p.type);

function accountNames(ledger: Ledger, opts: AsOfOpts): Map<string, string> {
  const names = new Map<string, string>();
  for (const f of ledger.asOf({ kind: "account", ...opts })) names.set(f.subject, (f.payload as AccountPayload).name);
  return names;
}

/** The current, non-voided transaction facts matching the filter, newest first. Internal legs are dropped unless asked for; their count is returned. */
function matchTransactions(ledger: Ledger, q: TransactionFilter): { facts: StoredFact[]; excluded_internal: number } {
  const needle = q.description_contains?.trim().toLowerCase() ?? "";
  const types = q.types !== undefined && q.types.length > 0 ? new Set<string>(q.types) : null;
  const from = q.from !== undefined ? q.from.slice(0, 10) : null;
  const to = q.to !== undefined ? q.to.slice(0, 10) : null;
  const asOfOpts: AsOfOpts & { subject?: string } = {};
  if (q.effectiveAt !== undefined) asOfOpts.effectiveAt = q.effectiveAt;
  if (q.observedAt !== undefined) asOfOpts.observedAt = q.observedAt;
  if (q.subject !== undefined) asOfOpts.subject = q.subject;
  let excluded = 0;
  const facts: StoredFact[] = [];
  for (const f of ledger.asOf({ kind: "transaction", ...asOfOpts })) {
    const p = f.payload as TransactionPayload;
    if (p.voided === true) continue;
    const day = p.posted_at.slice(0, 10);
    if (from !== null && day < from) continue;
    if (to !== null && day > to) continue;
    if (types !== null && !types.has(p.type)) continue;
    if (needle !== "" && !p.description.toLowerCase().includes(needle) && !(p.raw_category ?? "").toLowerCase().includes(needle)) continue;
    const mag = decimal.abs(p.amount);
    if (q.min_abs_amount !== undefined && decimal.cmp(mag, q.min_abs_amount) < 0) continue;
    if (q.max_abs_amount !== undefined && decimal.cmp(mag, q.max_abs_amount) > 0) continue;
    if (isInternalTxn(p)) {
      excluded++;
      if (q.include_internal !== true) continue;
    }
    facts.push(f);
  }
  facts.sort((a, b) => {
    const pa = (a.payload as TransactionPayload).posted_at;
    const pb = (b.payload as TransactionPayload).posted_at;
    return pa < pb ? 1 : pa > pb ? -1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return { facts, excluded_internal: excluded };
}

function toRow(f: StoredFact, names: Map<string, string>): TransactionRow {
  const p = f.payload as TransactionPayload;
  return {
    fact_id: f.id,
    subject: f.subject,
    account: names.get(f.subject) ?? null,
    posted_at: p.posted_at,
    amount: p.amount,
    currency: p.currency,
    type: p.type,
    description: p.description,
    raw_category: p.raw_category ?? null,
    instrument: p.instrument?.symbol ?? null,
    internal: isInternalTxn(p),
    provisional: f.provisional,
  };
}

function tally(into: Map<string, TransactionTotals>, currency: string, amount: string): void {
  const t = into.get(currency) ?? { count: 0, inflow: "0", outflow: "0", net: "0" };
  t.count++;
  if (decimal.cmp(amount, "0") >= 0) t.inflow = decimal.add(t.inflow, amount);
  else t.outflow = decimal.add(t.outflow, decimal.abs(amount));
  t.net = decimal.sub(t.inflow, t.outflow);
  into.set(currency, t);
}

export const TRANSACTION_PAGE_DEFAULT = 100;
export const TRANSACTION_PAGE_MAX = 500;

/** Filtered transaction lines, newest first, paged, with totals over the whole match. */
export function transactionRows(ledger: Ledger, q: TransactionFilter & { limit?: number; offset?: number } = {}): TransactionQueryView {
  const limit = Math.max(1, Math.min(TRANSACTION_PAGE_MAX, Math.trunc(q.limit ?? TRANSACTION_PAGE_DEFAULT)));
  const offset = Math.max(0, Math.trunc(q.offset ?? 0));
  const { facts, excluded_internal } = matchTransactions(ledger, q);
  const names = accountNames(ledger, q);
  const totals = new Map<string, TransactionTotals>();
  let provisional = false;
  for (const f of facts) {
    const p = f.payload as TransactionPayload;
    tally(totals, p.currency, p.amount);
    provisional = provisional || f.provisional;
  }
  const page = facts.slice(offset, offset + limit);
  return {
    rows: page.map((f) => toRow(f, names)),
    matched: facts.length,
    offset,
    limit,
    truncated: offset + page.length < facts.length,
    totals_by_currency: Object.fromEntries([...totals.entries()].sort()),
    excluded_internal,
    provisional,
  };
}

export type TransactionGroupBy = "month" | "category" | "description" | "account" | "type";

export interface TransactionBucket {
  key: string;
  label: string;
  currency: string;
  count: number;
  inflow: string;
  outflow: string;
  net: string;
  fact_ids: string[];
}

export interface TransactionSummaryView {
  group_by: TransactionGroupBy;
  /** One bucket per (group, currency); largest outflow first. */
  buckets: TransactionBucket[];
  matched: number;
  excluded_internal: number;
  provisional: boolean;
}

/** Normalise a statement description into a merchant-ish key: lowercase, digits and punctuation dropped, whitespace collapsed. */
export function normaliseDescription(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Matched transactions bucketed by month, category, merchant, account, or type, totals per native currency. */
export function transactionSummary(ledger: Ledger, q: TransactionFilter & { group_by: TransactionGroupBy }): TransactionSummaryView {
  const { facts, excluded_internal } = matchTransactions(ledger, q);
  const names = accountNames(ledger, q);
  const buckets = new Map<string, TransactionBucket>();
  let provisional = false;
  for (const f of facts) {
    const p = f.payload as TransactionPayload;
    let key: string;
    let label: string;
    switch (q.group_by) {
      case "month":
        key = label = p.posted_at.slice(0, 7);
        break;
      case "category":
        key = label = p.raw_category?.trim() !== "" && p.raw_category != null ? p.raw_category : "(uncategorised)";
        break;
      case "description":
        key = normaliseDescription(p.description) || "(blank)";
        label = p.description;
        break;
      case "account":
        key = f.subject;
        label = names.get(f.subject) ?? f.subject;
        break;
      case "type":
        key = label = p.type;
        break;
    }
    const id = `${key}|${p.currency}`;
    const b = buckets.get(id) ?? { key, label, currency: p.currency, count: 0, inflow: "0", outflow: "0", net: "0", fact_ids: [] };
    b.count++;
    if (decimal.cmp(p.amount, "0") >= 0) b.inflow = decimal.add(b.inflow, p.amount);
    else b.outflow = decimal.add(b.outflow, decimal.abs(p.amount));
    b.net = decimal.sub(b.inflow, b.outflow);
    b.fact_ids.push(f.id);
    buckets.set(id, b);
    provisional = provisional || f.provisional;
  }
  const out = [...buckets.values()].sort((a, b) => {
    const c = decimal.cmp(b.outflow, a.outflow);
    if (c !== 0) return c;
    const d = decimal.cmp(b.inflow, a.inflow);
    if (d !== 0) return d;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
  return { group_by: q.group_by, buckets: out, matched: facts.length, excluded_internal, provisional };
}

export type RecurringCadence = "weekly" | "biweekly" | "monthly" | "quarterly" | "annual";

export interface RecurringCharge {
  /** The most recent statement description in the group. */
  description: string;
  /** The normalised key the group was formed on. */
  normalized: string;
  direction: "inflow" | "outflow";
  cadence: RecurringCadence;
  /** Median gap between consecutive occurrences, in days. */
  interval_days: number;
  occurrences: number;
  first_at: string;
  last_at: string;
  /** Median |amount| (lower-middle for even counts). */
  typical_amount: string;
  latest_amount: string;
  /** typical_amount expressed per month (weekly x52/12, biweekly x26/12, quarterly /3, annual /12). */
  monthly_equivalent: string;
  currency: string;
  /** Account NAMES the charge appears on. */
  accounts: string[];
  /** last_at plus the cadence's nominal interval, as a date. */
  next_expected: string;
  fact_ids: string[];
  provisional: boolean;
}

export interface RecurringView {
  /** Largest monthly equivalent first. */
  charges: RecurringCharge[];
  /** Sum of monthly equivalents, per native currency and direction. */
  monthly_equivalent_by_currency: Record<string, { inflow: string; outflow: string }>;
  /** Non-internal transactions the detector looked at. */
  considered: number;
  min_occurrences: number;
}

// Cadence bands on the median gap in days, and the nominal gap used for next_expected.
const CADENCES: ReadonlyArray<{ cadence: RecurringCadence; lo: number; hi: number; nominal: number; perMonth: string }> = [
  { cadence: "weekly", lo: 6, hi: 8, nominal: 7, perMonth: decimal.div("52", "12") },
  { cadence: "biweekly", lo: 13, hi: 15, nominal: 14, perMonth: decimal.div("26", "12") },
  { cadence: "monthly", lo: 27, hi: 33, nominal: 30, perMonth: "1" },
  { cadence: "quarterly", lo: 85, hi: 95, nominal: 91, perMonth: decimal.div("1", "3") },
  { cadence: "annual", lo: 355, hi: 375, nominal: 365, perMonth: decimal.div("1", "12") },
];

const DAY_MS = 86_400_000;
const dayOf = (iso: string): number => Math.round(Date.parse(`${iso.slice(0, 10)}T00:00:00.000Z`) / DAY_MS);
const median = (sorted: readonly string[]): string => sorted[Math.floor((sorted.length - 1) / 2)] ?? "0";

/**
 * Recurring charges and credits, detected deterministically: transactions
 * grouped by normalised description + currency + direction, kept when at
 * least `min_occurrences` occur, most consecutive gaps fall in one cadence
 * band, and most amounts sit within `amount_tolerance` (default 20%) of
 * the median. Internal movement and voided facts are never candidates.
 */
export function recurringCharges(
  ledger: Ledger,
  opts: AsOfOpts & { subject?: string; from?: string; to?: string; min_occurrences?: number; amount_tolerance?: string } = {},
): RecurringView {
  const minOcc = Math.max(2, Math.trunc(opts.min_occurrences ?? 3));
  const tolerance = opts.amount_tolerance ?? "0.2";
  const filter: TransactionFilter = { include_internal: false };
  if (opts.subject !== undefined) filter.subject = opts.subject;
  if (opts.from !== undefined) filter.from = opts.from;
  if (opts.to !== undefined) filter.to = opts.to;
  if (opts.effectiveAt !== undefined) filter.effectiveAt = opts.effectiveAt;
  if (opts.observedAt !== undefined) filter.observedAt = opts.observedAt;
  const { facts } = matchTransactions(ledger, filter);
  const names = accountNames(ledger, opts);
  const groups = new Map<string, StoredFact[]>();
  for (const f of facts) {
    const p = f.payload as TransactionPayload;
    const norm = normaliseDescription(p.description);
    if (norm === "" || decimal.isZero(p.amount)) continue;
    const direction = decimal.cmp(p.amount, "0") > 0 ? "inflow" : "outflow";
    const key = `${norm}|${p.currency}|${direction}`;
    const g = groups.get(key);
    if (g === undefined) groups.set(key, [f]);
    else g.push(f);
  }
  const charges: RecurringCharge[] = [];
  const totals = new Map<string, { inflow: string; outflow: string }>();
  for (const [key, group] of groups) {
    if (group.length < minOcc) continue;
    // Oldest first, one occurrence per day (two same-day charges are one event for cadence purposes).
    const byDay = new Map<number, StoredFact>();
    for (const f of [...group].reverse()) byDay.set(dayOf((f.payload as TransactionPayload).posted_at), f);
    const days = [...byDay.keys()].sort((a, b) => a - b);
    if (days.length < minOcc) continue;
    const gaps: number[] = [];
    for (let i = 1; i < days.length; i++) gaps.push((days[i] ?? 0) - (days[i - 1] ?? 0));
    const sortedGaps = [...gaps].sort((a, b) => a - b);
    const medGap = sortedGaps[Math.floor((sortedGaps.length - 1) / 2)] ?? 0;
    const band = CADENCES.find((c) => medGap >= c.lo && medGap <= c.hi);
    if (band === undefined) continue;
    const need = Math.ceil((gaps.length * 2) / 3);
    if (gaps.filter((g) => g >= band.lo && g <= band.hi).length < need) continue;
    const ordered = days.map((d) => byDay.get(d)!);
    const mags = ordered.map((f) => decimal.abs((f.payload as TransactionPayload).amount)).sort(decimal.cmp);
    const typical = median(mags);
    const slack = decimal.mul(typical, tolerance);
    const within = mags.filter((m) => decimal.cmp(decimal.abs(decimal.sub(m, typical)), slack) <= 0).length;
    if (within < Math.ceil((mags.length * 2) / 3)) continue;
    const last = ordered[ordered.length - 1]!;
    const lastP = last.payload as TransactionPayload;
    const [, currency, direction] = key.split("|") as [string, string, "inflow" | "outflow"];
    const monthly = decimal.round(decimal.mul(typical, band.perMonth), 2);
    const nextDay = (days[days.length - 1] ?? 0) + band.nominal;
    const accounts = [...new Set(ordered.map((f) => names.get(f.subject) ?? f.subject))].sort();
    charges.push({
      description: lastP.description,
      normalized: key.split("|")[0] ?? "",
      direction,
      cadence: band.cadence,
      interval_days: medGap,
      occurrences: ordered.length,
      first_at: (ordered[0]!.payload as TransactionPayload).posted_at,
      last_at: lastP.posted_at,
      typical_amount: typical,
      latest_amount: decimal.abs(lastP.amount),
      monthly_equivalent: monthly,
      currency,
      accounts,
      next_expected: new Date(nextDay * DAY_MS).toISOString().slice(0, 10),
      fact_ids: ordered.map((f) => f.id),
      provisional: ordered.some((f) => f.provisional),
    });
    const t = totals.get(currency) ?? { inflow: "0", outflow: "0" };
    t[direction] = decimal.round(decimal.add(t[direction], monthly), 2);
    totals.set(currency, t);
  }
  charges.sort((a, b) => {
    const c = decimal.cmp(b.monthly_equivalent, a.monthly_equivalent);
    return c !== 0 ? c : a.normalized < b.normalized ? -1 : a.normalized > b.normalized ? 1 : 0;
  });
  return {
    charges,
    monthly_equivalent_by_currency: Object.fromEntries([...totals.entries()].sort()),
    considered: facts.length,
    min_occurrences: minOcc,
  };
}
