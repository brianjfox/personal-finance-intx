import type { Principal } from "@fin/contracts";
import type { WorkflowDefinition } from "@intx/workflow";

import { buildChatWorkflow, CHAT_WORKFLOWS, REFERENCE_CHAT_MODEL } from "./chat";
import { ESTATE_AUDIT_PRINCIPALS, estateAuditWorkflow } from "./estate-audit";
import { NIGHTLY_PRINCIPALS, nightlyWorkflow } from "./nightly";
import { buildProposalWorkflow } from "./proposal";
import { buildTaxYearWorkflow, TAX_CHECK_PRINCIPALS, taxCheckWorkflow } from "./tax-year";

export * from "./nightly";
export * from "./tax-year";
export * from "./chat";
export * from "./estate-audit";
export * from "./proposal";
export * from "./topology";
export * from "./lint";
export * from "./outcomes";

export interface RegisteredWorkflow {
  definition: WorkflowDefinition;
  stepPrincipals: Record<string, Principal>;
}

/**
 * The reference tax-year instance the static tests and lints walk. Hosts
 * build their own per-year instance at launch (timeouts depend on the
 * clock); step ids and principals are identical across instances, so this
 * fixed anchor stands in for all of them.
 */
export const taxYearReference = buildTaxYearWorkflow({
  taxYear: 2026,
  now: new Date("2026-01-01T00:00:00.000Z"),
});

/** The reference chat instances the static tests and lints walk. */
export const chatReferences = CHAT_WORKFLOWS.map((spec) => buildChatWorkflow(spec.agent, REFERENCE_CHAT_MODEL));

/** The reference proposal instance (default window) the static tests walk. */
export const proposalReference = buildProposalWorkflow({ model: REFERENCE_CHAT_MODEL });

/** Every product workflow. The topology, capability and lint tests walk this list. */
export const ALL_WORKFLOWS: readonly RegisteredWorkflow[] = [
  { definition: nightlyWorkflow, stepPrincipals: NIGHTLY_PRINCIPALS },
  { definition: taxYearReference.definition, stepPrincipals: taxYearReference.stepPrincipals },
  { definition: taxCheckWorkflow, stepPrincipals: TAX_CHECK_PRINCIPALS },
  { definition: estateAuditWorkflow, stepPrincipals: ESTATE_AUDIT_PRINCIPALS },
  ...chatReferences.map((c) => ({ definition: c.definition, stepPrincipals: c.stepPrincipals })),
  proposalReference,
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
