// The action handler registry. `action({ handler: "<ref>" })` in a workflow
// resolves here. Every handler is deterministic TypeScript; no model.

import type { ActionContext, ActionHandler } from "./context";
import { fetchHandler } from "./ingest/fetch";
import { commitHandler } from "./ledger/commit";
import { recordFindingsHandler } from "./ledger/record-findings";
import { holdHandler, notifyHandler } from "./govern/notify";
import { normalizeHandler } from "./normalize/normalize";
import { reconcileHandler } from "./reconcile/reconcile";

export const ACTION_REFS = {
  fetch: "ingest.fetch",
  normalize: "normalize.snapshots",
  reconcile: "reconcile.run",
  commit: "ledger.commit",
  recordFindings: "ledger.record_findings",
  notify: "govern.notify",
  hold: "govern.hold",
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
  };
}

export * from "./context";
export * from "./ingest/fetch";
export * from "./normalize/normalize";
export * from "./reconcile/reconcile";
export * from "./ledger/commit";
export * from "./ledger/record-findings";
export * from "./govern/notify";
