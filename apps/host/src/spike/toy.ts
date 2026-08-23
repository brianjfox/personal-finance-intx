// Phase 0 toy workflows.
//
// `toyWorkflow` is the three-step spike from BUILD_PLAN §6 Phase 0:
//     action (prepare) -> awaitSignal (approve) -> action (finish)
// Both actions perform exactly one external effect through
// `EffectContext.perform` -- appending a line to an effects log -- so a
// crash-resume that re-ran either would be visible as a duplicate line.
//
// `sleepWorkflow` exists only to document, as a test, that a `sleep`
// parked across a restart is NOT resumable at the pinned framework
// version (DECISIONS.md D-006).

import fs from "node:fs";
import path from "node:path";

import { action, awaitSignal, defineWorkflow, sleep } from "@intx/workflow";

import type { ActionHandler } from "../fs-host/index";

export const toyWorkflow = defineWorkflow({
  id: "phase0-toy",
  trigger: { type: "manual" },
  steps: {
    prepare: action({
      handler: "spike.prepare",
      input: { from: "trigger.payload" },
      effect: { requires: ["spike.write"] },
    }),
    approve: awaitSignal({ name: "approve", after: ["prepare"] }),
    finish: action({
      handler: "spike.finish",
      input: { from: "steps.approve.output" },
      effect: { requires: ["spike.write"] },
      after: ["approve"],
    }),
  },
});

export const sleepWorkflow = defineWorkflow({
  id: "phase0-sleep",
  trigger: { type: "manual" },
  steps: {
    prepare: action({
      handler: "spike.prepare",
      input: { from: "trigger.payload" },
      effect: { requires: ["spike.write"] },
    }),
    nap: sleep({ duration: 60_000, after: ["prepare"] }),
    finish: action({
      handler: "spike.finish",
      input: { from: "trigger.payload" },
      effect: { requires: ["spike.write"] },
      after: ["nap"],
    }),
  },
});

export function effectsLogPath(dataDir: string): string {
  return path.join(dataDir, "spike-effects.log");
}

export function toyActions(dataDir: string): Record<string, ActionHandler> {
  const logFile = effectsLogPath(dataDir);
  const appendLine = (line: string): void => {
    fs.appendFileSync(logFile, `${line}\n`);
  };
  return {
    "spike.prepare": async (input, ctx) => {
      const result = await ctx.perform({
        effectId: "prepare",
        capability: "spike.write",
        run: async () => {
          appendLine(`prepare ${JSON.stringify(input)}`);
          return { prepared: true, input };
        },
      });
      return result;
    },
    "spike.finish": async (input, ctx) => {
      const result = await ctx.perform({
        effectId: "finish",
        capability: "spike.write",
        run: async () => {
          appendLine(`finish ${JSON.stringify(input)}`);
          return { finished: true, approval: input };
        },
      });
      return result;
    },
  };
}
