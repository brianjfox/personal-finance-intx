// Topology walker: BUILD_PLAN §5/§9 "There must be no edge in any workflow
// DAG from a Recommendation step to an execution step that does not pass
// through an awaitSignal. Write a test that walks every WorkflowDefinition
// and asserts this. This is the highest-value test in the codebase."
//
// Pulled forward from Phase 4 (STEPS.md) as a walker that grows: the
// classifier below recognises producers/executors by handler/agent naming
// conventions that Phase 4 will use, and the registry of all definitions
// is `ALL_WORKFLOWS` in index.ts. In Phase 1 there are no producers and no
// executors, so the assertion holds vacuously -- and the test proves the
// walker bites on a deliberately bad synthetic definition.

import type { Primitive, WorkflowDefinition } from "@intx/workflow";

export interface TopologyClassifier {
  /** A step that produces a Recommendation (Market Manager / parse-proposal action). */
  isProducer: (id: string, p: Primitive) => boolean;
  /** A step that executes: touches a broker, places/prepares an order, moves money. */
  isExecutor: (id: string, p: Primitive) => boolean;
}

/** Default convention: handler refs / agent ids. Phase 4 extends this list, never loosens it. */
export const DEFAULT_CLASSIFIER: TopologyClassifier = {
  isProducer: (_id, p) =>
    (p.kind === "action" && /^(market\.|propose\.|recommend\.)/.test(p.handler)) ||
    (p.kind === "step" && /market[-_]?manager|propos/i.test(p.agent.id)),
  isExecutor: (_id, p) =>
    (p.kind === "action" && /^(execution\.|orders?\.|broker\.)/.test(p.handler)) ||
    (p.kind === "step" && /execut/i.test(p.agent.id)),
};

export interface TopologyViolation {
  workflow: string;
  producer: string;
  executor: string;
  path: string[];
}

/** Forward adjacency: dep -> dependents, plus gate -> then/else, awaitSignal -> onTimeout, loop -> onExhausted. */
export function forwardEdges(def: WorkflowDefinition): Map<string, Set<string>> {
  const edges = new Map<string, Set<string>>();
  const add = (from: string, to: string): void => {
    const s = edges.get(from) ?? new Set<string>();
    s.add(to);
    edges.set(from, s);
  };
  for (const [id, p] of Object.entries(def.steps)) {
    for (const dep of p.after ?? []) add(dep, id);
    if (p.kind === "gate") {
      add(id, p.then);
      add(id, p.else);
    }
    if (p.kind === "awaitSignal" && p.onTimeout !== undefined) add(id, p.onTimeout);
    if (p.kind === "loop") add(id, p.onExhausted);
  }
  return edges;
}

/** Every path from a producer to an executor must pass through an awaitSignal. */
export function findApprovalBypasses(
  def: WorkflowDefinition,
  classifier: TopologyClassifier = DEFAULT_CLASSIFIER,
): TopologyViolation[] {
  const violations: TopologyViolation[] = [];
  const edges = forwardEdges(def);
  const steps = def.steps;
  const producers = Object.entries(steps).filter(([id, p]) => classifier.isProducer(id, p)).map(([id]) => id);
  for (const producer of producers) {
    // DFS over paths that have NOT yet crossed an awaitSignal.
    const stack: Array<{ node: string; path: string[] }> = [{ node: producer, path: [producer] }];
    const seen = new Set<string>();
    while (stack.length > 0) {
      const { node, path } = stack.pop() as { node: string; path: string[] };
      for (const next of edges.get(node) ?? []) {
        const p = steps[next];
        if (p === undefined) continue;
        if (p.kind === "awaitSignal") continue; // the gate: paths through it are fine
        if (classifier.isExecutor(next, p)) {
          violations.push({ workflow: def.id, producer, executor: next, path: [...path, next] });
          continue;
        }
        if (seen.has(next)) continue;
        seen.add(next);
        stack.push({ node: next, path: [...path, next] });
      }
    }
  }
  // Recurse into nested bodies (loop / onTrigger / childWorkflow inline).
  for (const p of Object.values(steps)) {
    const body =
      p.kind === "loop"
        ? p.body
        : p.kind === "onTrigger" && "inline" in p.body
          ? p.body.inline
          : p.kind === "childWorkflow" && "inline" in p.definition
            ? p.definition.inline
            : null;
    if (body !== null) violations.push(...findApprovalBypasses(body, classifier));
  }
  return violations;
}

/** Every awaitSignal in the product must carry a timeout and an onTimeout route -- expiry is a branch, never auto-approve. */
export function findUnexpiringGates(def: WorkflowDefinition): string[] {
  const out: string[] = [];
  for (const [id, p] of Object.entries(def.steps)) {
    if (p.kind === "awaitSignal" && (p.timeout === undefined || p.onTimeout === undefined)) out.push(`${def.id}.${id}`);
  }
  return out;
}
