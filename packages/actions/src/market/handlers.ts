// The proposal pipeline's deterministic handlers (Phase 4, deck slide 16):
//
//   mm.drift          (market_manager)  positions vs the written plan ->
//                                       drift report + canonical candidates
//   audit.intake      (auditor)         parse the Market Manager's reply
//                                       (BUILD_PLAN §8.1 bridge), validate
//                                       the draft, RECORD the recommendation
//   audit.review      (auditor)         re-run every figure; the four
//                                       slide-16 blocking conditions
//   govern.decision   (operator)        the delivered approval signal ->
//                                       Approval row (scoped, bounded,
//                                       expiring; idempotent by signal id)
//   execution.prepare (execution)       Approval -> Instruction, status
//                                       "prepared" -- NEVER sent (Phase 4
//                                       ships with execution disabled)
//   govern.rejected / govern.expired / govern.exhausted (scheduler)
//
// Every handler takes `run_key` and derives ids deterministically from
// it, so crash replays land exactly one row at every layer.

import {
  assertType,
  decimal,
  InvestmentPlan,
  ProposalDraft,
  type Approval,
  type AuditBlock,
  type AuditVerdict,
  type BalancePayload,
  type DriftReport,
  type Instruction,
  type LotPayload,
  type ObligationPayload,
  type Recommendation,
  type TransactionPayload,
} from "@fin/contracts";
import {
  appendApproval,
  appendAuditVerdict,
  appendInstruction,
  appendRecommendation,
  approvalFor,
  getRecommendation,
  listRecommendations,
  verdictsFor,
} from "@fin/ledger";

import { CAP, type ActionContext, type ActionHandler } from "../context";
import { washSales, realizedGains, type DatedLot, type DatedTransaction } from "../tax/math";
import { computeDrift, type DriftInputs } from "./drift";

const DEFAULT_TAX_CASH_HORIZON_DAYS = 60;

function planOf(actx: ActionContext): InvestmentPlan {
  const raw = actx.plan?.() ?? null;
  if (raw === null) throw new Error("market: no plan.json configured; write the investment plan before proposing");
  return assertType(InvestmentPlan, raw, "plan.json");
}

function driftInputs(actx: ActionContext, runKey: string): DriftInputs {
  return {
    runKey,
    now: actx.clock(),
    plan: planOf(actx),
    positions: actx.ledger.asOf({ kind: "position" }),
    lots: actx.ledger.asOf({ kind: "lot" }),
  };
}

export function marketDriftHandler(actx: ActionContext): ActionHandler {
  return async (rawInput, ctx) => {
    const input = rawInput as { run_key?: string };
    if (typeof input.run_key !== "string") throw new Error("mm.drift: run_key is required");
    return ctx.perform({
      effectId: "drift",
      capability: CAP.ledgerReadPositions,
      run: async () => {
        const report = computeDrift(driftInputs(actx, input.run_key as string));
        // The workflow's material gate routes on this BEFORE the model is
        // ever asked: no candidates means there is deterministically
        // nothing to propose -- the model call would only be rule 4's
        // scripted NOTHING.
        return { ...report, has_candidates: report.candidates.length > 0 };
      },
    });
  };
}

// --- intake: the reply bridge -> a recorded Recommendation --------------

export interface IntakeInput {
  run_key: string;
  attempt?: number;
  reply: string;
}

export const recommendationId = (runKey: string, attempt: number): string => `rec_${runKey}.${String(attempt)}`;
export const approvalSignalId = (recommendationId_: string): string => `approve:${recommendationId_}`;

export function auditIntakeHandler(actx: ActionContext): ActionHandler {
  return async (rawInput, ctx) => {
    const input = rawInput as IntakeInput;
    if (typeof input.run_key !== "string" || typeof input.reply !== "string") {
      throw new Error("audit.intake: run_key and reply are required");
    }
    const attempt = input.attempt ?? 1;
    // The DESIGNED decline (prompt rule 4): nothing to record, nothing to
    // audit -- but the Market Manager's one-sentence reason is the only
    // account the operator will ever get of why, so it is journaled here
    // (idempotently, under the intake effect) before the workflow's
    // settle step routes the run to its declined ending (issue #45).
    const reason = declinedReason(input.reply);
    if (reason !== null) {
      return ctx.perform({
        effectId: `intake:${String(attempt)}`,
        capability: CAP.recordRecommendation,
        run: async () => {
          actx.ledger.appendJournal({
            at: actx.clock().toISOString(),
            kind: "system",
            summary: `market manager declined to propose (attempt ${String(attempt)})${reason === "" ? " -- no reason given" : `: ${reason}`}`,
            detail: { run_key: input.run_key, attempt, reason },
            refs: [],
            author: "auditor",
          });
          return { run_key: input.run_key, attempt, declined: true, reason };
        },
      });
    }
    return ctx.perform({
      effectId: `intake:${String(attempt)}`,
      capability: CAP.recordRecommendation,
      run: async () => {
        const draft = parseDraft(input.reply);
        // "No evidence, no proposal" -- and every id must resolve.
        for (const id of draft.evidence) {
          if (actx.ledger.getFact(id) === null) {
            throw new Error(`audit.intake: draft cites ${id}, which is not a ledger fact`);
          }
        }
        const now = actx.clock().toISOString();
        if (draft.expires <= now) throw new Error(`audit.intake: draft already expired (${draft.expires})`);
        const rec: Recommendation = {
          id: recommendationId(input.run_key, attempt),
          from: "market_manager",
          subject: draft.subject,
          action: {
            verb: draft.action.verb,
            instrument: draft.action.instrument,
            quantity: draft.action.quantity,
            amount: draft.action.amount,
            detail: draft.action.detail,
          },
          thesis: draft.thesis,
          evidence: draft.evidence,
          as_of: draft.as_of,
          ...(draft.tax_lots !== undefined ? { tax_lots: draft.tax_lots } : {}),
          confidence: draft.confidence,
          requires: draft.requires,
          expires: draft.expires,
          provenance: { source_id: "market.manager", source_doc_id: null, observed_at: now, via: "mm@1" },
        };
        const r = appendRecommendation(actx.ledger, rec);
        actx.ledger.emitEvent({
          id: `${input.run_key}:rec:${String(attempt)}`,
          kind: "proposal.drafted",
          subject: rec.subject,
          payload: { recommendation_id: rec.id, attempt, run_key: input.run_key },
        });
        return { run_key: input.run_key, attempt, declined: false, recommendation_id: rec.id, candidate_index: draft.candidate_index, replayed: r.replayed };
      },
    });
  };
}

/**
 * Some local models (gpt-oss via mlx_lm.server) leak "harmony" channel
 * scaffolding into the text -- keep the final channel's content and strip
 * the control tokens, the same healing the chat path applies.
 */
function healModelReply(reply: string): string {
  let text = reply;
  const final = /<\|channel\|>final<\|message\|>/.exec(text);
  if (final !== null) text = text.slice(final.index + final[0].length);
  text = text.replace(/<\|channel\|>analysis<\|message\|>[\s\S]*?(<\|end\|>|$)/g, "").replace(/<\|[a-z_]+\|>/g, "");
  return text.trim() === "" ? reply : text;
}

/**
 * Prompt rule 4's designed decline: `NOTHING`, optionally followed by
 * one sentence saying why (`NOTHING: the only candidate sells ...`).
 * Returns the reason ("" when the bare word was given) or null when the
 * reply is not a decline. A reply that goes on to carry a JSON object is
 * a draft with a preamble, never a decline.
 */
export function declinedReason(reply: string): string | null {
  const m = /^NOTHING\b[\s:.,;!\u2013\u2014-]*([\s\S]*)$/i.exec(healModelReply(reply).trim());
  if (m === null) return null;
  const rest = (m[1] ?? "").replace(/\s+/g, " ").trim();
  if (/[{}]/.test(rest)) return null;
  return rest;
}

/** True when the reply is rule 4's decline, with or without a reason. */
export function isDeclinedReply(reply: string): boolean {
  return declinedReason(reply) !== null;
}

/** Tolerate prose/code fences around the JSON: heal harmony scaffolding, then parse the outermost object. */
export function parseDraft(reply: string): ProposalDraft {
  const text = healModelReply(reply);
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error("audit.intake: the drafting model's reply carries no JSON object to parse -- a small local model may not manage the draft format; assign a stronger provider to Strategy on the Credentials page");
  }
  const raw: unknown = JSON.parse(text.slice(start, end + 1));
  return assertType(ProposalDraft, raw, "proposal draft");
}

// --- review: the four slide-16 blocks -----------------------------------

export interface ReviewInput {
  run_key: string;
  attempt?: number;
  /** From a declined intake (the Market Manager answered NOTHING): no recommendation exists. */
  declined?: boolean;
  /** The Market Manager's one-sentence reason for declining ("" when it gave none). */
  reason?: string;
  recommendation_id?: string;
}

export function auditReviewHandler(actx: ActionContext): ActionHandler {
  return async (rawInput, ctx) => {
    const input = rawInput as ReviewInput;
    if (typeof input.run_key !== "string") throw new Error("audit.review: run_key is required");
    // A declined intake carries no recommendation: nothing to audit, and
    // NOT cleared -- clearing would send the run to an approval gate with
    // nothing to approve. The loop's `while` stops on `declined` (the
    // same report would only draw the same answer), and the settle step
    // routes the run to its declined ending (issue #45).
    if (input.declined === true) {
      const reason = typeof input.reason === "string" ? input.reason : "";
      return {
        run_key: input.run_key,
        attempt: input.attempt ?? 1,
        declined: true,
        reason,
        cleared: false,
        blocks: [reason === "" ? "market manager declined (NOTHING)" : `market manager declined: ${reason}`],
      };
    }
    const recommendationId_ = input.recommendation_id;
    if (typeof recommendationId_ !== "string") {
      throw new Error("audit.review: run_key and recommendation_id are required");
    }
    const attempt = input.attempt ?? 1;
    return ctx.perform({
      effectId: `review:${String(attempt)}`,
      capability: CAP.recordVerdict,
      run: async () => {
        const rec = getRecommendation(actx.ledger, recommendationId_);
        if (rec === null) throw new Error(`audit.review: no recommendation ${recommendationId_}`);
        const verdict = auditRecommendation(actx, rec, input.run_key, attempt);
        appendAuditVerdict(actx.ledger, verdict);
        actx.ledger.appendJournal({
          at: verdict.as_of,
          kind: "system",
          subject: rec.subject,
          summary: verdict.cleared
            ? `auditor cleared ${rec.id}: ${rec.action.verb} ${rec.action.quantity ?? ""} ${rec.action.instrument ?? ""} (attempt ${String(attempt)})`
            : `auditor blocked ${rec.id} (attempt ${String(attempt)}): ${verdict.blocks.map((b) => b.condition).join(", ")}`,
          detail: { blocks: verdict.blocks, figures: verdict.figures },
          refs: [],
          author: "auditor",
        });
        actx.ledger.emitEvent({
          id: `${input.run_key}:verdict:${String(attempt)}`,
          kind: verdict.cleared ? "proposal.cleared" : "proposal.blocked",
          subject: rec.subject,
          payload: { recommendation_id: rec.id, attempt, blocks: verdict.blocks, run_key: input.run_key },
        });
        return { run_key: input.run_key, attempt, declined: false, recommendation_id: rec.id, cleared: verdict.cleared, blocks: verdict.blocks };
      },
    });
  };
}

/** Pure given the ledger + clock: the deterministic re-run and the four checks. Exported for direct tests. */
export function auditRecommendation(actx: ActionContext, rec: Recommendation, runKey: string, attempt: number): AuditVerdict {
  const now = actx.clock();
  const blocks: AuditBlock[] = [];
  const figures: Record<string, unknown> = {};
  const plan = planOf(actx);

  // 1. "A figure it cannot reproduce from ledger facts": re-run the drift
  // and demand the recommendation match a canonical candidate exactly.
  const drift = computeDrift(driftInputs(actx, runKey));
  figures["drift"] = { portfolio_value: drift.portfolio_value, cash_value: drift.cash_value, candidates: drift.candidates.length };
  const match = drift.candidates.find(
    (c) =>
      c.side === rec.action.verb &&
      c.symbol === (rec.action.instrument ?? "") &&
      c.account === rec.subject &&
      c.quantity === (rec.action.quantity ?? "") &&
      c.est_value === (rec.action.amount?.amount ?? ""),
  );
  if (match === undefined) {
    blocks.push({
      condition: "unreproducible",
      detail: `no canonical candidate matches ${rec.action.verb} ${rec.action.quantity ?? "?"} ${rec.action.instrument ?? "?"} @ ${rec.action.amount?.amount ?? "?"} in ${rec.subject}; the auditor's own drift run produced ${String(drift.candidates.length)} candidate(s)`,
    });
  } else {
    figures["candidate"] = match;
  }
  for (const id of rec.evidence) {
    if (actx.ledger.getFact(id) === null) {
      blocks.push({ condition: "unreproducible", detail: `evidence ${id} does not resolve to a ledger fact` });
      break;
    }
  }

  const txns: DatedTransaction[] = actx.ledger
    .asOf({ kind: "transaction" })
    .map((f) => ({ factId: f.id, subject: f.subject, payload: f.payload as TransactionPayload }));
  const lots: DatedLot[] = actx.ledger.asOf({ kind: "lot" }).map((f) => ({ factId: f.id, subject: f.subject, payload: f.payload as LotPayload }));
  const symbol = rec.action.instrument ?? "";
  const year = now.getUTCFullYear();

  // 2. Wash-sale collision, or a lot choice that quietly costs you.
  const yearGains = realizedGains(txns, lots, year, `${String(year)}-12-31`);
  if (rec.action.verb === "BUY") {
    const recentLossSale = yearGains.sales.find(
      (s) =>
        s.subject === rec.subject &&
        s.symbol.toUpperCase() === symbol.toUpperCase() &&
        !s.basisIncomplete &&
        decimal.cmp(decimal.add(s.stGain ?? "0", s.ltGain ?? "0"), "0") < 0 &&
        withinDays(s.saleDate, now, 30),
    );
    if (recentLossSale !== undefined) {
      blocks.push({
        condition: "wash_sale",
        detail: `buying ${symbol} within 30 days of the ${recentLossSale.saleDate} loss sale (${recentLossSale.txnId}) would disallow the loss`,
      });
    }
  }
  if (rec.action.verb === "SELL") {
    const washes = washSales(txns, yearGains.sales);
    if (washes.some((w) => w.symbol.toUpperCase() === symbol.toUpperCase() && w.account_id === rec.subject)) {
      blocks.push({ condition: "wash_sale", detail: `${symbol} already carries an open wash-sale window in ${rec.subject}` });
    }
    const stLots = (rec.tax_lots ?? []).filter((l) => l.treatment === "STCG" || l.treatment === "unknown");
    if (stLots.length > 0) {
      blocks.push({
        condition: "wash_sale",
        detail: `the lot choice consumes ${String(stLots.length)} short-term/unknown lot(s) (${stLots.map((l) => l.lot_id).join(", ")}) -- a quiet cost; restructure or acknowledge explicitly`,
      });
    }
  }

  // 3. Conflict with a standing constraint or the written plan.
  if (rec.action.verb === "SELL" && (plan.constraints.do_not_sell ?? []).some((s2) => s2.toUpperCase() === symbol.toUpperCase())) {
    blocks.push({ condition: "plan_conflict", detail: `${symbol} is on the plan's do-not-sell list` });
  }
  const orderValue = rec.action.amount?.amount ?? null;
  if (orderValue !== null && plan.constraints.max_order_value != null && decimal.cmp(orderValue, plan.constraints.max_order_value) > 0) {
    blocks.push({ condition: "plan_conflict", detail: `order value ${orderValue} exceeds the plan's max_order_value ${plan.constraints.max_order_value}` });
  }
  if (rec.action.verb === "BUY" && orderValue !== null && plan.constraints.max_position_weight != null) {
    const held = drift.by_class.reduce((acc, l) => decimal.add(acc, l.value), "0");
    const positions = actx.ledger.asOf({ kind: "position" });
    const mine = positions.find((f) => f.subject === rec.subject && (f.payload as { instrument?: { symbol?: string } }).instrument?.symbol === symbol);
    const mineValue = mine === null || mine === undefined ? "0" : ((mine.payload as { market_value?: string | null }).market_value ?? "0");
    const after = decimal.add(mineValue, orderValue);
    const weightAfter = decimal.isZero(held) ? "0" : decimal.div(after, decimal.add(held, orderValue));
    if (decimal.cmp(weightAfter, plan.constraints.max_position_weight) > 0) {
      blocks.push({
        condition: "plan_conflict",
        detail: `after the buy, ${symbol} would be ${decimal.round(decimal.mul(weightAfter, "100"), 1)}% of the portfolio (max ${decimal.round(decimal.mul(plan.constraints.max_position_weight, "100"), 1)}%)`,
      });
    }
  }

  // 4. Cash needed for a tax payment inside the horizon.
  if (rec.action.verb === "BUY" && orderValue !== null) {
    const horizonDays = plan.constraints.tax_cash_horizon_days ?? DEFAULT_TAX_CASH_HORIZON_DAYS;
    const horizon = new Date(now.getTime() + horizonDays * 86_400_000).toISOString().slice(0, 10);
    const today = now.toISOString().slice(0, 10);
    const due: string[] = [];
    let dueTotal = "0";
    for (const f of actx.ledger.asOf({ kind: "obligation" })) {
      const p = f.payload as ObligationPayload;
      if (p.kind !== "tax_estimate" || p.payment_due == null || p.payment_amount == null) continue;
      if (p.payment_due < today || p.payment_due > horizon) continue;
      due.push(`${p.payment_amount} due ${p.payment_due}`);
      dueTotal = decimal.add(dueTotal, p.payment_amount);
    }
    if (decimal.cmp(dueTotal, "0") > 0) {
      const cashAfter = decimal.sub(drift.cash_value, orderValue);
      figures["tax_cash"] = { due: due.join("; "), cash_before: drift.cash_value, cash_after: cashAfter };
      if (decimal.cmp(cashAfter, dueTotal) < 0) {
        blocks.push({
          condition: "tax_cash",
          detail: `the buy leaves ${cashAfter} of cash against ${dueTotal} of tax estimates due within ${String(horizonDays)} days (${due.join("; ")})`,
        });
      }
    }
  }

  return {
    recommendation_id: rec.id,
    attempt,
    cleared: blocks.length === 0,
    blocks,
    as_of: now.toISOString(),
    figures,
  };
}

function withinDays(dateIso: string, now: Date, days: number): boolean {
  const t = Date.parse(`${dateIso}T00:00:00.000Z`);
  return Math.abs(now.getTime() - t) <= days * 86_400_000;
}

// --- decision -> approval; approval -> prepared instruction --------------

export interface DecisionInput {
  run_key: string;
  recommendation_id?: string;
  decision?: "approve" | "reject";
  signed_by?: string;
  note?: string;
  bound?: { max_quantity?: string | null; max_amount?: { amount: string; currency: string } | null; limit_price?: string | null };
  /** Approval window from signing, ms. Default 72h. */
  window_ms?: number;
}

export function governDecisionHandler(actx: ActionContext): ActionHandler {
  return async (rawInput, ctx) => {
    const input = rawInput as DecisionInput;
    if (typeof input.run_key !== "string" || typeof input.recommendation_id !== "string") {
      throw new Error("govern.decision: run_key and recommendation_id are required");
    }
    const recId = input.recommendation_id;
    return ctx.perform({
      effectId: "decision",
      capability: CAP.recordApproval,
      run: async () => {
        const rec = getRecommendation(actx.ledger, recId);
        if (rec === null) throw new Error(`govern.decision: no recommendation ${recId}`);
        const latest = verdictsFor(actx.ledger, recId).at(-1);
        if (latest === undefined || !latest.cleared) throw new Error(`govern.decision: ${recId} was never cleared by the auditor`);
        const now = actx.clock().toISOString();
        const who = input.signed_by ?? "operator";
        if (input.decision !== "approve") {
          actx.ledger.appendJournal({
            at: now,
            kind: "decision",
            subject: rec.subject,
            summary: `rejected ${recId}: ${rec.action.verb} ${rec.action.quantity ?? ""} ${rec.action.instrument ?? ""}${input.note ? ` -- ${input.note}` : ""}`,
            detail: { recommendation_id: recId, note: input.note ?? null },
            refs: [recId],
            author: who,
          });
          actx.ledger.emitEvent({
            id: `${input.run_key}:decided`,
            kind: "proposal.rejected",
            subject: rec.subject,
            payload: { recommendation_id: recId, by: who, note: input.note ?? null, run_key: input.run_key },
          });
          return { approved: false, run_key: input.run_key, recommendation_id: recId };
        }
        const expires = new Date(Date.parse(now) + (input.window_ms ?? 72 * 3600_000)).toISOString();
        const approval: Approval = {
          id: `ap_${recId.slice(4)}`,
          recommendation_id: recId,
          subject: rec.subject,
          action: rec.action,
          bound: {
            max_quantity: input.bound?.max_quantity ?? rec.action.quantity ?? null,
            max_amount: input.bound?.max_amount ?? rec.action.amount ?? null,
            limit_price: input.bound?.limit_price ?? null,
          },
          expires,
          signed_by: who,
          signed_at: now,
          signal_id: approvalSignalId(recId),
          as_of: now,
          provenance: { source_id: "operator.approval", source_doc_id: null, observed_at: now, via: "approve@1" },
        };
        const r = appendApproval(actx.ledger, approval);
        actx.ledger.appendJournal({
          at: now,
          kind: "approval",
          subject: rec.subject,
          summary: `approved ${recId}: ${rec.action.verb} up to ${approval.bound.max_quantity ?? "?"} ${rec.action.instrument ?? ""}${approval.bound.limit_price != null ? ` limit ${approval.bound.limit_price}` : ""}, expires ${expires}${input.note ? ` -- ${input.note}` : ""}`,
          detail: { approval_id: approval.id, bound: approval.bound, thesis: rec.thesis },
          refs: [recId],
          author: who,
        });
        actx.ledger.emitEvent({
          id: `${input.run_key}:decided`,
          kind: "proposal.approved",
          subject: rec.subject,
          payload: { recommendation_id: recId, approval_id: approval.id, by: who, run_key: input.run_key },
        });
        return { approved: true, run_key: input.run_key, recommendation_id: recId, approval_id: approval.id, replayed: r.replayed };
      },
    });
  };
}

export function executionPrepareHandler(actx: ActionContext): ActionHandler {
  return async (rawInput, ctx) => {
    const input = rawInput as { run_key?: string; recommendation_id?: string; approval_id?: string };
    if (typeof input.run_key !== "string" || typeof input.recommendation_id !== "string") {
      throw new Error("execution.prepare: run_key and recommendation_id are required");
    }
    return ctx.perform({
      effectId: "prepare",
      capability: CAP.recordInstruction,
      run: async () => {
        const rec = getRecommendation(actx.ledger, input.recommendation_id as string);
        const approval = approvalFor(actx.ledger, input.recommendation_id as string);
        if (rec === null || approval === null) throw new Error("execution.prepare: approval chain incomplete");
        const now = actx.clock().toISOString();
        const instruction: Instruction = {
          id: `ins_${approval.id.slice(3)}`,
          approval_id: approval.id,
          recommendation_id: rec.id,
          subject: rec.subject,
          action: rec.action,
          bound: approval.bound,
          issued_at: now,
          expires: approval.expires,
          // Phase 4 ships with execution disabled: prepared, NEVER sent.
          status: "prepared",
          as_of: now,
          provenance: { source_id: "execution.prepare", source_doc_id: null, observed_at: now, via: "prepare@1" },
        };
        const r = appendInstruction(actx.ledger, instruction);
        actx.ledger.appendJournal({
          at: now,
          kind: "system",
          subject: rec.subject,
          summary: `instruction ${instruction.id} PREPARED (not sent -- execution is disabled): ${rec.action.verb} up to ${approval.bound.max_quantity ?? "?"} ${rec.action.instrument ?? ""}; place it yourself and reconcile the fill`,
          detail: { instruction_id: instruction.id, bound: approval.bound },
          refs: [rec.id],
          author: "execution",
        });
        actx.ledger.emitEvent({
          id: `${input.run_key}:prepared`,
          kind: "instruction.prepared",
          subject: rec.subject,
          payload: { instruction_id: instruction.id, recommendation_id: rec.id, run_key: input.run_key },
        });
        return { instruction_id: instruction.id, status: "prepared", replayed: r.replayed };
      },
    });
  };
}

/** Terminal branches: journal + one idempotent event each. */
function terminalHandler(actx: ActionContext, kind: "proposal.expired" | "proposal.rejected.closed" | "proposal.exhausted" | "proposal.declined", summary: (runKey: string) => string): ActionHandler {
  return async (rawInput, ctx) => {
    const input = rawInput as { run_key?: string; recommendation_id?: string };
    if (typeof input.run_key !== "string") throw new Error(`${kind}: run_key is required`);
    return ctx.perform({
      effectId: kind,
      capability: CAP.ledgerEmit,
      run: async () => {
        const now = actx.clock().toISOString();
        const evt = actx.ledger.emitEvent({
          id: `${input.run_key}:${kind}`,
          kind: kind === "proposal.rejected.closed" ? "proposal.closed" : kind,
          payload: { run_key: input.run_key, recommendation_id: input.recommendation_id ?? null },
        });
        actx.ledger.appendJournal({
          at: now,
          kind: "system",
          summary: summary(input.run_key as string),
          detail: { recommendation_id: input.recommendation_id ?? null },
          refs: [],
          author: "scheduler",
        });
        return { event: evt };
      },
    });
  };
}

export function governExpiredHandler(actx: ActionContext): ActionHandler {
  return async (rawInput, ctx) => {
    const input = rawInput as { run_key?: string };
    if (typeof input.run_key !== "string") throw new Error("govern.expired: run_key is required");
    const runKey = input.run_key;
    return ctx.perform({
      effectId: "proposal.expired",
      capability: CAP.ledgerEmit,
      run: async () => {
        const now = actx.clock().toISOString();
        // Every draft this run recorded is dead with it -- the queue
        // excludes them immediately, not only once their window lapses.
        const recIds = listRecommendations(actx.ledger, 1000)
          .map((r) => r.id)
          .filter((id) => id.startsWith(`rec_${runKey}.`));
        const evt = actx.ledger.emitEvent({
          id: `${runKey}:proposal.expired`,
          kind: "proposal.expired",
          payload: { run_key: runKey, recommendation_ids: recIds },
        });
        actx.ledger.appendJournal({
          at: now,
          kind: "system",
          summary: `proposal ${runKey}: approval window elapsed with no decision -- expired, never auto-approved`,
          detail: { recommendation_ids: recIds },
          refs: recIds,
          author: "scheduler",
        });
        return { event: evt, recommendation_ids: recIds };
      },
    });
  };
}
export function governRejectedHandler(actx: ActionContext): ActionHandler {
  return terminalHandler(actx, "proposal.rejected.closed", (rk) => `proposal ${rk}: closed after rejection`);
}
export function governExhaustedHandler(actx: ActionContext): ActionHandler {
  return terminalHandler(actx, "proposal.exhausted", (rk) => `proposal ${rk}: every redraft was blocked by the auditor; nothing reached the queue`);
}

/** No candidates in the drift report: a clean no-proposal ending, journaled, the model never asked. */
export function governNothingHandler(actx: ActionContext): ActionHandler {
  return terminalHandler(actx, "proposal.declined", (rk) => `proposal ${rk}: the drift report had no candidates, so there was nothing to propose (declined to propose without asking the market manager)`);
}

/** The Market Manager's designed decline (prompt rule 4, reply NOTHING): a clean no-proposal ending after ONE attempt; the reason sits in the intake's journal entry. */
export function governDeclinedHandler(actx: ActionContext): ActionHandler {
  return terminalHandler(actx, "proposal.declined", (rk) => `proposal ${rk}: the Market Manager reviewed the candidates and declined to propose; its reason is journaled with the attempt`);
}

/**
 * After the rework loop: did any attempt clear? A pure ledger read the
 * verdict gate routes on -- the pinned runtime's loop output carries
 * only outcome/iterations/carry (the LAST iteration's input, never its
 * verdict), so "cleared" vs "declined" must be re-derived from what the
 * intake and review steps recorded (issue #45).
 */
export function governSettleHandler(actx: ActionContext): ActionHandler {
  return async (rawInput) => {
    const input = rawInput as { run_key?: string };
    if (typeof input.run_key !== "string") throw new Error("govern.settle: run_key is required");
    const runKey = input.run_key;
    const cleared = listRecommendations(actx.ledger, 1000)
      .filter((r) => r.id.startsWith(`rec_${runKey}.`))
      .filter((r) => verdictsFor(actx.ledger, r.id).some((v) => v.cleared));
    return { run_key: runKey, queued: cleared.length > 0, recommendation_id: cleared[0]?.id ?? null };
  };
}
