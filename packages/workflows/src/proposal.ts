// The proposal -> review -> approval -> prepared-instruction workflow
// (Phase 4, deck slide 16). Six steps, one of them irreducibly human;
// execution disabled -- the path ends at a PREPARED instruction.
//
//   drift (action, market_manager)
//     -> rework: loop x3 {                         (BUILD_PLAN §8.6: the
//          propose (step, market-manager model)     rework loop cannot
//          -> intake (action, auditor)              contain the human
//          -> audit  (action, auditor)              gate; approval sits
//        } while blocked, carry prior blocks        OUTSIDE the loop)
//     -> converged: approve (awaitSignal, timeout -> expired; NEVER auto)
//          -> decide (action, operator)  -> gate -> prepare (execution)
//                                                -> rejected (scheduler)
//     -> exhausted (scheduler)
//
// This is the workflow the topology test was written for in Phase 1:
// `propose` is a producer (a market-manager agent step), `prepare` is an
// executor (`execution.*` handler), and the only path between them runs
// through the `approve` awaitSignal. The walker now bites on real steps.
//
// The approval signal: name `approval.decision` on THIS run, payload
// { recommendation_id, decision, bound?, signed_by, note?, window_ms? },
// signalId `approve:<recommendation_id>` -- deduped by the state machine,
// so a double-click cannot double-approve (D-001), and deliverable
// through the durable inbox while no host is running.

import { ACTION_REFS, CAP, DEFAULT_PROPOSAL_EXPIRY_MS } from "@fin/actions";
import { marketManagerAgent } from "@fin/agents";
import type { Principal } from "@fin/contracts";
import {
  action,
  awaitSignal,
  defineWorkflow,
  gate,
  loop,
  step,
  type LoopFn,
  type LoopFnRegistry,
  type WorkflowDefinition,
} from "@intx/workflow";

export const PROPOSAL_ID = "rebalance-proposal";
export const PROPOSAL_BODY_ID = "proposal-body";
export const APPROVAL_SIGNAL = "approval.decision";

const runKey = { project: { from: "trigger.payload" }, fields: ["run_key"] } as const;

export interface ProposalWorkflowOptions {
  model: string;
  /** The approval window: gate timeout and the drafts' expiry. */
  expiryMs?: number;
  maxRedrafts?: number;
}

export function buildProposalWorkflow(opts: ProposalWorkflowOptions): { definition: WorkflowDefinition; stepPrincipals: Record<string, Principal> } {
  const expiryMs = opts.expiryMs ?? DEFAULT_PROPOSAL_EXPIRY_MS;

  // The loop body: one draft attempt. Child-run trigger payload =
  // { run_key, attempt, drift..., prior? } threaded by input/carry.
  const body = defineWorkflow({
    id: PROPOSAL_BODY_ID,
    triggers: [{ type: "manual" }],
    steps: {
      propose: step({
        agent: marketManagerAgent(opts.model),
        input: { from: "trigger.payload" },
        timeout: 300_000,
      }),
      intake: action({
        handler: ACTION_REFS.auditIntake,
        input: {
          merge: [
            { project: { from: "trigger.payload" }, fields: ["run_key", "attempt"] },
            { project: { from: "steps.propose.output" }, fields: ["reply"] },
          ],
        },
        effect: { requires: [CAP.recordRecommendation] },
        after: ["propose"],
      }),
      audit: action({
        handler: ACTION_REFS.auditReview,
        input: { from: "steps.intake.output" },
        effect: { requires: [CAP.recordVerdict, CAP.ledgerRead] },
        after: ["intake"],
      }),
    },
  });

  const definition = defineWorkflow({
    id: PROPOSAL_ID,
    triggers: [{ type: "manual" }],
    steps: {
      drift: action({
        handler: ACTION_REFS.marketDrift,
        input: runKey,
        effect: { requires: [CAP.ledgerReadPositions] },
      }),
      rework: loop({
        body,
        while: "mm.blocked",
        carry: "mm.carry",
        input: { merge: [runKey, { literal: { attempt: 1 } }, { from: "steps.drift.output" }] },
        maxIterations: opts.maxRedrafts ?? 3,
        onExhausted: "exhausted",
        after: ["drift"],
      }),
      // Normal (converged) successor of the loop: the human gate.
      approve: awaitSignal({
        name: APPROVAL_SIGNAL,
        timeout: expiryMs,
        onTimeout: "expired",
        drainBehavior: "wait",
        after: ["rework"],
      }),
      decide: action({
        handler: ACTION_REFS.governDecision,
        input: { merge: [runKey, { from: "steps.approve.output" }] },
        effect: { requires: [CAP.recordApproval] },
        after: ["approve"],
      }),
      route: gate({
        when: { from: "steps.decide.output.approved" },
        then: "prepare",
        else: "rejected",
        after: ["decide"],
      }),
      prepare: action({
        handler: ACTION_REFS.executionPrepare,
        input: { merge: [runKey, { project: { from: "steps.decide.output" }, fields: ["recommendation_id", "approval_id"] }] },
        effect: { requires: [CAP.recordInstruction] },
        after: ["route"],
      }),
      rejected: action({
        handler: ACTION_REFS.governRejected,
        input: { merge: [runKey, { project: { from: "steps.decide.output" }, fields: ["recommendation_id"] }] },
        effect: { requires: [CAP.ledgerEmit] },
        after: ["route"],
      }),
      expired: action({
        handler: ACTION_REFS.governExpired,
        input: runKey,
        effect: { requires: [CAP.ledgerEmit] },
        after: ["approve"],
      }),
      exhausted: action({
        handler: ACTION_REFS.governExhausted,
        input: runKey,
        effect: { requires: [CAP.ledgerEmit] },
        after: ["rework"],
      }),
    },
  });

  return { definition, stepPrincipals: PROPOSAL_PRINCIPALS };
}

/** Parent step ids AND loop-body step ids (the authorize context carries body ids inside iterations). */
export const PROPOSAL_PRINCIPALS: Record<string, Principal> = {
  drift: "market_manager",
  rework: "scheduler",
  propose: "market_manager",
  intake: "auditor",
  audit: "auditor",
  approve: "scheduler",
  decide: "operator",
  route: "scheduler",
  prepare: "execution",
  rejected: "scheduler",
  expired: "scheduler",
  exhausted: "scheduler",
};

/**
 * The loop's pure while/carry, resolved by ref (BUILD_PLAN §8.5: they
 * run on every resume and must be side-effect free). The body output is
 * the iteration's step-outputs record.
 */
export const proposalLoopFns: LoopFnRegistry = (ref: string): LoopFn => {
  if (ref === "mm.blocked") {
    // Continue looping while the audit did NOT clear.
    return (childOutput) => (childOutput as { audit?: { cleared?: boolean } } | null)?.audit?.cleared !== true;
  }
  if (ref === "mm.carry") {
    return (childOutput, carryState) => {
      const out = childOutput as { audit?: { blocks?: unknown }; propose?: { reply?: unknown } } | null;
      const prev = (carryState ?? {}) as Record<string, unknown>;
      return {
        ...prev,
        attempt: Number(prev["attempt"] ?? 1) + 1,
        prior: {
          blocks: out?.audit?.blocks ?? [],
          reply: typeof out?.propose?.reply === "string" ? out.propose.reply : null,
        },
      };
    };
  }
  throw new Error(`no loop fn registered for ref ${ref}`);
};
