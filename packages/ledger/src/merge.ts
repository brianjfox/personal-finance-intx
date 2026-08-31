// Merging duplicate accounts -- the repair for ledgers that relinked an
// institution before `normalize` learned to keep account identity across
// a relink (issue #2): each relink minted a second subject for the same
// real account, so Schwab's two accounts render as four and both
// generations count in net worth.
//
// A merge folds the younger duplicate into the older survivor so history
// is continuous, entirely with appended facts (the ledger never updates
// or deletes):
//   - the survivor takes the duplicate's fresher identity (name, mask,
//     institution) and reopens if a delete-institution had closed it;
//   - the duplicate closes with `merged_into`, which `normalize` follows
//     on every later fetch, so the provider's current ids keep resolving
//     to the survivor;
//   - the duplicate's balances, positions and lots are re-stated under
//     the survivor at their original effective times;
//   - the duplicate's transactions move to the survivor, except
//     re-observations of movements the survivor already holds (matched
//     by content, multiset so identical purchases survive); every moved
//     or matched original is superseded by a voided copy, which views
//     and cash flow skip. Tax documents stay where they are: the account
//     they were issued to remains queryable, and moving them would say
//     the form was issued twice.

import {
  sameRealAccount,
  transactionSignature,
  type AccountPayload,
  type FactInput,
  type TransactionPayload,
} from "@fin/contracts";

import type { Ledger, StoredFact } from "./ledger";

export interface MergeCluster {
  /** The account that keeps the history: the earliest-seen of the group. */
  survivor: string;
  /** Younger subjects describing the same real account, oldest first. */
  duplicates: string[];
  institution_id: string;
  name: string;
}

export interface MergeResult {
  survivor: string;
  duplicate: string;
  /** True when the duplicate was already merged into this survivor (nothing written). */
  replayed: boolean;
  balances: number;
  positions: number;
  lots: number;
  transactions_moved: number;
  /** Duplicate movements the survivor already held; voided, not moved. */
  transactions_absorbed: number;
}

function latestAccount(ledger: Ledger, subject: string): StoredFact | null {
  return ledger.asOf({ kind: "account", subject })[0] ?? null;
}

/** The seq of a subject's first account fact: its order of first appearance. */
function firstSeen(ledger: Ledger, subject: string): number {
  const row = ledger.db
    .query<{ n: number | null }, [string]>("SELECT min(seq) AS n FROM fact WHERE kind = 'account' AND subject = ?")
    .get(subject);
  return row?.n ?? Number.MAX_SAFE_INTEGER;
}

/**
 * Groups of accounts at one institution that describe the same real
 * account (`sameRealAccount`: mask/type, else name/currency). Alias
 * subjects already merged are skipped, as are groups where nothing is
 * open (two closed accounts hold no value and need no repair).
 */
export function findMergeCandidates(ledger: Ledger): MergeCluster[] {
  const current = ledger
    .asOf({ kind: "account" })
    .filter((f) => ((f.payload as AccountPayload).merged_into ?? null) === null)
    .sort((a, b) => firstSeen(ledger, a.subject) - firstSeen(ledger, b.subject));
  const byInstitution = new Map<string, StoredFact[]>();
  for (const f of current) {
    const inst = (f.payload as AccountPayload).institution_id;
    const list = byInstitution.get(inst) ?? [];
    list.push(f);
    byInstitution.set(inst, list);
  }
  const clusters: MergeCluster[] = [];
  for (const [inst, facts] of [...byInstitution.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const claimed = new Set<string>();
    for (const [i, head] of facts.entries()) {
      if (claimed.has(head.subject)) continue;
      const hp = head.payload as AccountPayload;
      const dups: string[] = [];
      for (const other of facts.slice(i + 1)) {
        if (claimed.has(other.subject)) continue;
        if (!sameRealAccount(hp, other.payload as AccountPayload)) continue;
        claimed.add(other.subject);
        dups.push(other.subject);
      }
      if (dups.length === 0) continue;
      const anyOpen = [head, ...dups.map((d) => facts.find((f) => f.subject === d) as StoredFact)].some(
        (f) => ((f.payload as AccountPayload).closed_at ?? null) === null,
      );
      if (!anyOpen) continue;
      claimed.add(head.subject);
      clusters.push({ survivor: head.subject, duplicates: dups, institution_id: inst, name: hp.name });
    }
  }
  return clusters;
}

/** Fold `duplicate` into `survivor`. Idempotent: batch ids are derived from the pair, and an already-merged duplicate is a no-op. */
export function mergeAccounts(
  ledger: Ledger,
  o: { survivor: string; duplicate: string; now?: Date },
): MergeResult {
  const { survivor, duplicate } = o;
  if (survivor === duplicate) throw new Error("merge: survivor and duplicate are the same account");
  const survivorPrior = latestAccount(ledger, survivor);
  const dupPrior = latestAccount(ledger, duplicate);
  if (survivorPrior === null) throw new Error(`merge: ${survivor} has no account fact`);
  if (dupPrior === null) throw new Error(`merge: ${duplicate} has no account fact`);
  const dp = dupPrior.payload as AccountPayload;
  const base: MergeResult = {
    survivor,
    duplicate,
    replayed: false,
    balances: 0,
    positions: 0,
    lots: 0,
    transactions_moved: 0,
    transactions_absorbed: 0,
  };
  if ((dp.merged_into ?? null) === survivor) return { ...base, replayed: true };
  if ((dp.merged_into ?? null) !== null) throw new Error(`merge: ${duplicate} is already merged into ${dp.merged_into}`);
  if (((survivorPrior.payload as AccountPayload).merged_into ?? null) !== null) {
    throw new Error(`merge: ${survivor} is itself merged into ${(survivorPrior.payload as AccountPayload).merged_into}`);
  }

  const now = (o.now ?? new Date()).toISOString();
  const today = now.slice(0, 10);
  const provenance = (of: StoredFact) => ({
    source_id: of.source_id,
    source_doc_id: of.source_doc_id,
    provisional: false as const,
  });

  // --- assets: account identities, balances, positions, lots ----------
  const assetFacts: FactInput[] = [];
  // The duplicate is the younger observation of the account (the live
  // link): the survivor takes its identity and reopens; the duplicate
  // closes and points at the survivor forever.
  assetFacts.push({
    kind: "account",
    subject: survivor,
    key: "account",
    payload: {
      ...(survivorPrior.payload as AccountPayload),
      name: dp.name,
      type: dp.type,
      currency: dp.currency,
      masked_number: dp.masked_number ?? null,
      institution_id: dp.institution_id,
      account_id: survivor,
      closed_at: null,
      merged_into: null,
    },
    observed_at: now,
    effective_at: now,
    supersedes: survivorPrior.id,
    writer: "assets_manager",
    ...provenance(dupPrior),
  });
  assetFacts.push({
    kind: "account",
    subject: duplicate,
    key: "account",
    payload: { ...dp, closed_at: dp.closed_at ?? today, merged_into: survivor },
    observed_at: now,
    effective_at: now,
    supersedes: dupPrior.id,
    writer: "assets_manager",
    ...provenance(dupPrior),
  });
  // Re-state the duplicate's current balances/positions/lots under the
  // survivor at their original effective times, so "as of tonight" the
  // survivor carries the live link's figures. Anything the survivor
  // already knows more recently wins and is left alone.
  const restate = (kind: "balance" | "position" | "lot", count: (n: number) => void): void => {
    let n = 0;
    const mine = new Map(ledger.asOf({ kind, subject: survivor }).map((f) => [f.key, f]));
    for (const f of ledger.asOf({ kind, subject: duplicate })) {
      const have = mine.get(f.key);
      if (have !== undefined && have.effective_at >= f.effective_at) continue;
      assetFacts.push({
        kind,
        subject: survivor,
        key: f.key,
        payload: { ...(f.payload as Record<string, unknown>), account_id: survivor },
        observed_at: now,
        effective_at: f.effective_at,
        supersedes: have?.id ?? null,
        writer: "assets_manager",
        ...provenance(f),
      });
      n += 1;
    }
    count(n);
  };
  restate("balance", (n) => (base.balances = n));
  restate("position", (n) => (base.positions = n));
  restate("lot", (n) => (base.lots = n));

  // --- flows: move the duplicate's transactions ------------------------
  const flowFacts: FactInput[] = [];
  const mineKeys = new Set<string>();
  const mineSigs = new Map<string, number>();
  for (const f of ledger.asOf({ kind: "transaction", subject: survivor })) {
    const p = f.payload as TransactionPayload;
    mineKeys.add(f.key);
    if (p.voided === true) continue;
    const s = transactionSignature(p);
    mineSigs.set(s, (mineSigs.get(s) ?? 0) + 1);
  }
  for (const f of ledger.asOf({ kind: "transaction", subject: duplicate })) {
    const p = f.payload as TransactionPayload;
    if (p.voided === true) continue;
    const s = transactionSignature(p);
    const held = mineSigs.get(s) ?? 0;
    const absorbed = held > 0 || mineKeys.has(f.key);
    if (held > 0) mineSigs.set(s, held - 1);
    if (absorbed) base.transactions_absorbed += 1;
    else {
      base.transactions_moved += 1;
      flowFacts.push({
        kind: "transaction",
        subject: survivor,
        key: f.key,
        payload: { ...p, account_id: survivor },
        observed_at: now,
        effective_at: f.effective_at,
        supersedes: null,
        writer: "cash_flow",
        ...provenance(f),
      });
    }
    // Either way the original stops counting: superseded by a voided copy.
    flowFacts.push({
      kind: "transaction",
      subject: duplicate,
      key: f.key,
      payload: { ...p, voided: true },
      observed_at: now,
      effective_at: f.effective_at,
      supersedes: f.id,
      writer: "cash_flow",
      ...provenance(f),
    });
  }

  // Flows first: the `merged_into` marker lands last, so a crash between
  // the two commits leaves a merge a re-run completes (voided originals
  // are simply skipped) rather than one the marker makes look finished.
  if (flowFacts.length > 0) {
    ledger.commit({
      batchId: `merge:${duplicate}->${survivor}:flows`,
      writer: "cash_flow",
      note: `merge ${duplicate} into ${survivor}`,
      facts: flowFacts,
    });
  }
  ledger.commit({
    batchId: `merge:${duplicate}->${survivor}:assets`,
    writer: "assets_manager",
    note: `merge ${duplicate} into ${survivor}`,
    facts: assetFacts,
  });
  return base;
}
