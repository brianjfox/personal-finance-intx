// The nightly: ingest, normalise, reconcile (deck slide 15).
//
//   fetch -> normalize -> reconcile -> commit_assets -> commit_flows -> commit_docs
//         -> record_findings -> gate ->(clean) notify
//                                   ->(break) hold
//
// Every node is an `action` -- deterministic TypeScript (BUILD_PLAN §3:
// "Ledger-writing agents (6) -> action primitives. No model."). The three
// commit steps exist so each runs under its owning writer's principal
// (one writer per fact). The gate routes on reconcile's verdict: the
// exception path is a branch, not a flag, and `notify` (where Tax, Risk
// and Market would wake) is unreachable when any account is held.
//
// The three commits are chained, not fanned out: at the pinned framework
// version a dependent of several steps that settle in one scheduler tick
// can be scheduled before the last output is registered for selectors
// (DECISIONS.md D-011). The lint `findParallelJoins` keeps product
// workflows free of multi-dependency joins until that is fixed upstream.
//
// Trigger payload: `{ run_key: string, institutions?: string[] }`. The host
// sets `run_key` to the run id so every idempotency key in the run derives
// from it.

import { ACTION_REFS, CAP } from "@fin/actions";
import { FACT_KINDS, type Principal } from "@fin/contracts";
import { action, defineWorkflow, gate } from "@intx/workflow";

export const NIGHTLY_ID = "nightly-reconcile";

const runKey = { project: { from: "trigger.payload" }, fields: ["run_key"] } as const;

export const nightlyWorkflow = defineWorkflow({
  id: NIGHTLY_ID,
  triggers: [{ type: "manual" }],
  steps: {
    fetch: action({
      handler: ACTION_REFS.fetch,
      input: { from: "trigger.payload" },
      effect: { requires: [CAP.institutionRead] },
    }),
    normalize: action({
      handler: ACTION_REFS.normalize,
      input: { merge: [{ from: "steps.fetch.output" }, runKey] },
      after: ["fetch"],
    }),
    reconcile: action({
      handler: ACTION_REFS.reconcile,
      input: { from: "steps.normalize.output" },
      after: ["normalize"],
    }),
    commit_assets: commitStep("assets_manager", ["account", "balance", "position", "lot"], "reconcile"),
    commit_flows: commitStep("cash_flow", ["transaction"], "commit_assets"),
    commit_docs: commitStep("document_vault", ["tax_document"], "commit_flows"),
    record_findings: action({
      handler: ACTION_REFS.recordFindings,
      input: {
        merge: [
          { project: { from: "steps.reconcile.output" }, fields: ["run_key", "clean", "findings", "provisional_subjects", "answered"] },
          { from: "steps.commit_assets.output" },
          { from: "steps.commit_flows.output" },
          { from: "steps.commit_docs.output" },
        ],
      },
      effect: { requires: [CAP.ledgerWriteFinding] },
      after: ["commit_docs"],
    }),
    // The provisional gate. `when` is the reconcile verdict (true = no account held).
    gate: gate({
      when: { from: "steps.reconcile.output.clean" },
      then: "notify",
      else: "hold",
      after: ["record_findings"],
    }),
    notify: action({
      handler: ACTION_REFS.notify,
      input: {
        merge: [
          { project: { from: "steps.record_findings.output" }, fields: ["run_key", "clean", "provisional_subjects", "finding_ids", "queued"] },
          { from: "steps.commit_assets.output" },
          { from: "steps.commit_flows.output" },
          { from: "steps.commit_docs.output" },
        ],
      },
      effect: { requires: [CAP.ledgerEmit] },
      after: ["gate"],
    }),
    hold: action({
      handler: ACTION_REFS.hold,
      input: { from: "steps.record_findings.output" },
      effect: { requires: [CAP.ledgerEmit] },
      after: ["gate"],
    }),
  },
});

function commitStep(writer: Principal, kinds: readonly (typeof FACT_KINDS)[number][], after: string) {
  return action({
    handler: ACTION_REFS.commit,
    input: {
      merge: [
        { literal: { writer } },
        { project: { from: "steps.normalize.output" }, fields: ["run_key", "facts"] },
        { project: { from: "steps.reconcile.output" }, fields: ["provisional_subjects"] },
      ],
    },
    effect: { requires: kinds.map((k) => CAP.ledgerWriteFact(k)) },
    after: [after],
  });
}

/** Which principal each step runs as -- the policy layer's input. */
export const NIGHTLY_PRINCIPALS: Record<string, Principal> = {
  fetch: "assets_manager",
  normalize: "assets_manager",
  reconcile: "reconciliation",
  commit_assets: "assets_manager",
  commit_flows: "cash_flow",
  commit_docs: "document_vault",
  record_findings: "reconciliation",
  gate: "scheduler",
  notify: "scheduler",
  hold: "scheduler",
};
