// The workflow-level authorize function.
//
// The runtime calls `authorize("effect:<cap>", "invoke", { runId, stepId })`
// before every `EffectContext.perform`. We resolve the step to its
// principal (each workflow declares `stepPrincipals`), translate the
// capability to a matrix cell, and evaluate the grants. Unknown step or
// unmatched grant -> refusal. Every decision is observable through
// `onDecision` so the host can write the access log.

import type { Principal } from "@fin/contracts";
import { authorize as authzAuthorize, createInMemoryGrantStore } from "@intx/authz";
import type { AuthzResult } from "@intx/authz";
import type { GrantRule, GrantStore } from "@intx/types/authz";
import type { AuthorizeContext, WorkflowAuthorizeFn } from "@intx/workflow";

import { capabilityToResource, matrixGrants } from "./matrix";

export interface PolicyDecision {
  principal: Principal | null;
  stepId: string | undefined;
  runId: string | undefined;
  resource: string;
  action: string;
  matrixResource: string;
  matrixAction: string;
  effect: AuthzResult["effect"];
  resolvedBy: string | null;
}

export interface PolicyOptions {
  /** step id -> principal for the workflow(s) this authorize fn serves. */
  stepPrincipals: Record<string, Principal>;
  grants?: GrantRule[];
  tenantId?: string;
  onDecision?: (d: PolicyDecision) => void;
}

export const TENANT = "household";

export function createPolicyStore(grants: GrantRule[] = matrixGrants()): GrantStore {
  return createInMemoryGrantStore(grants);
}

/** Evaluate one matrix cell directly (used by the capability tests and by the host for non-workflow checks). */
export async function decide(
  store: GrantStore,
  principal: Principal,
  resource: string,
  action: string,
  tenantId: string = TENANT,
): Promise<AuthzResult> {
  return authzAuthorize(store, principal, tenantId, resource, action);
}

export function createPolicyAuthorize(opts: PolicyOptions): WorkflowAuthorizeFn {
  const store = createPolicyStore(opts.grants);
  const tenant = opts.tenantId ?? TENANT;
  return async (resource: string, action: string, context: AuthorizeContext) => {
    const stepId = context.stepId;
    const principal = stepId === undefined ? null : (opts.stepPrincipals[stepId] ?? null);
    let matrixResource = resource;
    let matrixAction = action;
    if (resource.startsWith("effect:") && action === "invoke") {
      const m = capabilityToResource(resource.slice("effect:".length));
      matrixResource = m.resource;
      matrixAction = m.action;
    }
    const result: AuthzResult =
      principal === null
        ? { effect: null, matchingGrants: [], resolvedBy: null }
        : await authzAuthorize(store, principal, tenant, matrixResource, matrixAction);
    opts.onDecision?.({
      principal,
      stepId,
      runId: context.runId,
      resource,
      action,
      matrixResource,
      matrixAction,
      effect: result.effect,
      resolvedBy: result.resolvedBy?.id ?? null,
    });
    // Fail closed: `ask` and `null` are refusals at this layer (there is no
    // one to ask inside a nightly run; human gates are awaitSignal nodes).
    if (result.effect !== "allow") {
      return { effect: "deny", matchingGrants: result.matchingGrants, resolvedBy: result.resolvedBy };
    }
    return result;
  };
}
