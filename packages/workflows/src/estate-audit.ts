// The estate hygiene audit (Phase 3, deck slide 8 / annual cadence on
// slide 14): sync `estate.json` into registry facts, then compare the
// plan on paper to the plan in reality. Manual trigger -- run after
// editing the estate file, and periodically; findings are
// fingerprint-deduped so the queue never re-raises a known gap.
//
//   sync (registry) -> audit (estate_planner)

import { ACTION_REFS, CAP } from "@fin/actions";
import type { Principal } from "@fin/contracts";
import { action, defineWorkflow } from "@intx/workflow";

export const ESTATE_AUDIT_ID = "estate-audit";

const runKey = { project: { from: "trigger.payload" }, fields: ["run_key"] } as const;

export const estateAuditWorkflow = defineWorkflow({
  id: ESTATE_AUDIT_ID,
  triggers: [{ type: "manual" }],
  steps: {
    sync_registry: action({
      handler: ACTION_REFS.registrySync,
      input: runKey,
      effect: { requires: [CAP.ledgerWriteFact("entity"), CAP.ledgerWriteFact("titling")] },
    }),
    audit_estate: action({
      handler: ACTION_REFS.estateAudit,
      input: runKey,
      effect: { requires: [CAP.ledgerWriteFinding] },
      after: ["sync_registry"],
    }),
  },
});

export const ESTATE_AUDIT_PRINCIPALS: Record<string, Principal> = {
  sync_registry: "registry",
  audit_estate: "estate_planner",
};
