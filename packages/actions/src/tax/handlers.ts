// The Tax Engine as `action` handlers (BUILD_PLAN §6 Phase 2). One
// (quarter, stage) check is a chain of four steps, each under its owning
// principal:
//
//   tax.estimate  (tax_engine)   read the ledger, compute the running
//                                estimate, gains, wash sales, safe-harbour
//                                and reserve coverage; draft findings
//   tax.record    (tax_engine)   append the findings (fingerprint-deduped)
//                                and emit the `tax.estimate` outbox event
//   tax.obligate  (liabilities)  append/supersede the `tax_estimate`
//                                obligation fact -- the one writer of
//                                obligations
//   tax.confirm   (scheduler)    the coverage gate's clean branch: journal
//                                "funded from reserve", emit `tax.ready`
//   tax.skip      (scheduler)    the deadline gate's signal branch: the
//                                operator handled the deadline elsewhere
//
// The estimate REFUSES to compute over provisional data: any contributing
// subject still held provisional makes the output `blocked`, the coverage
// gate then routes to escalation, and no obligation is written (deck
// slide 15 -- the refusal is a branch, not a flag).

import {
  assertType,
  decimal,
  describe,
  figure,
  QuarterEstimate,
  TaxProfile,
  type FindingCode,
  type FindingDraft,
  type FindingInput,
  type FindingKind,
  type LotPayload,
  type Severity,
  type SummaryPart,
  type TransactionPayload,
} from "@fin/contracts";

import { CAP, type ActionContext, type ActionHandler } from "../context";
import { suppressKnown } from "../reconcile/reconcile";
import {
  annualizedTax,
  ordinaryIncome,
  paymentsCumulative,
  quarterSpec,
  realizedGains,
  requiredCumulative,
  safeHarborCap,
  washSales,
  type DatedLot,
  type DatedTransaction,
} from "./math";

export interface TaxCheckInput {
  run_key: string;
  tax_year: number;
  quarter: 1 | 2 | 3 | 4;
  stage: "pre" | "due";
}

export type TaxEstimateOutput = QuarterEstimate & { findings: FindingDraft[] };

const TAX_VIA = "tax@1";
/** The tax engine computes in the filing currency; the profile's rates and thresholds are dollar figures. */
const TAX_CURRENCY = "USD";

function checkInput(rawInput: unknown, what: string): TaxCheckInput {
  const input = rawInput as Partial<TaxCheckInput>;
  if (
    typeof input.run_key !== "string" ||
    typeof input.tax_year !== "number" ||
    typeof input.quarter !== "number" ||
    (input.stage !== "pre" && input.stage !== "due")
  ) {
    throw new Error(`${what}: run_key, tax_year, quarter and stage are required`);
  }
  return input as TaxCheckInput;
}

function profileFor(actx: ActionContext, taxYear: number): TaxProfile {
  const raw = actx.taxProfile?.() ?? null;
  if (raw === null) {
    throw new Error(`tax: no tax profile configured; a fired deadline for ${String(taxYear)} cannot be estimated`);
  }
  const profile = assertType(TaxProfile, raw, "tax profile");
  if (profile.tax_year !== taxYear) {
    throw new Error(`tax: profile is for ${String(profile.tax_year)} but the check is for ${String(taxYear)}`);
  }
  return profile;
}

interface DraftSpec {
  kind: FindingKind;
  code: FindingCode;
  severity: Severity;
  subject: string;
  summary: string;
  summary_parts?: SummaryPart[];
  detail: Record<string, unknown>;
  evidence: string[];
  requires_human: boolean;
  /** Detail keys identifying the condition (fingerprint input). */
  identity: string[];
}

function draft(asOf: string, f: DraftSpec): FindingDraft {
  const idKeys = [...f.identity].sort();
  const fingerprint = `${f.code}|${f.subject}|${JSON.stringify(idKeys.map((k) => [k, f.detail[k] ?? null]))}`;
  return {
    kind: f.kind,
    code: f.code,
    severity: f.severity,
    subject: f.subject,
    summary: f.summary,
    ...(f.summary_parts !== undefined ? { summary_parts: f.summary_parts } : {}),
    detail: { ...f.detail, fingerprint },
    fingerprint,
    evidence: f.evidence,
    before: [],
    after_refs: [],
    requires_human: f.requires_human,
    emitted_by: "tax_engine",
    as_of: asOf,
    provenance: { source_id: "tax.engine", source_doc_id: null, observed_at: asOf, via: TAX_VIA },
    holds: false,
  };
}

export function taxEstimateHandler(actx: ActionContext): ActionHandler {
  return async (rawInput, ctx) => {
    const input = checkInput(rawInput, "tax.estimate");
    const profile = profileFor(actx, input.tax_year);
    return ctx.perform({
      effectId: `estimate:q${String(input.quarter)}:${input.stage}`,
      capability: CAP.ledgerRead,
      run: async () => estimateQuarter(actx, profile, input),
    });
  };
}

export function estimateQuarter(actx: ActionContext, profile: TaxProfile, input: TaxCheckInput): TaxEstimateOutput {
  const { ledger } = actx;
  const asOf = actx.clock().toISOString();
  const spec = quarterSpec(input.tax_year, input.quarter);
  const yearSubject = `household.tax.${String(input.tax_year)}`;

  const txns: DatedTransaction[] = ledger
    .asOf({ kind: "transaction" })
    .map((f) => ({ factId: f.id, subject: f.subject, payload: f.payload as TransactionPayload }));
  const lots: DatedLot[] = ledger
    .asOf({ kind: "lot" })
    .map((f) => ({ factId: f.id, subject: f.subject, payload: f.payload as LotPayload }));

  // The refusal check (deck slide 15): any contributing subject still
  // provisional blocks the estimate. Contributing = every account whose
  // transactions or lots the figures would read, plus the reserve account.
  const contributing = new Set<string>([...txns.map((t) => t.subject), ...lots.map((l) => l.subject), profile.reserve_account]);
  const blocked = [...contributing].filter((s) => ledger.isProvisional(s)).sort();

  const base = {
    run_key: input.run_key,
    tax_year: input.tax_year,
    quarter: input.quarter,
    stage: input.stage,
    as_of: asOf,
    period_end: spec.periodEnd,
    due: spec.due,
  };

  if (blocked.length > 0) {
    const findings = [
      draft(asOf, {
        kind: "break",
        code: "tax_estimate_blocked",
        severity: "high",
        subject: yearSubject,
        summary: `tax ${String(input.tax_year)} Q${String(input.quarter)} ${input.stage}: estimate refused -- ${blocked.join(", ")} still provisional; clear the exception queue and re-run the check`,
        detail: { tax_year: input.tax_year, quarter: input.quarter, stage: input.stage, blocked },
        evidence: [],
        requires_human: true,
        identity: ["tax_year", "quarter", "stage"],
      }),
    ];
    return {
      ...base,
      blocked,
      figures: null,
      reserve: null,
      reserve_ok: false,
      obligation: null,
      wash_sales: [],
      evidence: [],
      findings,
    };
  }

  const income = ordinaryIncome(txns, input.tax_year, spec.periodEnd);
  const gains = realizedGains(txns, lots, input.tax_year, spec.periodEnd);
  const annualized = annualizedTax(profile, income.total, gains.stTotal, gains.ltTotal, spec.factor);
  const cap = safeHarborCap(profile);
  const requiredCum = requiredCumulative(spec, annualized, cap);
  const payments = paymentsCumulative(profile, txns, spec, input.tax_year);
  const installment = decimal.cmp(requiredCum, payments.total) > 0 ? decimal.round(decimal.sub(requiredCum, payments.total), 2) : "0";

  const reserveFact = ledger.asOf({ kind: "balance", subject: profile.reserve_account, key: "total" })[0] ?? null;
  const reserveBalance = reserveFact === null ? null : (reserveFact.payload as { amount: string }).amount;
  const covered = decimal.cmp(installment, "0") === 0 || (reserveBalance !== null && decimal.cmp(reserveBalance, installment) >= 0);
  const shortfall = covered || reserveBalance === null ? (covered ? "0" : installment) : decimal.round(decimal.sub(installment, reserveBalance), 2);

  const evidence = [...new Set([...income.factIds, ...gains.factIds, ...payments.factIds, ...(reserveFact === null ? [] : [reserveFact.id])])];
  const washes = washSales(txns.filter((t) => t.payload.posted_at.startsWith(String(input.tax_year))), gains.sales);

  const findings: FindingDraft[] = [];
  if (input.stage === "due" && decimal.cmp(installment, "0") > 0) {
    findings.push(
      draft(asOf, {
        kind: "tax_event",
        code: "estimated_tax_due",
        severity: "high",
        subject: yearSubject,
        ...describe(
          `tax ${String(input.tax_year)} Q${String(input.quarter)}: estimated payment of `,
          figure(installment, TAX_CURRENCY),
          ` is due ${spec.due}${covered ? ` -- funded from reserve ${profile.reserve_account}` : ""}`,
        ),
        detail: { tax_year: input.tax_year, quarter: input.quarter, amount: installment, due: spec.due, reserve_account: profile.reserve_account, covered },
        evidence,
        requires_human: true,
        identity: ["tax_year", "quarter"],
      }),
    );
  }
  if (!covered) {
    findings.push(
      draft(asOf, {
        kind: "risk",
        code: "reserve_shortfall",
        severity: input.stage === "due" ? "critical" : "high",
        subject: profile.reserve_account,
        ...describe(
          `tax ${String(input.tax_year)} Q${String(input.quarter)} ${input.stage}: reserve ${profile.reserve_account} holds `,
          reserveBalance === null ? "nothing on record" : figure(reserveBalance, TAX_CURRENCY),
          " against a ",
          figure(installment, TAX_CURRENCY),
          ` installment due ${spec.due} -- fund `,
          figure(shortfall, TAX_CURRENCY),
          " from cash flow before the deadline to avoid a forced sale",
        ),
        detail: { tax_year: input.tax_year, quarter: input.quarter, stage: input.stage, installment, reserve_balance: reserveBalance, shortfall },
        evidence,
        requires_human: true,
        identity: ["tax_year", "quarter", "stage"],
      }),
    );
  }
  // Past installments that were underpaid when their deadline passed.
  const today = asOf.slice(0, 10);
  for (let q = 1; q < input.quarter; q += 1) {
    const past = quarterSpec(input.tax_year, q as 1 | 2 | 3 | 4);
    if (past.due >= today) continue;
    const pastIncome = ordinaryIncome(txns, input.tax_year, past.periodEnd);
    const pastGains = realizedGains(txns, lots, input.tax_year, past.periodEnd);
    const pastRequired = requiredCumulative(past, annualizedTax(profile, pastIncome.total, pastGains.stTotal, pastGains.ltTotal, past.factor), cap);
    const pastPaid = paymentsCumulative(profile, txns, past, input.tax_year);
    if (decimal.cmp(pastPaid.total, pastRequired) >= 0) continue;
    const short = decimal.round(decimal.sub(pastRequired, pastPaid.total), 2);
    findings.push(
      draft(asOf, {
        kind: "risk",
        code: "safe_harbor_shortfall",
        severity: "medium",
        subject: yearSubject,
        ...describe(
          `tax ${String(input.tax_year)} Q${String(q)}: payments through ${past.due} were `,
          figure(pastPaid.total, TAX_CURRENCY),
          " against a required ",
          figure(pastRequired, TAX_CURRENCY),
          " (short ",
          figure(short, TAX_CURRENCY),
          "); an underpayment penalty may accrue -- catch up with the next installment",
        ),
        detail: { tax_year: input.tax_year, quarter: q, required_cum: pastRequired, payments_cum: pastPaid.total, short },
        evidence: [...new Set([...pastIncome.factIds, ...pastPaid.factIds])],
        requires_human: true,
        identity: ["tax_year", "quarter"],
      }),
    );
  }
  for (const w of washes) {
    findings.push(
      draft(asOf, {
        kind: "tax_event",
        code: "wash_sale_risk",
        severity: "medium",
        subject: w.account_id,
        ...describe(
          `${w.symbol}: loss sale ${w.sale_txn_id} (`,
          figure(w.loss, TAX_CURRENCY),
          `) on ${w.sale_date} with a repurchase on ${w.repurchase_date} -- inside the 30-day wash-sale window; ~`,
          figure(w.disallowed_estimate, TAX_CURRENCY),
          " of the loss may be disallowed",
        ),
        detail: { symbol: w.symbol, sale_txn_id: w.sale_txn_id, sale_date: w.sale_date, repurchase_txn_id: w.repurchase_txn_id, repurchase_date: w.repurchase_date, loss: w.loss, disallowed_estimate: w.disallowed_estimate },
        evidence,
        requires_human: false,
        identity: ["sale_txn_id", "symbol"],
      }),
    );
  }

  return {
    ...base,
    blocked: [],
    figures: {
      ordinary_income: decimal.round(income.total, 2),
      st_gains: decimal.round(gains.stTotal, 2),
      lt_gains: decimal.round(gains.ltTotal, 2),
      basis_incomplete: gains.basisIncomplete,
      annualization_factor: spec.factor,
      annualized_tax: annualized,
      safe_harbor_cap: cap,
      required_cum: requiredCum,
      payments_cum: payments.total,
      installment_due: installment,
    },
    reserve: {
      account: profile.reserve_account,
      balance: reserveBalance,
      balance_fact: reserveFact?.id ?? null,
      required: installment,
      shortfall,
    },
    reserve_ok: covered,
    obligation:
      decimal.cmp(installment, "0") > 0
        ? {
            subject: yearSubject,
            key: `q${String(input.quarter)}`,
            obligation_id: `tax.${String(input.tax_year)}.q${String(input.quarter)}`,
            amount: installment,
            due: spec.due,
            description: `Estimated federal tax, ${String(input.tax_year)} Q${String(input.quarter)}`,
          }
        : null,
    wash_sales: washes,
    evidence,
    findings,
  };
}

function estimateOf(rawInput: unknown, what: string): TaxEstimateOutput {
  const est = assertType(QuarterEstimate, rawInput, what);
  const findings = (rawInput as { findings?: FindingDraft[] }).findings ?? [];
  return { ...est, findings } as TaxEstimateOutput;
}

const eventStem = (est: QuarterEstimate): string => `${est.run_key}:tax.q${String(est.quarter)}.${est.stage}`;

export function taxRecordHandler(actx: ActionContext): ActionHandler {
  return async (rawInput, ctx) => {
    const est = estimateOf(rawInput, "tax.record input");
    return ctx.perform({
      effectId: "record",
      capability: CAP.ledgerWriteFinding,
      run: async () => {
        const fresh = suppressKnown(est.findings, actx.ledger);
        const inputs: FindingInput[] = fresh.map((d) => {
          const { after_refs: _a, holds, fingerprint: _f, ...rest } = d;
          return { ...rest, detail: { ...rest.detail, holds }, after: [] };
        });
        const ids = actx.ledger.appendFindings(`${eventStem(est)}:findings`, inputs);
        actx.ledger.emitEvent({
          id: `${eventStem(est)}:estimate`,
          kind: "tax.estimate",
          subject: `household.tax.${String(est.tax_year)}`,
          payload: {
            run_key: est.run_key,
            tax_year: est.tax_year,
            quarter: est.quarter,
            stage: est.stage,
            as_of: est.as_of,
            due: est.due,
            blocked: est.blocked,
            figures: est.figures,
            reserve: est.reserve,
            reserve_ok: est.reserve_ok,
            wash_sales: est.wash_sales,
            evidence: est.evidence,
            finding_ids: ids,
          },
        });
        return { run_key: est.run_key, finding_ids: ids, queued: inputs.filter((f) => f.requires_human).length, suppressed: est.findings.length - fresh.length };
      },
    });
  };
}

export function taxObligateHandler(actx: ActionContext): ActionHandler {
  return async (rawInput, ctx) => {
    const est = estimateOf(rawInput, "tax.obligate input");
    const o = est.obligation;
    if (o === null) {
      return { changed: false, fact_id: null, reason: est.blocked.length > 0 ? "blocked" : "nothing_due" };
    }
    const reserve = est.reserve;
    if (reserve === null) throw new Error("tax.obligate: an obligation without reserve figures is not a valid estimate");
    return ctx.perform({
      effectId: "obligate",
      capability: CAP.ledgerWriteFact("obligation"),
      run: async () => {
        const current = actx.ledger.asOf({ kind: "obligation", subject: o.subject, key: o.key })[0] ?? null;
        const cp = current?.payload as { payment_amount?: string | null; payment_due?: string | null } | undefined;
        if (cp !== undefined && cp.payment_amount === o.amount && cp.payment_due === o.due) {
          return { changed: false, fact_id: (current as { id: string }).id, reason: "unchanged" };
        }
        const r = actx.ledger.commit({
          batchId: `${eventStem(est)}:liabilities`,
          writer: "liabilities",
          facts: [
            {
              kind: "obligation",
              subject: o.subject,
              key: o.key,
              payload: {
                account_id: reserve.account,
                obligation_id: o.obligation_id,
                kind: "tax_estimate",
                description: o.description,
                principal_outstanding: null,
                payment_amount: o.amount,
                payment_due: o.due,
                rate: null,
                currency: "USD",
              },
              observed_at: est.as_of,
              effective_at: est.as_of,
              source_id: "tax.engine",
              source_doc_id: null,
              supersedes: current?.id ?? null,
              writer: "liabilities",
              provisional: false,
            },
          ],
          note: `tax ${String(est.tax_year)} Q${String(est.quarter)} ${est.stage}`,
        });
        actx.ledger.logAccess({
          at: actx.clock().toISOString(),
          principal: "liabilities",
          resource: `ledger:fact:${o.subject}:${o.key}`,
          action: "write",
          detail: `tax_estimate ${o.amount} due ${o.due}${current === null ? "" : ` supersedes ${current.id}`}`,
        });
        return { changed: !r.replayed, fact_id: r.factIds[0] as string, superseded: current?.id ?? null };
      },
    });
  };
}

export function taxConfirmHandler(actx: ActionContext): ActionHandler {
  return async (rawInput, ctx) => {
    const est = estimateOf(rawInput, "tax.confirm input");
    const obligationFact = (rawInput as { fact_id?: string | null }).fact_id ?? null;
    return ctx.perform({
      effectId: "confirm",
      capability: CAP.ledgerEmit,
      run: async () => {
        const figs = est.figures;
        const nothingDue = figs === null || decimal.cmp(figs.installment_due, "0") === 0;
        const summary =
          figs === null || decimal.cmp(figs.installment_due, "0") === 0
            ? `tax ${String(est.tax_year)} Q${String(est.quarter)} ${est.stage}: nothing due -- payments to date cover the required installment`
            : `tax ${String(est.tax_year)} Q${String(est.quarter)} ${est.stage}: installment ${figs.installment_due} USD due ${est.due} is covered by reserve ${est.reserve?.account ?? ""} (balance ${est.reserve?.balance ?? "?"})${est.stage === "due" ? " -- pay it from reserve; no sale required" : ""}`;
        actx.ledger.appendJournal({
          at: actx.clock().toISOString(),
          kind: "system",
          subject: `household.tax.${String(est.tax_year)}`,
          summary,
          detail: { quarter: est.quarter, stage: est.stage, figures: est.figures, reserve: est.reserve },
          refs: obligationFact === null ? [] : [obligationFact],
          author: "scheduler",
        });
        const evt = actx.ledger.emitEvent({
          id: `${eventStem(est)}:ready`,
          kind: "tax.ready",
          subject: `household.tax.${String(est.tax_year)}`,
          payload: { run_key: est.run_key, quarter: est.quarter, stage: est.stage, installment_due: est.figures?.installment_due ?? "0", reserve: est.reserve },
        });
        return { ready: true, nothing_due: nothingDue, event: evt };
      },
    });
  };
}

export interface TaxSkipInput extends TaxCheckInput {
  note?: string;
  decided_by?: string;
}

export function taxSkipHandler(actx: ActionContext): ActionHandler {
  return async (rawInput, ctx) => {
    const input = checkInput(rawInput, "tax.skip") as TaxSkipInput;
    return ctx.perform({
      effectId: "skip",
      capability: CAP.ledgerEmit,
      run: async () => {
        const who = input.decided_by ?? "operator";
        actx.ledger.appendJournal({
          at: actx.clock().toISOString(),
          kind: "decision",
          subject: `household.tax.${String(input.tax_year)}`,
          summary: `tax ${String(input.tax_year)} Q${String(input.quarter)} ${input.stage}: deadline check skipped by ${who}${input.note ? ` -- ${input.note}` : ""}`,
          detail: { quarter: input.quarter, stage: input.stage, note: input.note ?? null },
          refs: [],
          author: who,
        });
        const evt = actx.ledger.emitEvent({
          id: `${input.run_key}:tax.q${String(input.quarter)}.${input.stage}:skipped`,
          kind: "tax.skipped",
          subject: `household.tax.${String(input.tax_year)}`,
          payload: { run_key: input.run_key, quarter: input.quarter, stage: input.stage, note: input.note ?? null, decided_by: who },
        });
        return { skipped: true, event: evt };
      },
    });
  };
}
