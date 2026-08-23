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

  for (const snap of snapshots) {
    for (const acct of snap.accounts) {
      accounts.push(normalizeAccount(snap, acct, ledger, push, (n) => {
        txNew += n.added;
        txKnown += n.known;
      }));
    }
  }

  const transfers = classifyTransfers(facts, ledger, thresholds);

  return {
    run_key: input.run_key,
    facts,
    accounts,
    failures: input.failures,
    transfers,
    stats: {
      snapshots: snapshots.length,
      accounts: accounts.length,
      facts: facts.length,
      transactions_new: txNew,
      transactions_known: txKnown,
    },
  };
}

function normalizeAccount(
  snap: InstitutionSnapshot,
  acct: SnapshotAccount,
  ledger: Ledger,
  push: (fact: FactInput, prior?: string | null) => string,
  countTx: (n: { added: number; known: number }) => void,
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
    positionRefs.push(push({ ...base, kind: "position", key, writer: "assets_manager", payload }));
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
        currency: acct.currency,
      };
      lotRefs.push(push({ ...base, kind: "lot", key: lotId, writer: "assets_manager", payload: lp }));
    });
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
