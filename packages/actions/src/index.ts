// The action handler registry. `action({ handler: "<ref>" })` in a workflow
// resolves here. Every handler is deterministic TypeScript; no model.

import type { ActionContext, ActionHandler } from "./context";
import { fetchHandler } from "./ingest/fetch";
import { commitHandler } from "./ledger/commit";
import { recordFindingsHandler } from "./ledger/record-findings";
import { holdHandler, notifyHandler } from "./govern/notify";
import { normalizeHandler } from "./normalize/normalize";
import { reconcileHandler } from "./reconcile/reconcile";
import {
  auditIntakeHandler,
  auditReviewHandler,
  executionPrepareHandler,
  governDecisionHandler,
  governExhaustedHandler,
  governExpiredHandler,
  governRejectedHandler,
  marketDriftHandler,
} from "./market/handlers";
import { estateAuditHandler, registrySyncHandler } from "./registry/registry";
import {
  taxConfirmHandler,
  taxEstimateHandler,
  taxObligateHandler,
  taxRecordHandler,
  taxSkipHandler,
} from "./tax/handlers";

export const ACTION_REFS = {
  fetch: "ingest.fetch",
  normalize: "normalize.snapshots",
  reconcile: "reconcile.run",
  commit: "ledger.commit",
  recordFindings: "ledger.record_findings",
  notify: "govern.notify",
  hold: "govern.hold",
  taxEstimate: "tax.estimate",
  taxRecord: "tax.record",
  taxObligate: "tax.obligate",
  taxConfirm: "tax.confirm",
  taxSkip: "tax.skip",
  registrySync: "registry.sync",
  estateAudit: "estate.audit",
  marketDrift: "mm.drift",
  auditIntake: "audit.intake",
  auditReview: "audit.review",
  governDecision: "govern.decision",
  executionPrepare: "execution.prepare",
  governExpired: "govern.expired",
  governRejected: "govern.rejected",
  governExhausted: "govern.exhausted",
} as const;

export function buildActions(actx: ActionContext): Record<string, ActionHandler> {
  return {
    [ACTION_REFS.fetch]: fetchHandler(actx),
    [ACTION_REFS.normalize]: normalizeHandler(actx),
    [ACTION_REFS.reconcile]: reconcileHandler(actx),
    [ACTION_REFS.commit]: commitHandler(actx),
    [ACTION_REFS.recordFindings]: recordFindingsHandler(actx),
    [ACTION_REFS.notify]: notifyHandler(actx),
    [ACTION_REFS.hold]: holdHandler(actx),
    [ACTION_REFS.taxEstimate]: taxEstimateHandler(actx),
    [ACTION_REFS.taxRecord]: taxRecordHandler(actx),
    [ACTION_REFS.taxObligate]: taxObligateHandler(actx),
    [ACTION_REFS.taxConfirm]: taxConfirmHandler(actx),
    [ACTION_REFS.taxSkip]: taxSkipHandler(actx),
    [ACTION_REFS.registrySync]: registrySyncHandler(actx),
    [ACTION_REFS.estateAudit]: estateAuditHandler(actx),
    [ACTION_REFS.marketDrift]: marketDriftHandler(actx),
    [ACTION_REFS.auditIntake]: auditIntakeHandler(actx),
    [ACTION_REFS.auditReview]: auditReviewHandler(actx),
    [ACTION_REFS.governDecision]: governDecisionHandler(actx),
    [ACTION_REFS.executionPrepare]: executionPrepareHandler(actx),
    [ACTION_REFS.governExpired]: governExpiredHandler(actx),
    [ACTION_REFS.governRejected]: governRejectedHandler(actx),
    [ACTION_REFS.governExhausted]: governExhaustedHandler(actx),
  };
}

export * from "./context";
export * from "./ingest/fetch";
export * from "./normalize/normalize";
export * from "./reconcile/reconcile";
export * from "./ledger/commit";
export * from "./ledger/record-findings";
export * from "./govern/notify";
export * from "./tax/math";
export * from "./tax/handlers";
export * from "./registry/registry";
export * from "./projections/montecarlo";
export * from "./projections/scenario";
export * from "./market/drift";
export * from "./market/handlers";
