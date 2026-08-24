// The tax calendar is a workflow, not a cron table (deck slide 17).
//
// One standing run per tax year. Every deadline is a TIMED `awaitSignal`
// gate, not a `sleep`: at the pinned framework version a `sleep` parked
// across a restart is refused on resume, while a timed `awaitSignal`
// re-parks and re-arms its own timer from the durable `TimerSet`
// (DECISIONS.md D-006, resolved here as D-014). The timer IS the
// deadline; the signal is the operator saying "I handled this one
// elsewhere" -- so expiry routes to the check chain and a delivered
// signal routes to a journaled skip. Never to auto-approve, and never
// to silence.
//
//   wait_qN_S --timeout--> est_qN_S -> rec_qN_S -> obl_qN_S -> cov_qN_S --ok-->  ok_qN_S
//            \--signal-->  skip_qN_S                                  \--short-> esc_qN_S
//
// for N in 1..4 and S in {pre, due}: `pre` is the reserve pre-stage
// check `leadDays` before the deadline ("park the estimate before the
// deadline"), `due` the deadline itself. Chains only, no fan-in
// (D-011); every gate carries an explicit `drainBehavior: "wait"` so a
// redeploy cannot cancel a September deadline (BUILD_PLAN §8.8, D-003).
//
// Timeouts are computed as (fire-time - now) at build time. Rebuilding
// the definition on resume with a later `now` is safe: a gate already
// parked re-adopts its durable absolute `TimerSet` and ignores the new
// timeout; only a gate that has not yet parked uses it, and (fire - now)
// is the correct remaining delay whenever it is computed.
//
// `fireAt` overrides exist for tests and for operator-shifted deadlines;
// they move WHEN the check runs, never the statutory due date the
// obligation carries -- that comes from `quarterSpec`.

import { ACTION_REFS, CAP, quarterSpec } from "@fin/actions";
import { TAX_QUARTERS, TAX_STAGES, type Principal, type TaxQuarter, type TaxStage } from "@fin/contracts";
import { action, awaitSignal, defineWorkflow, escalation, gate, type Primitive, type Selector, type WorkflowDefinition } from "@intx/workflow";

export const taxYearWorkflowId = (taxYear: number): string => `tax-year-${String(taxYear)}`;
export const deadlineSignal = (quarter: TaxQuarter, stage: TaxStage): string => `deadline.q${String(quarter)}.${stage}`;
export const skipSignalId = (taxYear: number, quarter: TaxQuarter, stage: TaxStage): string =>
  `skip:${String(taxYear)}:q${String(quarter)}:${stage}`;

export const DEFAULT_LEAD_DAYS = 30;
/** Deadline checks fire mid-day UTC on the statutory date. */
const FIRE_TIME = "T12:00:00.000Z";

export type FireAtOverrides = Partial<
  Record<"q1" | "q2" | "q3" | "q4" | "q1_pre" | "q2_pre" | "q3_pre" | "q4_pre", string>
>;

export interface TaxYearOptions {
  taxYear: number;
  /** Build-time clock anchor; gate timeouts are (fireAt - now), floored at 0. */
  now: Date;
  /** Days before each deadline the reserve pre-stage check fires. */
  leadDays?: number;
  fireAt?: FireAtOverrides;
  /**
   * Spacing between catch-up firings when several deadlines are already
   * past at build time (a mid-year launch). At the pinned framework
   * version, steps completing in the same scheduler tick can race their
   * dependents' selector context (D-011); serializing the catch-up
   * chains keeps each quarter's est->rec->obl chain alone in flight.
   */
  catchupStaggerMs?: number;
}

export const DEFAULT_CATCHUP_STAGGER_MS = 1500;

export interface TaxDeadline {
  quarter: TaxQuarter;
  stage: TaxStage;
  /** The statutory due date the obligation will carry. */
  due: string;
  period_end: string;
  /** When the gate's timer fires (ISO). */
  fire_at: string;
  /** Deliver this signal name (with `skipSignalId`) to skip the check. */
  signal: string;
  gate_step: string;
}

export interface TaxYearWorkflow {
  definition: WorkflowDefinition;
  stepPrincipals: Record<string, Principal>;
  taxYear: number;
  deadlines: TaxDeadline[];
}

export function buildTaxYearWorkflow(opts: TaxYearOptions): TaxYearWorkflow {
  const leadDays = opts.leadDays ?? DEFAULT_LEAD_DAYS;
  const stagger = opts.catchupStaggerMs ?? DEFAULT_CATCHUP_STAGGER_MS;
  const steps: Record<string, Primitive> = {};
  const stepPrincipals: Record<string, Principal> = {};
  const deadlines: TaxDeadline[] = [];
  let overdue = 0;

  for (const quarter of TAX_QUARTERS) {
    for (const stage of TAX_STAGES) {
      const spec = quarterSpec(opts.taxYear, quarter);
      const dueFire = opts.fireAt?.[`q${quarter}`] ?? `${spec.due}${FIRE_TIME}`;
      const fireAt =
        stage === "due"
          ? dueFire
          : (opts.fireAt?.[`q${quarter}_pre`] ?? new Date(Date.parse(dueFire) - leadDays * 86_400_000).toISOString());
      const sfx = `q${String(quarter)}_${stage}`;
      const [wait, skip, est, rec, obl, cov, ok, esc] = [
        `wait_${sfx}`, `skip_${sfx}`, `est_${sfx}`, `rec_${sfx}`, `obl_${sfx}`, `cov_${sfx}`, `ok_${sfx}`, `esc_${sfx}`,
      ] as [string, string, string, string, string, string, string, string];
      const runKey = { project: { from: "trigger.payload" }, fields: ["run_key"] } as const;
      const check = { literal: { tax_year: opts.taxYear, quarter, stage } } as const;

      // Past deadlines catch up serially (`stagger` apart), not all at
      // once -- see catchupStaggerMs above.
      let timeout = Math.max(0, Date.parse(fireAt) - opts.now.getTime());
      if (timeout === 0) {
        timeout = overdue * stagger;
        overdue += 1;
      }
      steps[wait] = awaitSignal({
        name: deadlineSignal(quarter, stage),
        timeout,
        onTimeout: est,
        drainBehavior: "wait",
      });
      // Signal branch: the operator handled the deadline elsewhere. The
      // skip step deliberately reads NOTHING from the gate's output --
      // several gates consuming queued skips in one tick would race the
      // selector context (D-011/D-015). The operator's note is journaled
      // by the deliverer (App.skipTaxDeadline) at delivery time; the
      // signal payload survives verbatim on the run log's SignalReceived.
      steps[skip] = action({
        handler: ACTION_REFS.taxSkip,
        input: { merge: [runKey, check] },
        effect: { requires: [CAP.ledgerEmit] },
        after: [wait],
      });
      appendCheckChain(steps, { est, rec, obl, cov, ok, esc }, { merge: [runKey, check] }, [wait]);
      Object.assign(stepPrincipals, checkChainPrincipals({ est, rec, obl, cov, ok, esc }), {
        [wait]: "scheduler",
        [skip]: "scheduler",
      } satisfies Record<string, Principal>);
      deadlines.push({
        quarter,
        stage,
        due: spec.due,
        period_end: spec.periodEnd,
        fire_at: new Date(Date.parse(fireAt)).toISOString(),
        signal: deadlineSignal(quarter, stage),
        gate_step: wait,
      });
    }
  }

  return {
    definition: defineWorkflow({ id: taxYearWorkflowId(opts.taxYear), triggers: [{ type: "manual" }], steps }),
    stepPrincipals,
    taxYear: opts.taxYear,
    deadlines,
  };
}

/** est -> rec -> obl -> cov --then--> ok / --else--> esc, hanging off `after`. */
function appendCheckChain(
  steps: Record<string, Primitive>,
  id: { est: string; rec: string; obl: string; cov: string; ok: string; esc: string },
  estInput: Selector,
  after?: string[],
): void {
  steps[id.est] = action({
    handler: ACTION_REFS.taxEstimate,
    input: estInput,
    effect: { requires: [CAP.ledgerRead] },
    ...(after !== undefined ? { after } : {}),
  });
  steps[id.rec] = action({
    handler: ACTION_REFS.taxRecord,
    input: { from: `steps.${id.est}.output` },
    effect: { requires: [CAP.ledgerWriteFinding] },
    after: [id.est],
  });
  steps[id.obl] = action({
    handler: ACTION_REFS.taxObligate,
    input: { from: `steps.${id.est}.output` },
    effect: { requires: [CAP.ledgerWriteFact("obligation")] },
    after: [id.rec],
  });
  // The coverage gate: reserve covers the installment (and the estimate
  // was not blocked on provisional data) -> confirm; else escalate.
  steps[id.cov] = gate({
    when: { from: `steps.${id.est}.output.reserve_ok` },
    then: id.ok,
    else: id.esc,
    after: [id.obl],
  });
  steps[id.ok] = action({
    handler: ACTION_REFS.taxConfirm,
    input: { merge: [{ from: `steps.${id.est}.output` }, { from: `steps.${id.obl}.output` }] },
    effect: { requires: [CAP.ledgerEmit] },
    after: [id.cov],
  });
  steps[id.esc] = escalation({ to: "operator", data: { from: `steps.${id.est}.output` }, after: [id.cov] });
}

function checkChainPrincipals(id: { est: string; rec: string; obl: string; cov: string; ok: string; esc: string }): Record<string, Principal> {
  return {
    [id.est]: "tax_engine",
    [id.rec]: "tax_engine",
    [id.obl]: "liabilities",
    [id.cov]: "scheduler",
    [id.ok]: "scheduler",
    [id.esc]: "scheduler",
  };
}

// --- tax-check: the same chain, run once, on demand -------------------
//
// "Bring the deadline forward": a manual run over the same handlers and
// the same idempotency keys computes the current estimate any time --
// after resolving a break, after a mid-year income change -- without
// touching the standing run's timers. Trigger payload:
//   { run_key, tax_year, quarter (1-4), stage ("pre"|"due") }

export const TAX_CHECK_ID = "tax-check";

const taxCheckSteps: Record<string, Primitive> = {};
appendCheckChain(
  taxCheckSteps,
  { est: "est_check", rec: "rec_check", obl: "obl_check", cov: "cov_check", ok: "ok_check", esc: "esc_check" },
  { project: { from: "trigger.payload" }, fields: ["run_key", "tax_year", "quarter", "stage"] },
);

export const taxCheckWorkflow = defineWorkflow({
  id: TAX_CHECK_ID,
  triggers: [{ type: "manual" }],
  steps: taxCheckSteps,
});

export const TAX_CHECK_PRINCIPALS: Record<string, Principal> = checkChainPrincipals({
  est: "est_check",
  rec: "rec_check",
  obl: "obl_check",
  cov: "cov_check",
  ok: "ok_check",
  esc: "esc_check",
});
