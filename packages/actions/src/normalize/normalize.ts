// `normalize.snapshots` -- map to canonical schema; dedupe; classify
// internal transfers (deck slide 15, step 2).
//
// Pure with respect to the outside world: it reads the ledger (to diff
// against what is already known and to find the prior version a corrected
// tax form supersedes) and returns proposed facts. It commits nothing. Its
// output is deterministic given its input and the ledger state, so a
// crash re-run reproduces it exactly.
//
// Output shape:
//   { run_key, facts: [{ ref, fact }], accounts: [...], failures, transfers, stats }
// `ref` is a stable handle (`f0`, `f1`, ...) the reconcile and commit steps
// use to talk about a proposed fact before it has a ledger id.

import {
  decimal,
  sameRealAccount,
  transactionSignature,
  type AccountPayload,
  type FactInput,
  type FetchFailure,
  type FetchResult,
  type InstitutionSnapshot,
  type LotPayload,
  type PositionPayload,
  type SnapshotAccount,
  type TaxDocumentPayload,
  type TransactionPayload,
  type TransactionType,
} from "@fin/contracts";
import type { Ledger, StoredFact } from "@fin/ledger";

import { DEFAULT_THRESHOLDS, type ActionContext, type ActionHandler, type Thresholds } from "../context";

export interface ProposedFact {
  ref: string;
  fact: FactInput;
  /** When the fact replaces an identical (subject, key) already in the ledger with a different payload. */
  prior_id?: string | null;
}

export interface NormalizeAccount {
  institution_id: string;
  account_id: string;
  type: SnapshotAccount["type"];
  as_of: string;
  fetched_at: string;
  /** True when the ledger had no account fact for this id before tonight. */
  is_new: boolean;
  /** The provider id this account arrived under when a relink minted a new one; facts were re-homed to the known subject. */
  remapped_from?: string;
  /** Refs of this account's balance facts, position facts, etc. */
  refs: { account: string; balances: string[]; positions: string[]; lots: string[]; transactions: string[]; tax_documents: string[] };
  source_doc_id: string | null;
}

export interface TransferPair {
  group: string;
  out_ref: string;
  in_ref: string;
  amount: string;
  out_account: string;
  in_account: string;
  /** The institution's own type for each leg before reclassification. */
  out_raw_type: TransactionType;
  in_raw_type: TransactionType;
}

export interface NormalizeOutput {
  run_key: string;
  facts: ProposedFact[];
  accounts: NormalizeAccount[];
  failures: FetchFailure[];
  transfers: TransferPair[];
  /** Open accounts a complete feed stopped reporting; each got a closing fact. */
  closed: Array<{ institution_id: string; account_id: string; ref: string }>;
  /** Institutions that produced a snapshot tonight: their open fetch_failed findings are moot. */
  answered: string[];
  stats: { snapshots: number; accounts: number; facts: number; transactions_new: number; transactions_known: number };
}

export interface NormalizeInput extends FetchResult {
  run_key: string;
}

const INCOME_LIKE: ReadonlySet<TransactionType> = new Set(["income", "dividend", "interest", "credit"]);
const OUTFLOW_LIKE: ReadonlySet<TransactionType> = new Set(["debit", "transfer_out", "other"]);
const INFLOW_LIKE: ReadonlySet<TransactionType> = new Set(["credit", "transfer_in", "income", "other"]);

export function normalizeHandler(actx: ActionContext): ActionHandler {
  return async (rawInput) => {
    const input = rawInput as NormalizeInput;
    if (typeof input.run_key !== "string") throw new Error("normalize: input.run_key is required");
    const thresholds: Thresholds = { ...DEFAULT_THRESHOLDS, ...actx.thresholds };
    return normalize(input, actx.ledger, thresholds);
  };
}

export function normalize(input: NormalizeInput, ledger: Ledger, thresholds: Thresholds): NormalizeOutput {
  const facts: ProposedFact[] = [];
  const accounts: NormalizeAccount[] = [];
  let txNew = 0;
  let txKnown = 0;
  const nextRef = (): string => `f${facts.length}`;
  const push = (fact: FactInput, prior_id: string | null = null): string => {
    const ref = nextRef();
    facts.push(prior_id === null ? { ref, fact } : { ref, fact, prior_id });
    return ref;
  };

  // Deterministic ordering: institutions by id, accounts by id (adapters already sort).
  const snapshots = [...input.snapshots].sort((a, b) => a.institution_id.localeCompare(b.institution_id));
  const closed: NormalizeOutput["closed"] = [];

  for (const snap of snapshots) {
    const resolved = resolveAccountIdentities(snap, ledger, push);
    for (const { acct, remappedFrom } of resolved) {
      // The operator ignored this account: record NOTHING while the flag
      // is set. It stays closed (the feed cannot reopen it), it still
      // counts as reported so the stale-close below leaves it alone, and
      // restoring the account lets the next fetch fill it in again.
      const prior = ledger.asOf({ kind: "account", subject: acct.account_id })[0];
      if (prior !== undefined && (prior.payload as AccountPayload).ignored === true) continue;
      accounts.push(normalizeAccount(snap, acct, ledger, push, (n) => {
        txNew += n.added;
        txKnown += n.known;
      }, remappedFrom));
    }
    // A complete feed that stops reporting an open account is telling us
    // the account no longer exists there: close it, the way positions the
    // institution stopped reporting get a zero-quantity close. Should it
    // ever reappear, its next account fact reopens it.
    if (snap.complete === true) {
      const reported = new Set(resolved.map((r) => r.acct.account_id));
      for (const f of ledger.asOf({ kind: "account" })) {
        const p = f.payload as AccountPayload;
        if (p.institution_id !== snap.institution_id || reported.has(f.subject)) continue;
        if ((p.closed_at ?? null) !== null || (p.merged_into ?? null) !== null) continue;
        const ref = push({
          subject: f.subject,
          kind: "account",
          key: "account",
          writer: "assets_manager",
          observed_at: snap.fetched_at,
          effective_at: snap.fetched_at,
          source_id: snap.institution_id,
          source_doc_id: snap.raw_document_ids[0] ?? null,
          supersedes: f.id,
          provisional: false,
          payload: { ...p, closed_at: snap.fetched_at.slice(0, 10) },
        });
        closed.push({ institution_id: snap.institution_id, account_id: f.subject, ref });
      }
    }
  }

  const transfers = classifyTransfers(facts, ledger, thresholds);

  return {
    run_key: input.run_key,
    facts,
    accounts,
    failures: input.failures,
    transfers,
    closed,
    answered: [...new Set(snapshots.map((s) => s.institution_id))],
    stats: {
      snapshots: snapshots.length,
      accounts: accounts.length,
      facts: facts.length,
      transactions_new: txNew,
      transactions_known: txKnown,
    },
  };
}

/**
 * Resolve tonight's provider account ids to the ledger's subjects. A
 * relink mints a brand-new provider id for the same real account
 * (Plaid's account_id is item-scoped; Enable Banking's uid is
 * session-scoped), so an id the ledger has never seen is first chased
 * through `merged_into` markers, then identity-matched (mask/type, or
 * name/currency) against the institution's open accounts. A match
 * re-homes the whole snapshot account onto the known subject -- history,
 * balances and transactions stay continuous -- and leaves a closed alias
 * fact under the new provider id so every later fetch resolves exactly.
 */
function resolveAccountIdentities(
  snap: InstitutionSnapshot,
  ledger: Ledger,
  push: (fact: FactInput, prior?: string | null) => string,
): Array<{ acct: SnapshotAccount; remappedFrom: string | null }> {
  const incoming = new Set(snap.accounts.map((a) => a.account_id));
  const known = new Map<string, StoredFact>();
  for (const f of ledger.asOf({ kind: "account" })) {
    if ((f.payload as AccountPayload).institution_id === snap.institution_id) known.set(f.subject, f);
  }
  const claimed = new Set<string>();
  const sorted = [...snap.accounts].sort((a, b) => a.account_id.localeCompare(b.account_id));
  return sorted.map((acct) => {
    const prior = known.get(acct.account_id);
    if (prior !== undefined) {
      // Known subject; follow merge markers to the surviving account.
      let target: string | null = null;
      let cur = prior;
      for (let hops = 0; hops < 8; hops += 1) {
        const next = (cur.payload as AccountPayload).merged_into ?? null;
        if (next === null || next === acct.account_id) break;
        target = next;
        const nf = known.get(next);
        if (nf === undefined || nf === cur) break;
        cur = nf;
      }
      if (target === null || claimed.has(target)) return { acct, remappedFrom: null };
      claimed.add(target);
      return { acct: { ...acct, account_id: target }, remappedFrom: acct.account_id };
    }
    // Never-seen provider id: does it describe an account we already
    // hold? Open accounts match, and so do operator-ignored ones -- a
    // relink's new id must resolve to the ignored account (which stays
    // ignored) rather than resurrect it as a fresh visible one.
    const match = [...known.values()]
      .filter((f) => {
        const p = f.payload as AccountPayload;
        return (
          ((p.closed_at ?? null) === null || p.ignored === true) &&
          (p.merged_into ?? null) === null &&
          !incoming.has(f.subject) &&
          !claimed.has(f.subject) &&
          sameRealAccount(p, acct)
        );
      })
      .sort((a, b) => a.subject.localeCompare(b.subject))[0];
    if (match === undefined) return { acct, remappedFrom: null };
    claimed.add(match.subject);
    // Alias: the new provider id resolves here from now on, and never
    // counts as an account of its own.
    push({
      subject: acct.account_id,
      kind: "account",
      key: "account",
      writer: "assets_manager",
      observed_at: snap.fetched_at,
      effective_at: snap.fetched_at,
      source_id: snap.institution_id,
      source_doc_id: snap.raw_document_ids[0] ?? null,
      supersedes: null,
      provisional: false,
      payload: {
        account_id: acct.account_id,
        institution_id: snap.institution_id,
        name: acct.name,
        type: acct.type,
        currency: acct.currency,
        masked_number: acct.masked_number ?? null,
        closed_at: snap.fetched_at.slice(0, 10),
        merged_into: match.subject,
      },
    });
    return { acct: { ...acct, account_id: match.subject }, remappedFrom: acct.account_id };
  });
}

function normalizeAccount(
  snap: InstitutionSnapshot,
  acct: SnapshotAccount,
  ledger: Ledger,
  push: (fact: FactInput, prior?: string | null) => string,
  countTx: (n: { added: number; known: number }) => void,
  remappedFrom: string | null = null,
): NormalizeAccount {
  const observed = snap.fetched_at;
  const effective = acct.as_of;
  const docId = snap.raw_document_ids[0] ?? null;
  const base = {
    subject: acct.account_id,
    observed_at: observed,
    effective_at: effective,
    source_id: snap.institution_id,
    source_doc_id: docId,
    supersedes: null,
    provisional: false,
  } as const;

  const priorAccount = ledger.asOf({ kind: "account", subject: acct.account_id })[0] ?? null;
  const accountRef = push({
    ...base,
    kind: "account",
    key: "account",
    writer: "assets_manager",
    payload: {
      account_id: acct.account_id,
      institution_id: snap.institution_id,
      name: acct.name,
      type: acct.type,
      currency: acct.currency,
      masked_number: acct.masked_number ?? null,
    },
  });

  const balanceRefs = acct.balances.map((b) =>
    push({
      ...base,
      kind: "balance",
      key: b.balance_type,
      writer: "assets_manager",
      payload: {
        account_id: acct.account_id,
        balance_type: b.balance_type,
        amount: b.amount,
        currency: acct.currency,
        stated_as_of: acct.as_of,
      },
    }),
  );

  // Positions: every reported position, plus a zero-quantity close for any
  // position the ledger currently holds for this account that the
  // institution no longer reports.
  const positionRefs: string[] = [];
  const lotRefs: string[] = [];
  const seenSymbols = new Set<string>();
  for (const p of acct.positions ?? []) {
    const key = positionKey(p.instrument.symbol);
    seenSymbols.add(key);
    const payload: PositionPayload = {
      account_id: acct.account_id,
      instrument: {
        symbol: p.instrument.symbol,
        cusip: p.instrument.cusip ?? null,
        name: p.instrument.name ?? null,
        asset_class: p.instrument.asset_class,
      },
      quantity: p.quantity,
      price: p.price ?? null,
      market_value: p.market_value ?? (p.price !== undefined && p.price !== null ? decimal.mul(p.price, p.quantity) : null),
      currency: acct.currency,
      cost_basis: p.cost_basis,
      basis_known: p.cost_basis !== null,
    };
    // Lots re-derived from history arrive identical night after night (a
    // thousand of them for an active account): only a CHANGED lot gets a
    // new fact; an unchanged one keeps the fact it has (issue #53). An
    // OPERATOR-entered basis outlives re-derivation: the adapter keeps
    // reporting cost_basis null, and the held basis is carried forward,
    // scaled by quantity when the lot was partially consumed since
    // (issue #57) -- the acquisition date the operator corrected too.
    const heldLots = p.lots !== undefined ? new Map(ledger.asOf({ kind: "lot", subject: acct.account_id }).map((f) => [f.key, f.payload as LotPayload])) : new Map<string, LotPayload>();
    const sameLot = (a: LotPayload, b: LotPayload): boolean =>
      a.quantity === b.quantity &&
      a.cost_basis === b.cost_basis &&
      a.acquired_at === b.acquired_at &&
      a.basis_known === b.basis_known &&
      a.transferred_in === b.transferred_in &&
      (a.value_at_transfer ?? null) === (b.value_at_transfer ?? null) &&
      (a.basis_source ?? null) === (b.basis_source ?? null) &&
      a.instrument.symbol === b.instrument.symbol;
    const effectiveLots: LotPayload[] = [];
    const changedLots: { key: string; payload: LotPayload }[] = [];
    (p.lots ?? []).forEach((lot, i) => {
      const lotId = lot.lot_id ?? `${p.instrument.symbol}:${lot.acquired_at}:${i}`;
      const lp: LotPayload = {
        account_id: acct.account_id,
        lot_id: lotId,
        instrument: payload.instrument,
        quantity: lot.quantity,
        acquired_at: lot.acquired_at,
        cost_basis: lot.cost_basis,
        basis_known: lot.cost_basis !== null,
        transferred_in: lot.transferred_in ?? false,
        ...(lot.value_at_transfer != null ? { value_at_transfer: lot.value_at_transfer } : {}),
        currency: acct.currency,
      };
      const held = heldLots.get(lotId);
      if (held?.basis_source === "operator" && lp.cost_basis === null && held.cost_basis !== null && !decimal.isZero(held.quantity)) {
        lp.cost_basis = decimal.round(decimal.div(decimal.mul(held.cost_basis, lp.quantity), held.quantity), 2);
        lp.basis_known = true;
        lp.basis_source = "operator";
        lp.acquired_at = held.acquired_at;
      }
      effectiveLots.push(lp);
      if (held !== undefined && sameLot(held, lp)) return;
      changedLots.push({ key: lotId, payload: lp });
    });
    // A position whose institution states no basis fills in from its lots
    // once every one is known AND they cover the whole position (issue
    // #57/#62) -- partial coverage must not masquerade as a full basis.
    // When the institution reports no lots at all, operator-added ledger
    // lots (issue #62) serve the same way; they are never superseded here.
    const basisLots =
      p.lots !== undefined
        ? effectiveLots.filter((l) => !decimal.isZero(l.quantity))
        : ledger
            .asOf({ kind: "lot", subject: acct.account_id })
            .map((f) => f.payload as LotPayload)
            .filter((l) => l.instrument.symbol.toUpperCase() === key && !decimal.isZero(l.quantity));
    if (
      payload.cost_basis === null &&
      basisLots.length > 0 &&
      basisLots.every((l) => l.basis_known) &&
      decimal.cmp(decimal.sum(basisLots.map((l) => l.quantity)), payload.quantity) === 0
    ) {
      payload.cost_basis = decimal.round(decimal.sum(basisLots.map((l) => l.cost_basis as string)), 2);
      payload.basis_known = true;
    }
    positionRefs.push(push({ ...base, kind: "position", key, writer: "assets_manager", payload }));
    for (const c of changedLots) lotRefs.push(push({ ...base, kind: "lot", key: c.key, writer: "assets_manager", payload: c.payload }));
    // An adapter that reports lots reports ALL of the symbol's open lots:
    // a ledger lot it no longer lists was consumed (or re-derived under a
    // new id) and is superseded at quantity 0 -- the same rule positions
    // get below (issue #53).
    if (p.lots !== undefined) {
      const reported = new Set((p.lots ?? []).map((lot, i) => lot.lot_id ?? `${p.instrument.symbol}:${lot.acquired_at}:${i}`));
      for (const held of ledger.asOf({ kind: "lot", subject: acct.account_id })) {
        const hp = held.payload as LotPayload;
        if (hp.instrument.symbol.toUpperCase() !== p.instrument.symbol.toUpperCase() || reported.has(held.key) || decimal.isZero(hp.quantity)) continue;
        lotRefs.push(push({ ...base, kind: "lot", key: held.key, writer: "assets_manager", payload: { ...hp, quantity: "0" } }));
      }
    }
  }
  if (acct.positions !== undefined) {
    for (const held of ledger.asOf({ kind: "position", subject: acct.account_id })) {
      const hp = held.payload as PositionPayload;
      if (seenSymbols.has(held.key) || decimal.isZero(hp.quantity)) continue;
      positionRefs.push(
        push({
          ...base,
          kind: "position",
          key: held.key,
          writer: "assets_manager",
          payload: { ...hp, quantity: "0", market_value: "0" },
        }),
      );
    }
  }

  // Transactions: only new or changed (by key) -- they are immutable events.
  const transactionRefs: string[] = [];
  let added = 0;
  let known = 0;
  const existing = new Map<string, StoredFact>();
  for (const f of ledger.asOf({ kind: "transaction", subject: acct.account_id })) existing.set(f.key, f);
  // A relink re-observes the same movements under new provider txn ids.
  // A tonight-id the ledger has never seen still counts as known when an
  // existing transaction (under some other id, not also reported tonight)
  // has the same content; the multiset count keeps two genuinely
  // identical purchases from absorbing each other.
  const incomingIds = new Set((acct.transactions ?? []).map((t) => t.txn_id));
  const bySig = new Map<string, number>();
  for (const f of existing.values()) {
    const p = f.payload as TransactionPayload;
    if (p.voided === true || incomingIds.has(f.key)) continue;
    const s = transactionSignature(p);
    bySig.set(s, (bySig.get(s) ?? 0) + 1);
  }
  for (const t of acct.transactions ?? []) {
    const payload: TransactionPayload = {
      account_id: acct.account_id,
      txn_id: t.txn_id,
      posted_at: t.posted_at,
      amount: t.amount,
      currency: acct.currency,
      type: t.type,
      description: t.description,
      instrument: t.instrument ?? null,
      quantity: t.quantity ?? null,
      transfer_group: null,
      counterparty_account_id: null,
      raw_category: t.raw_category ?? t.type,
      swap_from: t.swap_from ?? null,
    };
    const prior = existing.get(t.txn_id);
    if (prior !== undefined && samePayloadIgnoringClassification(prior.payload as TransactionPayload, payload)) {
      known += 1;
      continue;
    }
    if (prior === undefined) {
      const s = transactionSignature(payload);
      const have = bySig.get(s) ?? 0;
      if (have > 0) {
        bySig.set(s, have - 1);
        known += 1;
        continue;
      }
    }
    added += 1;
    transactionRefs.push(
      push(
        {
          ...base,
          kind: "transaction",
          key: t.txn_id,
          effective_at: t.posted_at,
          writer: "cash_flow",
          payload,
        },
        prior?.id ?? null,
      ),
    );
  }
  countTx({ added, known });

  // Tax documents: a corrected form supersedes the prior version of the same (form, year).
  const taxRefs: string[] = [];
  for (const d of acct.tax_documents ?? []) {
    const key = `${d.form}:${String(d.tax_year)}`;
    const prior = ledger.asOf({ kind: "tax_document", subject: acct.account_id, key })[0] ?? null;
    const payload: TaxDocumentPayload = {
      account_id: acct.account_id,
      tax_year: d.tax_year,
      form: d.form,
      corrected: d.corrected,
      version: d.version ?? (prior === null ? 1 : (prior.payload as TaxDocumentPayload).version + 1),
      issued_at: d.issued_at,
      totals: d.totals,
    };
    if (prior !== null) {
      const pp = prior.payload as TaxDocumentPayload;
      if (JSON.stringify(pp.totals) === JSON.stringify(payload.totals) && pp.corrected === payload.corrected) continue;
      taxRefs.push(
        push(
          {
            ...base,
            kind: "tax_document",
            key,
            effective_at: `${d.issued_at}T00:00:00.000Z`,
            source_doc_id: d.document_id ?? docId,
            writer: "document_vault",
            payload: { ...payload, corrected: true },
            supersedes: prior.id,
          },
          prior.id,
        ),
      );
    } else {
      taxRefs.push(
        push({
          ...base,
          kind: "tax_document",
          key,
          effective_at: `${d.issued_at}T00:00:00.000Z`,
          source_doc_id: d.document_id ?? docId,
          writer: "document_vault",
          payload,
        }),
      );
    }
  }

  return {
    institution_id: snap.institution_id,
    account_id: acct.account_id,
    type: acct.type,
    as_of: acct.as_of,
    fetched_at: snap.fetched_at,
    is_new: priorAccount === null,
    ...(remappedFrom !== null ? { remapped_from: remappedFrom } : {}),
    refs: {
      account: accountRef,
      balances: balanceRefs,
      positions: positionRefs,
      lots: lotRefs,
      transactions: transactionRefs,
      tax_documents: taxRefs,
    },
    source_doc_id: docId,
  };
}

export function positionKey(symbol: string): string {
  return symbol.trim().toUpperCase();
}

function samePayloadIgnoringClassification(a: TransactionPayload, b: TransactionPayload): boolean {
  const strip = (p: TransactionPayload): string =>
    JSON.stringify({
      amount: p.amount,
      posted_at: p.posted_at,
      description: p.description,
      instrument: p.instrument ?? null,
      quantity: p.quantity ?? null,
      raw_category: p.raw_category ?? null,
    });
  return strip(a) === strip(b);
}

/**
 * Pair outflows and inflows of equal size across distinct household
 * accounts within the transfer window; mark both legs as one internal
 * transfer. Candidates are tonight's proposed transactions plus the
 * ledger's current transactions (a leg may have arrived on an earlier
 * night). Only proposed facts are rewritten; a ledger leg that now has a
 * partner is reported in the pair so reconciliation can surface it.
 */
function classifyTransfers(facts: ProposedFact[], ledger: Ledger, thresholds: Thresholds): TransferPair[] {
  interface Leg {
    ref: string | null; // null = already in ledger
    id: string | null;
    account: string;
    amount: string; // signed
    posted: number;
    type: TransactionType;
    payload: TransactionPayload;
  }
  const legs: Leg[] = [];
  for (const pf of facts) {
    if (pf.fact.kind !== "transaction") continue;
    const p = pf.fact.payload as TransactionPayload;
    legs.push({ ref: pf.ref, id: null, account: p.account_id, amount: p.amount, posted: Date.parse(p.posted_at), type: p.type, payload: p });
  }
  const proposedKeys = new Set(legs.map((l) => `${l.account}|${l.payload.txn_id}`));
  for (const f of ledger.asOf({ kind: "transaction" })) {
    const p = f.payload as TransactionPayload;
    if (p.voided === true) continue; // a void is not a movement
    if (proposedKeys.has(`${p.account_id}|${p.txn_id}`)) continue;
    if (p.transfer_group !== null && p.transfer_group !== undefined) continue; // already paired
    legs.push({ ref: null, id: f.id, account: p.account_id, amount: p.amount, posted: Date.parse(p.posted_at), type: p.type, payload: p });
  }
  const windowMs = thresholds.transferWindowDays * 86_400_000;
  const outs = legs.filter((l) => decimal.cmp(l.amount, "0") < 0 && (OUTFLOW_LIKE.has(l.type) || l.type === "transfer_out"));
  const ins = legs.filter((l) => decimal.cmp(l.amount, "0") > 0 && (INFLOW_LIKE.has(l.type) || INCOME_LIKE.has(l.type) || l.type === "transfer_in"));
  const used = new Set<Leg>();
  const pairs: TransferPair[] = [];
  // Deterministic: sort outs by posted then account; for each, the closest unused in.
  outs.sort((a, b) => a.posted - b.posted || a.account.localeCompare(b.account) || a.payload.txn_id.localeCompare(b.payload.txn_id));
  for (const o of outs) {
    if (o.ref === null && used.has(o)) continue;
    let best: Leg | null = null;
    let bestDist = Number.POSITIVE_INFINITY;
    for (const i of ins) {
      if (used.has(i) || i.account === o.account) continue;
      if (decimal.cmp(decimal.abs(o.amount), i.amount) !== 0) continue;
      const dist = Math.abs(i.posted - o.posted);
      if (dist > windowMs) continue;
      if (dist < bestDist || (dist === bestDist && best !== null && i.payload.txn_id < best.payload.txn_id)) {
        best = i;
        bestDist = dist;
      }
    }
    if (best === null) continue;
    if (o.ref === null && best.ref === null) continue; // both already in ledger: nothing to rewrite tonight
    used.add(o);
    used.add(best);
    const group = `xfer:${[o.account + "/" + o.payload.txn_id, best.account + "/" + best.payload.txn_id].sort().join("~")}`;
    const rewrite = (leg: Leg, type: TransactionType, counterparty: string): void => {
      if (leg.ref === null) return;
      const pf = facts.find((f) => f.ref === leg.ref);
      if (pf === undefined) return;
      const p = pf.fact.payload as TransactionPayload;
      pf.fact = { ...pf.fact, payload: { ...p, type, transfer_group: group, counterparty_account_id: counterparty } };
    };
    rewrite(o, "transfer_out", best.account);
    rewrite(best, "transfer_in", o.account);
    pairs.push({
      group,
      out_ref: o.ref ?? `ledger:${o.id ?? ""}`,
      in_ref: best.ref ?? `ledger:${best.id ?? ""}`,
      amount: best.amount,
      out_account: o.account,
      in_account: best.account,
      out_raw_type: o.type,
      in_raw_type: best.type,
    });
  }
  return pairs;
}
