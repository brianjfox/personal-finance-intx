// Per-step outcomes from a run's event log. A gate's not-selected branch
// is "skipped" -- its StepCompleted carries a structured sentinel
// (`{ skipped: true, gateId, branch }`) rather than a handler output, and
// the runtime's `RunResult.outputs` does not include it. Hosts and tests
// read outcomes here instead of guessing from `outputs`.

import type { WorkflowEvent } from "@intx/workflow";

export type StepOutcome =
  | { status: "completed" }
  | { status: "skipped"; gateId: string; branch: string }
  | { status: "failed"; message: string }
  | { status: "in-flight" }
  | { status: "awaiting-signal" }
  | { status: "cancelled" };

export function stepOutcomes(events: readonly WorkflowEvent[]): Record<string, StepOutcome> {
  const out: Record<string, StepOutcome> = {};
  for (const e of events) {
    switch (e.kind) {
      case "StepStarted":
        out[e.stepId] = { status: "in-flight" };
        break;
      case "SignalAwaited":
        out[e.stepId] = { status: "awaiting-signal" };
        break;
      case "StepCompleted": {
        const ref = e.output.ref;
        const sentinel = parseInlineSentinel(ref);
        out[e.stepId] =
          sentinel !== null
            ? { status: "skipped", gateId: sentinel.gateId, branch: sentinel.branch }
            : { status: "completed" };
        break;
      }
      case "StepFailed":
        out[e.stepId] = { status: "failed", message: e.error.message };
        break;
      case "CancelPropagated":
        out[e.stepId] = { status: "cancelled" };
        break;
      default:
        break;
    }
  }
  return out;
}

function parseInlineSentinel(ref: string): { gateId: string; branch: string } | null {
  if (!ref.startsWith("inline:")) return null;
  try {
    const v = JSON.parse(ref.slice("inline:".length)) as { skipped?: boolean; gateId?: string; branch?: string };
    if (v !== null && typeof v === "object" && v.skipped === true && typeof v.gateId === "string" && typeof v.branch === "string") {
      return { gateId: v.gateId, branch: v.branch };
    }
  } catch {
    /* not a sentinel */
  }
  return null;
}
