// Child process for the Phase 2 crash test: launches the standing
// tax-year run and SIGKILLs itself the moment ALL EIGHT deadline gates
// are durably parked (SignalAwaited), i.e. with every timer armed and
// nothing fired. Prints JSON lines like the other child fixtures.
//
//   bun taxyear-child.ts <dataDir> <runId> <fireAtJson>

import { buildTaxYearWorkflow } from "@fin/workflows";

import { createApp } from "../../src/app";

const [dataDir, runId, fireAtJson] = process.argv.slice(2);
if (!dataDir || !runId || !fireAtJson) throw new Error("usage: taxyear-child <dataDir> <runId> <fireAtJson>");

const app = createApp({ dataDir, adapters: [], pollMs: 50 });
const emit = (o: Record<string, unknown>): void => {
  process.stdout.write(`${JSON.stringify(o)}\n`);
};

let parked = 0;
void (async () => {
  for await (const entry of app.host.repoStore.subscribe(runId, { from: { seq: 1 }, signal: new AbortController().signal })) {
    const ev = entry.event as { kind: string; stepId?: string };
    if (ev.kind === "SignalAwaited") {
      parked += 1;
      emit({ event: "parked", stepId: ev.stepId ?? null, parked });
      if (parked === 8) {
        emit({ event: "crashing" });
        process.kill(process.pid, "SIGKILL");
      }
    }
    if (ev.kind === "TimerFired") emit({ event: "timer-fired" });
  }
})();

const built = buildTaxYearWorkflow({
  taxYear: 2026,
  now: new Date(),
  fireAt: JSON.parse(fireAtJson) as Record<string, string>,
});
const run = app.host.run(built.definition, { runId, triggerPayload: { run_key: runId, tax_year: 2026 } });
const result = await run.complete;
emit({ event: "done", terminalStatus: result.terminalStatus });
app.close();
process.exit(0);
