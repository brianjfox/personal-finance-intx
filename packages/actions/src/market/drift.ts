// The deterministic half of the Market Manager (deck slides 7/8):
// drift against the written plan's target allocation, and canonical
// candidate orders. Pure over position facts + the plan, so the Auditor
// re-runs it bit-for-bit (slide-16 condition 1) and the model never
// invents a figure -- `emit_proposal` canonicalizes a draft FROM a
// candidate, and the draft's numbers are these numbers.

import {
  decimal,
  type AssetClass,
  type CandidateOrder,
  type DriftLine,
  type DriftReport,
  type InvestmentPlan,
  type LotPayload,
  type PositionPayload,
  type ProposalDraft,
} from "@fin/contracts";
import type { StoredFact } from "@fin/ledger";

import { addYears } from "../tax/math";

export interface DriftInputs {
  runKey: string;
  now: Date;
  plan: InvestmentPlan;
  /** Current position facts (kind `position`). */
  positions: StoredFact[];
  /** Current lot facts, for the SELL candidates' lot choice. */
  lots: StoredFact[];
}

/**
 * Weights are over the INVESTED portfolio (positions with market value);
 * cash positions count toward `cash_value` and the tax-cash check, not
 * the class weights.
 */
export function computeDrift(inputs: DriftInputs): DriftReport {
  const { plan } = inputs;
  const evidence: string[] = [];
  const byClass = new Map<AssetClass, { value: string; positions: { fact: StoredFact; p: PositionPayload }[] }>();
  let invested = "0";
  let cash = "0";
  for (const f of inputs.positions) {
    const p = f.payload as PositionPayload;
    const mv = p.market_value ?? null;
    if (mv === null || decimal.isZero(p.quantity)) continue;
    evidence.push(f.id);
    if (p.instrument.asset_class === "cash") {
      cash = decimal.add(cash, mv);
      continue;
    }
    invested = decimal.add(invested, mv);
    const bucket = byClass.get(p.instrument.asset_class) ?? { value: "0", positions: [] };
    bucket.value = decimal.add(bucket.value, mv);
    bucket.positions.push({ fact: f, p });
    byClass.set(p.instrument.asset_class, bucket);
  }

  const lines: DriftLine[] = [];
  const targets = new Map(plan.targets.map((t) => [t.asset_class, t.weight]));
  const classes = new Set<AssetClass>([...byClass.keys(), ...targets.keys()]);
  for (const cls of [...classes].sort()) {
    const value = byClass.get(cls)?.value ?? "0";
    const weight = decimal.isZero(invested) ? "0" : decimal.round(decimal.div(value, invested), 4);
    const target = targets.get(cls) ?? "0";
    lines.push({ asset_class: cls, value: decimal.round(value, 2), weight, target, drift: decimal.round(decimal.sub(weight, target), 4) });
  }

  // Candidates: one order per out-of-band class, largest |drift| first,
  // deterministic tie-break by class name. SELL trims the class's largest
  // position toward target; BUY adds to its largest existing position
  // (v1 never introduces a new symbol -- that is a human idea, not drift).
  const outOfBand = lines
    .filter((l) => decimal.cmp(decimal.abs(l.drift), plan.band) > 0)
    .sort((a, b) => {
      const d = decimal.cmp(decimal.abs(b.drift), decimal.abs(a.drift));
      return d !== 0 ? d : a.asset_class.localeCompare(b.asset_class);
    });
  const candidates: CandidateOrder[] = [];
  for (const line of outOfBand) {
    const bucket = byClass.get(line.asset_class);
    if (bucket === undefined || bucket.positions.length === 0) continue; // nothing held; buying a new symbol is out of scope
    const largest = [...bucket.positions].sort((a, b) => decimal.cmp(b.p.market_value ?? "0", a.p.market_value ?? "0"))[0];
    if (largest === undefined) continue;
    const p = largest.p;
    const price = p.price ?? (decimal.isZero(p.quantity) ? null : decimal.div(p.market_value ?? "0", p.quantity));
    if (price === null || decimal.isZero(price)) continue;
    const side = decimal.cmp(line.drift, "0") > 0 ? "SELL" : "BUY";
    // Order value = the drift excess against the CURRENT portfolio value.
    let value = decimal.mul(decimal.abs(line.drift), invested);
    if (plan.constraints.max_order_value != null && decimal.cmp(value, plan.constraints.max_order_value) > 0) {
      value = plan.constraints.max_order_value;
    }
    // Whole shares only: floor(value / price).
    const quantity = decimal.div(value, price).split(".")[0] ?? "0";
    if (decimal.isZero(quantity)) continue;
    const estValue = decimal.round(decimal.mul(quantity, price), 2);
    const taxLots =
      side === "SELL"
        ? fifoLotTreatments(inputs.lots, largest.fact.subject, p.instrument.symbol, quantity, inputs.now)
        : undefined;
    candidates.push({
      index: candidates.length,
      side,
      account: largest.fact.subject,
      symbol: p.instrument.symbol,
      quantity,
      est_price: decimal.round(price, 2),
      est_value: estValue,
      rationale: `${line.asset_class} ${formatPp(line.drift)} ${decimal.cmp(line.drift, "0") > 0 ? "over" : "under"} target (band ${formatPp(plan.band)})`,
      ...(taxLots !== undefined ? { tax_lots: taxLots } : {}),
    });
  }

  return {
    run_key: inputs.runKey,
    as_of: inputs.now.toISOString(),
    portfolio_value: decimal.round(decimal.add(invested, cash), 2),
    cash_value: decimal.round(cash, 2),
    by_class: lines,
    candidates,
    evidence: [...new Set(evidence)],
  };
}

/** FIFO lot consumption for a SELL, labelling each consumed lot LT/ST. */
function fifoLotTreatments(
  lots: StoredFact[],
  subject: string,
  symbol: string,
  quantity: string,
  now: Date,
): CandidateOrder["tax_lots"] {
  const today = now.toISOString().slice(0, 10);
  const mine = lots
    .filter((f) => f.subject === subject && (f.payload as LotPayload).instrument.symbol.toUpperCase() === symbol.toUpperCase())
    .map((f) => f.payload as LotPayload)
    .sort((a, b) => a.acquired_at.localeCompare(b.acquired_at));
  if (mine.length === 0) return [{ lot_id: "unknown", treatment: "unknown" }];
  const out: NonNullable<CandidateOrder["tax_lots"]> = [];
  let remaining = decimal.parseDecimal(quantity);
  for (const lot of mine) {
    if (remaining <= 0n) break;
    const take = decimal.parseDecimal(lot.quantity) < remaining ? decimal.parseDecimal(lot.quantity) : remaining;
    remaining -= take;
    out.push({ lot_id: lot.lot_id, treatment: today > addYears(lot.acquired_at, 1) ? "LTCG" : "STCG" });
  }
  if (remaining > 0n) out.push({ lot_id: "unknown", treatment: "unknown" });
  return out;
}

function formatPp(fraction: string): string {
  return `${decimal.round(decimal.mul(decimal.abs(fraction), "100"), 1)}pp`;
}

/** The single canonicalizer both `emit_proposal` and the tests use. */
export function buildProposalDraft(
  drift: DriftReport,
  candidateIndex: number,
  opts: { thesis: string; confidence: number; now: Date; expiryMs?: number },
): ProposalDraft {
  const c = drift.candidates[candidateIndex];
  if (c === undefined) {
    throw new Error(`emit_proposal: no candidate ${String(candidateIndex)} (drift has ${String(drift.candidates.length)})`);
  }
  if (drift.evidence.length === 0) throw new Error("emit_proposal: no evidence, no proposal");
  const expires = new Date(opts.now.getTime() + (opts.expiryMs ?? DEFAULT_PROPOSAL_EXPIRY_MS)).toISOString();
  return {
    from: "market_manager",
    subject: c.account,
    candidate_index: candidateIndex,
    action: {
      verb: c.side,
      instrument: c.symbol,
      quantity: c.quantity,
      amount: { amount: c.est_value, currency: "USD" },
      detail: c.rationale,
    },
    thesis: opts.thesis,
    evidence: drift.evidence,
    ...(c.tax_lots !== undefined ? { tax_lots: c.tax_lots } : {}),
    confidence: Math.min(1, Math.max(0, opts.confidence)),
    requires: ["auditor.review", "human.approve"],
    expires,
    as_of: drift.as_of,
  };
}

/** "A recommendation older than its window is dead, not stale advice." */
export const DEFAULT_PROPOSAL_EXPIRY_MS = 7 * 24 * 3600_000;
