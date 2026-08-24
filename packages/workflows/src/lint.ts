// Definition lints that encode DECISIONS.md rules.
//
// D-003: every `sleep` must declare `drainBehavior` explicitly (the default
// is "cancel", which would kill a Sep 15 deadline timer at an August
// redeploy). Because the constructor fills the default, a declaration
// cannot be distinguished from an omission on the primitive alone -- so
// the rule is: no `sleep` in a product workflow may carry "cancel" at all.
// A product `sleep` is a deadline; deadlines wait.

import type { WorkflowDefinition } from "@intx/workflow";

export function findCancellingSleeps(def: WorkflowDefinition): string[] {
  const out: string[] = [];
  for (const [id, p] of Object.entries(def.steps)) {
    if (p.kind === "sleep" && p.drainBehavior !== "wait") out.push(`${def.id}.${id}`);
    const body = p.kind === "loop" ? p.body : p.kind === "onTrigger" && "inline" in p.body ? p.body.inline : null;
    if (body !== null) out.push(...findCancellingSleeps(body));
  }
  return out;
}

/**
 * BUILD_PLAN §8.8 / D-014: a product `awaitSignal` is a deadline or an
 * approval parked across days -- a redeploy must never cancel it. The
 * constructor's default is already "wait"; this catches anyone setting
 * "cancel" deliberately.
 */
export function findCancellingAwaits(def: WorkflowDefinition): string[] {
  const out: string[] = [];
  for (const [id, p] of Object.entries(def.steps)) {
    if (p.kind === "awaitSignal" && p.drainBehavior !== "wait") out.push(`${def.id}.${id}`);
    const body = p.kind === "loop" ? p.body : p.kind === "onTrigger" && "inline" in p.body ? p.body.inline : null;
    if (body !== null) out.push(...findCancellingAwaits(body));
  }
  return out;
}

/** Step ids must be mail-address safe (BUILD_PLAN §8.7). defineWorkflow enforces it; this is the test's mirror. */
export const STEP_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

/**
 * D-011: at `@intx/workflow@0.3.0` a step whose several dependencies settle
 * in the same scheduler tick can be scheduled before the last dependency's
 * output is registered for selectors (`runtime/run.ts`: `stepOutputs` is
 * written in a `.then` after `StepCompleted` is durable; `reloadState` can
 * observe the terminal phase first). Product workflows therefore chain
 * instead of joining. This returns every step with more than one `after`
 * dependency. Gate branches (`then`/`else`) are single-`after` by
 * construction and are not joins.
 */
export function findParallelJoins(def: WorkflowDefinition): string[] {
  const out: string[] = [];
  for (const [id, p] of Object.entries(def.steps)) {
    if ((p.after?.length ?? 0) > 1) out.push(`${def.id}.${id}`);
    const body = p.kind === "loop" ? p.body : p.kind === "onTrigger" && "inline" in p.body ? p.body.inline : null;
    if (body !== null) out.push(...findParallelJoins(body));
  }
  return out;
}
