// `reconcile.run` -- "the agent that decides whether any of the rest is
// true" (deck slide 10). Read-only over the ledger; compares tonight's
// proposed facts against what the ledger believes and emits findings. It
// never fixes anything: "A reconciliation agent that resolves ambiguity on
// its own is worse than none at all."
//
// The five silent errors, one detector each:
//   1. internal transfer booked as income / booked twice
//   2. stale balance wearing fresh clothes
//   3. corrected 1099 that changes last year's answer
//   4. cost basis missing on transferred lots (never assumed zero)
//   5. crypto swap that is a taxable event
// plus the cheap extras: positions vs stated total, fetch failures, new
// accounts.
//
// Findings reference proposed facts by `ref` (`after_refs`) because they
// have no ledger ids yet; `record_findings` resolves refs after commit.

import {
  decimal,
  type BalancePayload,
  type FindingCode,
  type FindingInput,
  type FindingKind,
  type LotPayload,
  type PositionPayload,
  type Severity,
  type TaxDocumentPayload,
  type TransactionPayload,
} from "@fin/contracts";
import type { Ledger, StoredFact } from "@fin/ledger";

import { DEFAULT_THRESHOLDS, type ActionContext, type ActionHandler, type Thresholds } from "../context";
import type { NormalizeOutput, ProposedFact } from "../normalize/normalize";

export interface FindingDraft extends Omit<FindingInput, "after" | "evidence"> {
  /** Ledger fact ids already known. */
  evidence: string[];
  /**
   * Stable identity of the condition (code + subject + the detail that
   * defines it). A finding whose fingerprint already exists in the ledger
   * -- open, or for gap-like codes ever -- is not re-emitted night after
   * night: "if the approval queue is long and boring, you will rubber-stamp
   * it" (deck slide 21). Stored in `detail.fingerprint`.
   */
  fingerprint: string;
  /** Refs of proposed facts (tonight's); resolved to ids after commit. */
  after_refs: string[];
  /** Whether this finding holds its subject's data provisional. */
  holds: boolean;
}

export interface ReconcileOutput {
  run_key: string;
  clean: boolean;
  findings: FindingDraft[];
  provisional_subjects: string[];
  stats: Record<string, number>;
}

export function reconcileHandler(actx: ActionContext): ActionHandler {
  return async (rawInput) => {
    const input = rawInput as NormalizeOutput;
    if (typeof input.run_key !== "string") throw new Error("reconcile: input.run_key is required");
    const thresholds: Thresholds = { ...DEFAULT_THRESHOLDS, ...actx.thresholds };
    return reconcile(input, actx.ledger, thresholds, actx.clock());
  };
}

export function reconcile(input: NormalizeOutput, ledger: Ledger, thresholds: Thresholds, now: Date): ReconcileOutput {
  const asOf = now.toISOString();
  const findings: FindingDraft[] = [];
  const ctx: DetectorContext = { input, ledger, thresholds, asOf, findings };
  detectFetchFailures(ctx);
  detectNewAccounts(ctx);
  detectTransfersAndDuplicates(ctx);
  detectStaleBalances(ctx);
  detectCorrectedTaxDocuments(ctx);
  detectMissingCostBasis(ctx);
  detectCryptoSwaps(ctx);
  detectPositionBalanceMismatch(ctx);

  const fresh = suppressKnown(findings, ledger);
  const provisional = [...new Set(fresh.filter((f) => f.holds).map((f) => f.subject))].sort();
  const stats: Record<string, number> = {};
  for (const f of fresh) stats[f.code] = (stats[f.code] ?? 0) + 1;
  if (findings.length !== fresh.length) stats["suppressed_known"] = findings.length - fresh.length;
  return {
    run_key: input.run_key,
    clean: provisional.length === 0,
    findings: fresh,
    provisional_subjects: provisional,
    stats,
  };
}

/** Codes whose finding, once recorded (open or resolved), is not re-raised while its fingerprint is unchanged. */
const DEDUPE_FOREVER: ReadonlySet<FindingCode> = new Set([
  "missing_cost_basis",
  "corrected_tax_document",
  "crypto_swap_taxable_event",
  "unknown_account",
  "duplicate_transaction",
  "internal_transfer_booked_as_income",
]);

function suppressKnown(drafts: FindingDraft[], ledger: Ledger): FindingDraft[] {
  const known = new Set<string>();
  const openOnly = new Set<string>();
  for (const f of ledger.allFindings(5000)) {
    const fp = typeof f.detail["fingerprint"] === "string" ? (f.detail["fingerprint"] as string) : null;
    if (fp === null) continue;
    known.add(fp);
    if (!f.resolved) openOnly.add(fp);
  }
  return drafts.filter((d) => {
    if (DEDUPE_FOREVER.has(d.code)) return !known.has(d.fingerprint);
    return !openOnly.has(d.fingerprint);
  });
}

interface DetectorContext {
  input: NormalizeOutput;
  ledger: Ledger;
  thresholds: Thresholds;
  asOf: string;
  findings: FindingDraft[];
}

function emit(
  ctx: DetectorContext,
  f: {
    kind: FindingKind;
    code: FindingCode;
    severity: Severity;
    subject: string;
    summary: string;
    detail: Record<string, unknown>;
    evidence?: string[];
    before?: string[];
    after_refs?: string[];
    requires_human: boolean;
    holds: boolean;
    /** Detail keys that identify the condition; default: every key of `detail`. */
    identity?: string[];
  },
): void {
  const idKeys = (f.identity ?? Object.keys(f.detail)).sort();
  const fingerprint = `${f.code}|${f.subject}|${JSON.stringify(idKeys.map((k) => [k, f.detail[k] ?? null]))}`;
  ctx.findings.push({
    kind: f.kind,
    code: f.code,
    severity: f.severity,
    subject: f.subject,
    summary: f.summary,
    detail: { ...f.detail, fingerprint },
    fingerprint,
    evidence: f.evidence ?? [],
    before: f.before ?? [],
    after_refs: f.after_refs ?? [],
    requires_human: f.requires_human,
    emitted_by: "reconciliation",
    as_of: ctx.asOf,
    provenance: { source_id: "handler.reconcile", source_doc_id: null, observed_at: ctx.asOf, via: "reconcile@1" },
    holds: f.holds,
  });
}

function proposed(ctx: DetectorContext, kind: ProposedFact["fact"]["kind"]): ProposedFact[] {
  return ctx.input.facts.filter((f) => f.fact.kind === kind);
}

// --- extras ------------------------------------------------------------

function detectFetchFailures(ctx: DetectorContext): void {
  for (const fl of ctx.input.failures) {
    emit(ctx, {
      kind: "gap",
      code: "fetch_failed",
      severity: "high",
      subject: fl.institution_id,
      summary: `${fl.institution_id} did not answer tonight: ${fl.error}`,
      detail: { via: fl.via, fetched_at: fl.fetched_at, error: fl.error },
      requires_human: true,
      holds: false,
    });
  }
}

function detectNewAccounts(ctx: DetectorContext): void {
  for (const a of ctx.input.accounts) {
    if (!a.is_new) continue;
    emit(ctx, {
      kind: "info",
      code: "unknown_account",
      severity: "info",
      subject: a.account_id,
      summary: `new account ${a.account_id} (${a.type}) at ${a.institution_id}`,
      detail: { institution_id: a.institution_id, type: a.type },
      after_refs: [a.refs.account],
      requires_human: false,
      holds: false,
    });
  }
}

// --- 1. transfers booked as income / duplicates ------------------------

const INCOME_RAW = new Set(["income", "dividend", "interest"]);

function detectTransfersAndDuplicates(ctx: DetectorContext): void {
  // 1a. A paired transfer whose leg the institution typed as income.
  for (const pair of ctx.input.transfers) {
    const incomeLeg = INCOME_RAW.has(pair.in_raw_type) ? pair.in_ref : null;
    if (incomeLeg === null) continue;
    const isRef = !incomeLeg.startsWith("ledger:");
    emit(ctx, {
      kind: "break",
      code: "internal_transfer_booked_as_income",
      severity: "medium",
      subject: pair.in_account,
      summary: `${pair.amount} into ${pair.in_account} was booked as ${pair.in_raw_type} but matches a ${pair.amount} outflow from ${pair.out_account}; reclassified as an internal transfer -- confirm`,
      detail: { transfer_group: pair.group, amount: pair.amount, out_account: pair.out_account, in_account: pair.in_account, in_raw_type: pair.in_raw_type },
      evidence: [pair.out_ref, pair.in_ref].filter((r) => r.startsWith("ledger:")).map((r) => r.slice(7)),
      after_refs: [pair.out_ref, pair.in_ref].filter((r) => !r.startsWith("ledger:")),
      requires_human: true,
      holds: isRef,
    });
  }

  // 1b. The same movement booked twice: same account, same day, same amount,
  // same (normalised) description, different txn ids -- across tonight's
  // proposed transactions and the ledger's current ones.
  interface Tx {
    ref: string | null;
    id: string | null;
    account: string;
    sig: string;
    txn_id: string;
  }
  const sig = (p: TransactionPayload): string =>
    `${p.posted_at.slice(0, 10)}|${p.amount}|${p.description.toLowerCase().replace(/\s+/g, " ").trim()}`;
  const txs: Tx[] = [];
  for (const pf of proposed(ctx, "transaction")) {
    const p = pf.fact.payload as TransactionPayload;
    txs.push({ ref: pf.ref, id: null, account: p.account_id, sig: sig(p), txn_id: p.txn_id });
  }
  const proposedIds = new Set(txs.map((t) => `${t.account}|${t.txn_id}`));
  for (const f of ctx.ledger.asOf({ kind: "transaction" })) {
    const p = f.payload as TransactionPayload;
    if (proposedIds.has(`${p.account_id}|${p.txn_id}`)) continue;
    txs.push({ ref: null, id: f.id, account: p.account_id, sig: sig(p), txn_id: p.txn_id });
  }
  const groups = new Map<string, Tx[]>();
  for (const t of txs) {
    const k = `${t.account}|${t.sig}`;
    const g = groups.get(k) ?? [];
    g.push(t);
    groups.set(k, g);
  }
  for (const [, g] of groups) {
    if (g.length < 2) continue;
    const incoming = g.filter((t) => t.ref !== null);
    if (incoming.length === 0) continue; // an old duplicate already in the ledger was reported the night it arrived
    const first = g[0] as Tx;
    emit(ctx, {
      kind: "break",
      code: "duplicate_transaction",
      severity: "high",
      subject: first.account,
      summary: `${g.length} transactions in ${first.account} share date/amount/description (${first.sig.split("|")[1]} on ${first.sig.split("|")[0]}) under different ids`,
      detail: { signature: first.sig, txn_ids: g.map((t) => t.txn_id) },
      evidence: g.filter((t) => t.id !== null).map((t) => t.id as string),
      before: g.filter((t) => t.id !== null).map((t) => t.id as string),
      after_refs: incoming.map((t) => t.ref as string),
      requires_human: true,
      holds: true,
    });
  }
}

// --- 2. stale balance ---------------------------------------------------

function detectStaleBalances(ctx: DetectorContext): void {
  const maxAgeMs = ctx.thresholds.staleBalanceDays * 86_400_000;
  for (const a of ctx.input.accounts) {
    const age = Date.parse(a.fetched_at) - Date.parse(a.as_of);
    const totalRef = a.refs.balances.find((r) => {
      const pf = ctx.input.facts.find((f) => f.ref === r);
      return pf !== undefined && (pf.fact.payload as BalancePayload).balance_type === "total";
    });
    if (age > maxAgeMs) {
      emit(ctx, {
        kind: "staleness",
        code: "stale_balance",
        severity: "medium",
        subject: a.account_id,
        summary: `${a.account_id}: institution as-of ${a.as_of} is ${(age / 86_400_000).toFixed(1)} days older than tonight's fetch`,
        detail: { as_of: a.as_of, fetched_at: a.fetched_at, age_days: age / 86_400_000 },
        identity: ["as_of"],
        after_refs: totalRef === undefined ? [] : [totalRef],
        requires_human: true,
        holds: true,
      });
      continue;
    }
    // Fresh-looking as-of but frozen value: the total has not moved for
    // longer than the threshold while transactions kept posting to the
    // account. A balance that activity should have moved, and did not, is
    // stale whatever timestamp the feed puts on it.
    if (totalRef === undefined) continue;
    const incoming = ctx.input.facts.find((f) => f.ref === totalRef) as ProposedFact;
    const ip = incoming.fact.payload as BalancePayload;
    const prior = ctx.ledger.asOf({ kind: "balance", subject: a.account_id, key: "total" })[0];
    if (prior === undefined) continue;
    const pp = prior.payload as BalancePayload;
    if (pp.amount !== ip.amount) continue;
    const firstSeen = oldestIdentical(ctx.ledger, prior);
    const frozenMs = Date.parse(a.fetched_at) - Date.parse(firstSeen.observed_at);
    if (frozenMs > maxAgeMs && hasActivitySince(ctx, a.account_id, firstSeen.observed_at)) {
      emit(ctx, {
        kind: "staleness",
        code: "stale_balance",
        severity: "medium",
        subject: a.account_id,
        summary: `${a.account_id}: total ${ip.amount} unchanged since ${firstSeen.observed_at} while transactions kept posting`,
        detail: { amount: ip.amount, stated_as_of: ip.stated_as_of ?? null, unchanged_since: firstSeen.observed_at },
        identity: ["amount", "unchanged_since"],
        evidence: [prior.id],
        before: [prior.id],
        after_refs: [totalRef],
        requires_human: true,
        holds: true,
      });
    }
  }
}

function oldestIdentical(ledger: Ledger, latest: StoredFact): StoredFact {
  // Walk back through the subject/key's observations while amount and stated as-of are identical.
  const rows = ledger.db
    .query<{ id: string }, [string, string, string]>(
      "SELECT id FROM fact WHERE kind = 'balance' AND subject = ? AND key = ? AND seq <= (SELECT seq FROM fact WHERE id = ?) ORDER BY seq DESC",
    )
    .all(latest.subject, latest.key, latest.id);
  const lp = latest.payload as BalancePayload;
  let oldest = latest;
  for (const r of rows) {
    const f = ledger.getFact(r.id);
    if (f === null) break;
    const p = f.payload as BalancePayload;
    if (p.amount !== lp.amount) break;
    oldest = f;
  }
  return oldest;
}

function hasActivitySince(ctx: DetectorContext, account: string, since: string): boolean {
  const sinceMs = Date.parse(since) - 86_400_000;
  const posted = (p: TransactionPayload): boolean => Date.parse(p.posted_at) >= sinceMs;
  if (ctx.input.facts.some((f) => f.fact.kind === "transaction" && f.fact.subject === account && posted(f.fact.payload as TransactionPayload))) {
    return true;
  }
  return ctx.ledger.asOf({ kind: "transaction", subject: account }).some((f) => posted(f.payload as TransactionPayload));
}

// --- 3. corrected tax document ---------------------------------------

function detectCorrectedTaxDocuments(ctx: DetectorContext): void {
  for (const pf of proposed(ctx, "tax_document")) {
    if (pf.fact.supersedes === null) continue;
    const prior = ctx.ledger.getFact(pf.fact.supersedes);
    const np = pf.fact.payload as TaxDocumentPayload;
    const pp = prior?.payload as TaxDocumentPayload | undefined;
    const diff: Record<string, { before: string | null; after: string | null }> = {};
    const keys = new Set([...Object.keys(pp?.totals ?? {}), ...Object.keys(np.totals)]);
    for (const k of keys) {
      const b = pp?.totals[k] ?? null;
      const a = np.totals[k] ?? null;
      if (a !== b) diff[k] = { before: b, after: a };
    }
    emit(ctx, {
      kind: "correction",
      code: "corrected_tax_document",
      severity: "high",
      subject: pf.fact.subject,
      summary: `corrected ${np.form} for ${String(np.tax_year)} (v${String(np.version)}) changes ${Object.keys(diff).join(", ") || "nothing material"}`,
      detail: { form: np.form, tax_year: np.tax_year, version: np.version, diff },
      evidence: prior === null ? [] : [prior.id],
      before: prior === null ? [] : [prior.id],
      after_refs: [pf.ref],
      requires_human: true,
      holds: true,
    });
  }
}

// --- 4. missing cost basis ---------------------------------------------

function detectMissingCostBasis(ctx: DetectorContext): void {
  for (const pf of proposed(ctx, "lot")) {
    const p = pf.fact.payload as LotPayload;
    if (p.cost_basis !== null) continue;
    emit(ctx, {
      kind: "gap",
      code: "missing_cost_basis",
      severity: p.transferred_in ? "high" : "medium",
      subject: pf.fact.subject,
      summary: `${p.transferred_in ? "transferred " : ""}lot ${p.lot_id} (${p.quantity} ${p.instrument.symbol}) has no cost basis -- left unknown, not assumed zero`,
      detail: { lot_id: p.lot_id, symbol: p.instrument.symbol, quantity: p.quantity, acquired_at: p.acquired_at, transferred_in: p.transferred_in },
      after_refs: [pf.ref],
      requires_human: true,
      holds: false,
    });
  }
  const lotSymbols = new Set(proposed(ctx, "lot").map((pf) => `${pf.fact.subject}|${(pf.fact.payload as LotPayload).instrument.symbol.toUpperCase()}`));
  for (const pf of proposed(ctx, "position")) {
    const p = pf.fact.payload as PositionPayload;
    if (decimal.isZero(p.quantity) || p.instrument.asset_class === "cash") continue;
    if (lotSymbols.has(`${pf.fact.subject}|${pf.fact.key}`)) continue; // lots carry the detail
    if (p.cost_basis === null) {
      emit(ctx, {
        kind: "gap",
        code: "missing_cost_basis",
        severity: "medium",
        subject: pf.fact.subject,
        summary: `${p.quantity} ${p.instrument.symbol} in ${pf.fact.subject} has no reported cost basis`,
        detail: { symbol: p.instrument.symbol, quantity: p.quantity, market_value: p.market_value ?? null },
        after_refs: [pf.ref],
        requires_human: true,
        holds: false,
      });
    } else if (decimal.isZero(p.cost_basis) && p.market_value !== null && p.market_value !== undefined && decimal.cmp(p.market_value, "0") > 0) {
      emit(ctx, {
        kind: "gap",
        code: "missing_cost_basis",
        severity: "high",
        subject: pf.fact.subject,
        summary: `${p.quantity} ${p.instrument.symbol} in ${pf.fact.subject} reports a ZERO cost basis against ${p.market_value} market value -- almost certainly an unreported basis, not a free lot`,
        detail: { symbol: p.instrument.symbol, quantity: p.quantity, market_value: p.market_value, cost_basis: "0" },
        after_refs: [pf.ref],
        requires_human: true,
        holds: true,
      });
    }
  }
}

// --- 5. crypto swaps ----------------------------------------------------

function detectCryptoSwaps(ctx: DetectorContext): void {
  const cryptoAccounts = new Set(ctx.input.accounts.filter((a) => a.type === "crypto").map((a) => a.account_id));
  const byAccountTime = new Map<string, ProposedFact[]>();
  for (const pf of proposed(ctx, "transaction")) {
    const p = pf.fact.payload as TransactionPayload;
    if (p.type === "swap" || (p.swap_from !== null && p.swap_from !== undefined)) {
      emit(ctx, swapFinding(pf, p, "the feed marks it as a swap/convert"));
      continue;
    }
    if (!cryptoAccounts.has(pf.fact.subject)) continue;
    const k = `${pf.fact.subject}|${p.posted_at}`;
    const g = byAccountTime.get(k) ?? [];
    g.push(pf);
    byAccountTime.set(k, g);
  }
  // Same instant, one crypto instrument out and a different one in, no fiat leg: a swap in disguise.
  for (const [, g] of byAccountTime) {
    if (g.length < 2) continue;
    const legs = g.map((pf) => ({ pf, p: pf.fact.payload as TransactionPayload }));
    const outLeg = legs.find((l) => l.p.instrument?.asset_class === "crypto" && decimal.cmp(l.p.amount, "0") <= 0 && l.p.type !== "sell");
    const inLeg = legs.find((l) => l.p.instrument?.asset_class === "crypto" && decimal.cmp(l.p.amount, "0") >= 0 && l.p.type !== "buy" && l.p.instrument?.symbol !== outLeg?.p.instrument?.symbol);
    const fiat = legs.some((l) => l.p.instrument === null || l.p.instrument === undefined || l.p.instrument.asset_class === "cash");
    if (outLeg === undefined || inLeg === undefined || fiat) continue;
    const f = swapFinding(outLeg.pf, outLeg.p, `${outLeg.p.instrument?.symbol} out and ${inLeg.p.instrument?.symbol} in at the same instant with no fiat leg`);
    f.after_refs = [outLeg.pf.ref, inLeg.pf.ref];
    emit(ctx, f);
  }
}

function swapFinding(pf: ProposedFact, p: TransactionPayload, why: string): Parameters<typeof emit>[1] {
  return {
    kind: "tax_event",
    code: "crypto_swap_taxable_event",
    severity: "medium",
    subject: pf.fact.subject,
    summary: `${p.description || p.txn_id} in ${pf.fact.subject} is a disposal for tax purposes (${why}); no bank feed will report it as a sale`,
    detail: { txn_id: p.txn_id, posted_at: p.posted_at, swap_from: p.swap_from ?? null, instrument: p.instrument ?? null, quantity: p.quantity ?? null },
    after_refs: [pf.ref],
    requires_human: false,
    holds: false,
  };
}

// --- positions vs stated total ------------------------------------------

function detectPositionBalanceMismatch(ctx: DetectorContext): void {
  for (const a of ctx.input.accounts) {
    if (a.refs.positions.length === 0) continue;
    const bal = (t: string): BalancePayload | null => {
      for (const r of a.refs.balances) {
        const pf = ctx.input.facts.find((f) => f.ref === r);
        const p = pf?.fact.payload as BalancePayload | undefined;
        if (p !== undefined && p.balance_type === t) return p;
      }
      return null;
    };
    const total = bal("total");
    if (total === null) continue;
    const cash = bal("cash");
    const mvs: string[] = [];
    let unknown = false;
    for (const r of a.refs.positions) {
      const pf = ctx.input.facts.find((f) => f.ref === r) as ProposedFact;
      const p = pf.fact.payload as PositionPayload;
      if (p.market_value === null || p.market_value === undefined) {
        if (!decimal.isZero(p.quantity)) unknown = true;
        continue;
      }
      mvs.push(p.market_value);
    }
    if (unknown) continue;
    const sum = decimal.add(decimal.sum(mvs), cash?.amount ?? "0");
    const diff = decimal.abs(decimal.sub(sum, total.amount));
    const tolerance = decimal.cmp(decimal.mul(decimal.abs(total.amount), "0.005"), "1") > 0 ? decimal.mul(decimal.abs(total.amount), "0.005") : "1";
    if (decimal.cmp(diff, tolerance) <= 0) continue;
    const totalRef = a.refs.balances.find((r) => (ctx.input.facts.find((f) => f.ref === r)?.fact.payload as BalancePayload).balance_type === "total") as string;
    emit(ctx, {
      kind: "mismatch",
      code: "position_balance_mismatch",
      severity: "medium",
      subject: a.account_id,
      summary: `${a.account_id}: positions${cash === null ? "" : " + cash"} sum to ${sum} but the institution states ${total.amount} (diff ${diff})`,
      detail: { positions_sum: decimal.sum(mvs), cash: cash?.amount ?? null, stated_total: total.amount, diff },
      after_refs: [totalRef, ...a.refs.positions],
      requires_human: true,
      holds: true,
    });
  }
}
