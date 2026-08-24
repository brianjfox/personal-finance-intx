import type { Principal } from "@fin/contracts";
import type { WorkflowDefinition } from "@intx/workflow";

import { NIGHTLY_PRINCIPALS, nightlyWorkflow } from "./nightly";

export * from "./nightly";
export * from "./topology";
export * from "./lint";
export * from "./outcomes";

export interface RegisteredWorkflow {
  definition: WorkflowDefinition;
  stepPrincipals: Record<string, Principal>;
}

/** Every product workflow. The topology, capability and lint tests walk this list. */
export const ALL_WORKFLOWS: readonly RegisteredWorkflow[] = [
  { definition: nightlyWorkflow, stepPrincipals: NIGHTLY_PRINCIPALS },
];

export function workflowById(id: string): RegisteredWorkflow {
  const w = ALL_WORKFLOWS.find((x) => x.definition.id === id);
  if (w === undefined) throw new Error(`no workflow ${id}`);
  return w;
}

/** Union of every workflow's step -> principal table (step ids are namespaced by workflow for the host). */
export function allStepPrincipals(): Record<string, Principal> {
  const out: Record<string, Principal> = {};
  for (const w of ALL_WORKFLOWS) {
    for (const [step, p] of Object.entries(w.stepPrincipals)) {
      const prev = out[step];
      if (prev !== undefined && prev !== p) {
        throw new Error(`step id ${step} runs as ${prev} in one workflow and ${p} in another; rename one`);
      }
      out[step] = p;
    }
  }
  return out;
}
