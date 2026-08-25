// Child process for the Phase 1 crash test: runs one nightly against
// fixture institutions and SIGKILLs itself the moment `<crashAt>` step's
// StepStarted is durable. Prints JSON lines like the Phase 0 spike.
//
//   bun nightly-child.ts <dataDir> <runId> <night:1|2> [crashAtStepId]

import { fixtureAdapter } from "@fin/institutions";

import { createApp } from "../../src/app";
import { demoAdapters, demoClock } from "./demo-adapters";

const [dataDir, runId, nightArg, crashAt] = process.argv.slice(2);
if (!dataDir || !runId) throw new Error("usage: nightly-child <dataDir> <runId> <night> [crashAt]");
const night = nightArg === "2" ? 2 : 1;
const app = createApp({ dataDir, adapters: demoAdapters(night).map((a) => fixtureAdapter(a.id, a.snapshot)), pollMs: 50, clock: demoClock(night) });

const emit = (o: Record<string, unknown>): void => {
  process.stdout.write(`${JSON.stringify(o)}\n`);
};

// Subscribe BEFORE the run starts, from seq 1, so every durable event is seen.
if (crashAt !== undefined) {
  void (async () => {
    for await (const entry of app.host.repoStore.subscribe(runId, { from: { seq: 1 }, signal: new AbortController().signal })) {
      const ev = entry.event as { kind: string; stepId?: string };
      emit({ event: "log", kind: ev.kind, stepId: ev.stepId ?? null });
      if (ev.kind === "StepStarted" && ev.stepId === crashAt) {
        emit({ event: "crashing", stepId: crashAt });
        process.kill(process.pid, "SIGKILL");
      }
    }
  })();
}
const run = app.host.run((await import("@fin/workflows")).nightlyWorkflow, { runId, triggerPayload: { run_key: runId } });
const result = await run.complete;
emit({ event: "done", terminalStatus: result.terminalStatus });
app.close();
process.exit(0);
