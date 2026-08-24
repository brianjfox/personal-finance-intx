// Child process for the Phase 2 tests: a "restarted host". Resumes every
// in-flight run and waits for a condition, then exits -- killing its
// standing runs the way a real host shutdown does (they stay parked on
// disk).
//
//   bun resume-child.ts <dataDir> <runId> until-obligation   wait for the q3 obligation + tax.ready
//   bun resume-child.ts <dataDir> <runId> until-complete     wait for the run to complete

import { views } from "@fin/ledger";

import { createApp } from "../../src/app";

const [dataDir, runId, mode] = process.argv.slice(2);
if (!dataDir || !runId || (mode !== "until-obligation" && mode !== "until-complete")) {
  throw new Error("usage: resume-child <dataDir> <runId> <until-obligation|until-complete>");
}

const app = createApp({ dataDir, adapters: [], pollMs: 20 });
const resumed = await app.resumeInFlight();
process.stdout.write(`${JSON.stringify({ event: "resumed", runs: resumed.map((r) => `${r.runId}:${r.status}`) })}\n`);

const deadline = Date.now() + 20_000;
for (;;) {
  if (Date.now() > deadline) {
    process.stdout.write(`${JSON.stringify({ event: "timeout" })}\n`);
    process.exit(3);
  }
  if (mode === "until-obligation") {
    const ob = views.obligations(app.ledger).find((o) => o.key === "q3");
    const ready = app.ledger.eventsSince(0).some((e) => e.kind === "tax.ready");
    // Exit only once the chain's completion is DURABLE in the run log
    // (the fs-host interval flush, D-017) -- exiting earlier would model
    // a crash mid-chain, which D-012 rightly settles as failed.
    const durable = (await app.runEvents(runId)).some(
      (e) => e.kind === "StepCompleted" && (e as { stepId?: string }).stepId === "ok_q3_due",
    );
    if (ob !== undefined && ready && durable) break;
  } else {
    const run = (await app.listRuns()).find((r) => r.runId === runId);
    if (run?.status === "completed") break;
  }
  await new Promise((r) => setTimeout(r, 50));
}
process.stdout.write(`${JSON.stringify({ event: "done" })}\n`);
app.close();
process.exit(0);
