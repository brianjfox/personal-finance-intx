// BUILD_PLAN §5/§9: "There must be no edge in any workflow DAG from a
// Recommendation step to an execution step that does not pass through an
// awaitSignal. Walk every WorkflowDefinition." Pulled forward to Phase 1
// per STEPS.md. In Phase 1 the assertion holds vacuously over
// ALL_WORKFLOWS; the synthetic cases prove the walker bites.

import { describe, expect, test } from "bun:test";

import { action, awaitSignal, defineWorkflow, gate } from "@intx/workflow";

import {
  ALL_WORKFLOWS,
  allStepPrincipals,
  findApprovalBypasses,
  findCancellingAwaits,
  findCancellingSleeps,
  findParallelJoins,
  findUnexpiringGates,
  STEP_ID_PATTERN,
} from "../src/index";

describe("topology: no path from a proposal to execution skips awaitSignal", () => {
  test("every product workflow", () => {
    for (const w of ALL_WORKFLOWS) {
      expect(findApprovalBypasses(w.definition)).toEqual([]);
      expect(findUnexpiringGates(w.definition)).toEqual([]);
    }
  });

  test("the walker catches a direct bypass", () => {
    const bad = defineWorkflow({
      id: "bad-direct",
      trigger: { type: "manual" },
      steps: {
        propose: action({ handler: "market.propose" }),
        place: action({ handler: "execution.place_order", after: ["propose"] }),
      },
    });
    const v = findApprovalBypasses(bad);
    expect(v).toHaveLength(1);
    expect(v[0]!.path).toEqual(["propose", "place"]);
  });

  test("the walker catches a bypass through a gate branch and intermediate actions", () => {
    const bad = defineWorkflow({
      id: "bad-gate",
      trigger: { type: "manual" },
      steps: {
        propose: action({ handler: "market.propose" }),
        audit: action({ handler: "audit.review", after: ["propose"] }),
        g: gate({ when: { from: "steps.audit.output.ok" }, then: "approve", else: "fast", after: ["audit"] }),
        approve: awaitSignal({ name: "approve", timeout: 1000, onTimeout: "expired", after: ["g"] }),
        expired: action({ handler: "govern.expired", after: ["approve"] }),
        fast: action({ handler: "orders.prepare", after: ["g"] }), // <- the else branch skips the human
        place: action({ handler: "execution.place", after: ["approve"] }),
      },
    });
    const v = findApprovalBypasses(bad);
    expect(v.map((x) => x.executor)).toEqual(["fast"]);
    expect(v[0]!.path).toEqual(["propose", "audit", "g", "fast"]);
  });

  test("the approved shape passes: propose -> audit -> awaitSignal(timeout -> expired) -> execute", () => {
    const good = defineWorkflow({
      id: "good",
      trigger: { type: "manual" },
      steps: {
        propose: action({ handler: "market.propose" }),
        audit: action({ handler: "audit.review", after: ["propose"] }),
        approve: awaitSignal({ name: "approve", timeout: 1000, onTimeout: "expired", after: ["audit"] }),
        expired: action({ handler: "govern.proposal_expired", after: ["approve"] }),
        place: action({ handler: "execution.prepare_order", after: ["approve"] }),
      },
    });
    expect(findApprovalBypasses(good)).toEqual([]);
    expect(findUnexpiringGates(good)).toEqual([]);
  });

  test("an awaitSignal with no timeout is flagged: expiry must be a branch, never auto-approve", () => {
    const w = defineWorkflow({
      id: "noexpiry",
      trigger: { type: "manual" },
      steps: { approve: awaitSignal({ name: "approve" }) },
    });
    expect(findUnexpiringGates(w)).toEqual(["noexpiry.approve"]);
  });
});

describe("definition lints", () => {
  test("D-003: no product sleep relies on the cancel-at-drain default", () => {
    for (const w of ALL_WORKFLOWS) expect(findCancellingSleeps(w.definition)).toEqual([]);
  });
  test("D-011: no product step joins more than one dependency", () => {
    for (const w of ALL_WORKFLOWS) expect(findParallelJoins(w.definition)).toEqual([]);
  });
  test("D-014: no product awaitSignal is cancelled at drain -- deadlines and approvals survive a redeploy", () => {
    for (const w of ALL_WORKFLOWS) expect(findCancellingAwaits(w.definition)).toEqual([]);
    const w = defineWorkflow({
      id: "baddrain",
      trigger: { type: "manual" },
      steps: { approve: awaitSignal({ name: "approve", timeout: 1000, onTimeout: "x", drainBehavior: "cancel" }), x: action({ handler: "noop.x", after: ["approve"] }) },
    });
    expect(findCancellingAwaits(w)).toEqual(["baddrain.approve"]);
  });
  test("every step has a principal, and ids are mail-address safe (§8.7)", () => {
    for (const w of ALL_WORKFLOWS) {
      for (const id of Object.keys(w.definition.steps)) {
        expect(id).toMatch(STEP_ID_PATTERN);
        expect(w.stepPrincipals[id]).toBeDefined();
      }
    }
    expect(Object.keys(allStepPrincipals()).length).toBeGreaterThan(0);
  });
  test("advisory-tier principals never run a step that declares a ledger-write capability", () => {
    const advisory = new Set(["strategist", "market_manager", "estate_planner"]);
    for (const w of ALL_WORKFLOWS) {
      for (const [id, p] of Object.entries(w.definition.steps)) {
        if (p.kind !== "action" || !advisory.has(w.stepPrincipals[id] ?? "")) continue;
        for (const cap of p.effect?.requires ?? []) expect(cap.startsWith("ledger.write")).toBe(false);
      }
    }
  });
});
