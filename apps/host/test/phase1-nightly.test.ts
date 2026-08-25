// Phase 1 acceptance (BUILD_PLAN §6): two institutions reconcile nightly;
// an injected duplicate transfer is caught and queued rather than silently
// absorbed; observed_at history survives a corrected statement; downstream
// refuses to run on provisional data. Run here through fin-host proper
// (fs-host + policy + real ledger on disk), not runLocal.

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { fixtureAdapter } from "@fin/institutions";
import { resolveFinding, views } from "@fin/ledger";

import { createApp } from "../src/app";
import { demoAdapters, demoClock } from "./fixtures/demo-adapters";

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "fin-p1-"));
const adaptersFor = (night: 1 | 2 | 3) => demoAdapters(night).map((a) => fixtureAdapter(a.id, a.snapshot));

describe("phase 1 acceptance through fin-host", () => {
  test("clean -> held (duplicate queued) -> resolved -> clean again", async () => {
    const dataDir = tmp();
    let night: 1 | 2 | 3 = 1;
    const app = createApp({ dataDir, adapters: adaptersFor(1), pollMs: 20, clock: demoClock(1) });
    // swap adapters between nights by recreating the app over the same data dir
    const run = async (n: 1 | 2 | 3) => {
      night = n;
      const a = createApp({ dataDir, adapters: adaptersFor(night), pollMs: 20, clock: demoClock(night) });
      const r = await a.runNightly({ runId: `nightly_t${String(n)}` });
      const summary = (await a.listRuns()).find((x) => x.runId === r.runId)!;
      a.close();
      return { r, summary };
    };
    app.close();

    const n1 = await run(1);
    expect(n1.r.terminalStatus).toBe("completed");
    expect(n1.summary.steps["notify"]?.status).toBe("completed");
    expect(n1.summary.steps["hold"]?.status).toBe("skipped");

    const n2 = await run(2);
    expect(n2.r.terminalStatus).toBe("completed");
    expect(n2.summary.steps["notify"]?.status).toBe("skipped");
    expect(n2.summary.steps["hold"]?.status).toBe("completed");

    const check = createApp({ dataDir, adapters: [], pollMs: 20 });
    const queue = check.ledger.openFindings({ requiresHuman: true });
    expect(queue.map((f) => f.code)).toEqual(["duplicate_transaction"]);
    expect(check.ledger.isProvisional("acct.bank.checking")).toBe(true);
    expect(views.netWorth(check.ledger).provisional).toBe(true);
    // Facts for the night are in the ledger (not absorbed, not dropped) -- provisional.
    expect(check.ledger.getFact(queue[0]!.after[0]!)?.provisional).toBe(true);
    // Both versions: the ledger's copy and the incoming duplicate.
    expect(queue[0]!.before).toHaveLength(1);
    expect(queue[0]!.after).toHaveLength(1);
    // The operator answers: the second booking is not real.
    resolveFinding(check.ledger, { findingId: queue[0]!.id, decision: "keep_prior", note: "aggregator duplicate", decidedBy: "test", decidedAt: new Date().toISOString() });
    expect(check.ledger.isProvisional("acct.bank.checking")).toBe(false);
    expect(check.ledger.openFindings({ requiresHuman: true })).toHaveLength(0);
    // access log has policy decisions per step principal; no denials
    const log = check.ledger.listAccess(1000);
    expect(log.some((e) => e.action === "denied")).toBe(false);
    expect(log.filter((e) => e.step_id === "commit_flows").every((e) => e.principal === "cash_flow")).toBe(true);
    check.close();

    const n3 = await run(3);
    expect(n3.summary.steps["notify"]?.status).toBe("completed");
    const end = createApp({ dataDir, adapters: [], pollMs: 20 });
    expect(end.ledger.eventsSince(0).map((e) => e.kind).filter((k) => k.startsWith("nightly"))).toEqual(["nightly.clean", "nightly.held", "nightly.clean"]);
    expect((await end.listRuns()).map((r) => r.status)).toEqual(["completed", "completed", "completed"]);
    end.close();
  }, 30_000);

  test("crash mid-nightly (SIGKILL while a commit is in flight): restart settles the run, nothing is double-committed, the next nightly is clean", async () => {
    const dataDir = tmp();
    const runId = "nightly_crash1";
    const child = Bun.spawn(["bun", path.join(import.meta.dir, "fixtures/nightly-child.ts"), dataDir, runId, "1", "commit_flows"], { stdout: "pipe", stderr: "pipe" });
    const out = await new Response(child.stdout).text();
    const code = await child.exited;
    const lines = out.trim().split("\n").map((l) => JSON.parse(l) as { event: string; kind?: string; stepId?: string | null });
    expect(lines.some((l) => l.event === "crashing")).toBe(true);
    expect(lines.some((l) => l.event === "done")).toBe(false);
    expect(code).not.toBe(0);

    // Restart the host over the same data dir: resume what was in flight.
    const app = createApp({ dataDir, adapters: adaptersFor(1), pollMs: 20, clock: demoClock(1) });
    const resumed = await app.resumeInFlight();
    expect(resumed.map((r) => r.runId)).toEqual([runId]);
    // At the pinned framework version an action left in-flight is settled as
    // failed on resume (at-most-once), so the crashed run fails -- loudly, in
    // the log -- rather than re-invoking commit_flows. (DECISIONS.md D-012)
    expect(resumed[0]!.status).toBe("failed");
    expect(resumed[0]!.steps["commit_flows"]?.status).toBe("failed");
    expect(resumed[0]!.steps["commit_assets"]?.status).toBe("completed");
    // The assets batch landed exactly once; flows never landed.
    const batches = app.ledger.listBatches();
    expect(batches.map((b) => b.writer)).toEqual(["assets_manager"]);
    expect(batches[0]!.id).toBe(`${runId}:assets_manager`);
    const factsBefore = app.ledger.factCount();

    // A fresh nightly completes; transactions from the crashed night are new (flows never committed), assets are new observations.
    const r = await app.runNightly({ runId: "nightly_after_crash" });
    expect(r.terminalStatus).toBe("completed");
    expect(app.ledger.factCount()).toBeGreaterThan(factsBefore);
    expect(app.ledger.listBatches().map((b) => b.writer).sort()).toEqual(["assets_manager", "assets_manager", "cash_flow"]);
    expect(app.ledger.openFindings({ requiresHuman: true })).toHaveLength(0);
    // Every transaction appears once in the current view.
    const txns = views.transactions(app.ledger);
    expect(new Set(txns.map((t) => t.key)).size).toBe(txns.length);
    expect(txns).toHaveLength(3);
    app.close();
  }, 30_000);
});
