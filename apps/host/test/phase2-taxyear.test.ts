// Phase 2 host-level acceptance: the property everything rests on is
// that a DEADLINE parked in a timed `awaitSignal` gate survives the host
// dying -- the September 15 timer must fire even though the process that
// armed it is gone (D-006/D-014). Run through fin-host proper: real
// processes, SIGKILL, restart, durable inbox.

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { fixtureAdapter } from "@fin/institutions";
import { views } from "@fin/ledger";
import { skipSignalId, deadlineSignal } from "@fin/workflows";

import { createApp, type App } from "../src/app";
import { taxAccounts, writeTaxProfile } from "./fixtures/tax-fixture";

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "fin-p2-"));

const openApp = (dataDir: string): App => createApp({ dataDir, adapters: [], pollMs: 20 });

async function until<T>(what: string, ms: number, poll: () => Promise<T | null> | T | null): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await poll();
    if (v !== null) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("phase 2 through fin-host: deadlines survive the host dying", () => {
  test("SIGKILL with all eight gates parked; restart re-arms; the deadline fires and the check lands exactly once; skips delivered while down are consumed", async () => {
    const dataDir = tmp();
    writeTaxProfile(dataDir);
    // Seed the ledger with a nightly so the estimate has facts to cite.
    const seed = createApp({ dataDir, adapters: [fixtureAdapter("inst.bank", { accounts: taxAccounts(new Date()) })], pollMs: 20 });
    const n = await seed.runNightly({ runId: "nightly_seed" });
    expect(n.terminalStatus).toBe("completed");
    seed.close();

    // The child parks all eight gates (q3-due timer 2.5s out, the rest
    // hours-to-days out) and SIGKILLs itself before anything fires.
    const runId = "taxyear2026_crash";
    const soon = new Date(Date.now() + 2_500).toISOString();
    const hours = (h: number): string => new Date(Date.now() + h * 3_600_000).toISOString();
    const fireAt = { q1: hours(2), q1_pre: hours(2), q2: hours(3), q2_pre: hours(3), q3: soon, q3_pre: hours(4), q4: hours(5), q4_pre: hours(5) };
    const child = Bun.spawn(["bun", path.join(import.meta.dir, "fixtures/taxyear-child.ts"), dataDir, runId, JSON.stringify(fireAt)], { stdout: "pipe", stderr: "pipe" });
    const out = await new Response(child.stdout).text();
    expect(await child.exited).not.toBe(0);
    const lines = out.trim().split("\n").map((l) => JSON.parse(l) as { event: string });
    expect(lines.filter((l) => l.event === "parked")).toHaveLength(8);
    expect(lines.some((l) => l.event === "crashing")).toBe(true);
    expect(lines.some((l) => l.event === "timer-fired")).toBe(false);
    expect(lines.some((l) => l.event === "done")).toBe(false);

    // Restart (a fresh process -- a run has one driver at a time). The
    // run re-parks; the q3-due timer re-arms from its durable TimerSet
    // and fires in the NEW process; the check chain runs; the child
    // exits with the run still standing.
    const restart1 = Bun.spawn(["bun", path.join(import.meta.dir, "fixtures/resume-child.ts"), dataDir, runId, "until-obligation"], { stdout: "pipe", stderr: "pipe" });
    const out1 = await new Response(restart1.stdout).text();
    expect(await restart1.exited).toBe(0);
    expect(out1).toContain('"event":"done"');
    expect(out1).toContain(`${runId}:running`);

    // Inspect the ledger and log from the outside (no driver).
    const app2 = openApp(dataDir);
    const ob = views.obligations(app2.ledger).find((o) => o.key === "q3");
    expect(ob).toBeDefined();
    expect(ob!.amount).toBe("6000.00");
    expect(ob!.due).toBe("2026-09-15");
    // Exactly once: one obligation head, one liabilities batch for the stem.
    expect(app2.ledger.history(ob!.fact_id)).toHaveLength(1);
    expect(app2.ledger.listBatches().filter((b) => b.id.includes("tax.q3.due"))).toHaveLength(1);
    // Covered by reserve: confirm branch journaled, deadline item queued.
    expect(app2.ledger.listJournal().some((j) => j.summary.includes("covered by reserve"))).toBe(true);
    expect(app2.ledger.openFindings({ requiresHuman: true }).some((f) => f.code === "estimated_tax_due")).toBe(true);
    // The run is still standing: seven gates remain parked.
    expect((await app2.listRuns()).find((r) => r.runId === runId)?.status).toBe("running");
    const status = await app2.taxStatus();
    expect(status.runId).toBe(runId);
    expect(status.quarters[2]!.due_stage.state).toBe("ran");
    expect(status.quarters[2]!.due_stage.covered).toBe(true);

    // Deliver the seven remaining skips into the durable inbox with NO
    // host driving the run -- approval-while-down, Phase 0's property,
    // now for deadlines. One is delivered twice: signalId dedupe.
    for (const [q, stage] of [[1, "pre"], [1, "due"], [2, "pre"], [2, "due"], [3, "pre"], [4, "pre"], [4, "due"]] as const) {
      app2.host.deliver(runId, deadlineSignal(q, stage), { note: "handled offline", decided_by: "test" }, skipSignalId(2026, q, stage));
    }
    app2.host.deliver(runId, deadlineSignal(4, "due"), { note: "again", decided_by: "test" }, skipSignalId(2026, 4, "due"));
    app2.close();

    // Restart again: the inbox replays, every gate consumes its skip, the
    // standing run completes.
    const restart2 = Bun.spawn(["bun", path.join(import.meta.dir, "fixtures/resume-child.ts"), dataDir, runId, "until-complete"], { stdout: "pipe", stderr: "pipe" });
    const out2 = await new Response(restart2.stdout).text();
    expect(await restart2.exited).toBe(0);
    expect(out2).toContain('"event":"done"');

    const app3 = openApp(dataDir);
    expect((await app3.listRuns()).find((r) => r.runId === runId)?.status).toBe("completed");
    const skips = app3.ledger.listJournal().filter((j) => j.summary.includes("deadline check skipped"));
    expect(skips).toHaveLength(7); // the duplicate delivery journaled once
    // The q3 obligation is untouched by the skips.
    expect(app3.ledger.history(ob!.fact_id)).toHaveLength(1);
    app3.close();
  }, 90_000);

  test("a deadline months out does not fire early: long delays are chunked past the setTimeout clamp", async () => {
    const dataDir = tmp();
    writeTaxProfile(dataDir);
    const app = openApp(dataDir);
    // All eight gates >= 30 days out -- beyond the 2^31-1 ms setTimeout
    // clamp (~24.8 days). Without chunking, the clamp fires them ~now.
    const days = (d: number): string => new Date(Date.now() + d * 86_400_000).toISOString();
    const far = { q1: days(30), q1_pre: days(31), q2: days(40), q2_pre: days(41), q3: days(50), q3_pre: days(51), q4: days(60), q4_pre: days(61) };
    const { runId } = await app.startTaxYear({ fireAt: far });
    await until("all gates parked", 10_000, async () => {
      const events = await app.runEvents(runId);
      return events.filter((e) => e.kind === "SignalAwaited").length === 8 ? true : null;
    });
    // A second standing run for the same year is refused.
    await expect(app.startTaxYear({ fireAt: far })).rejects.toThrow(/already standing/);
    // Give a clamped timer ample time to misfire, then assert none did.
    await new Promise((r) => setTimeout(r, 500));
    const events = await app.runEvents(runId);
    expect(events.filter((e) => e.kind === "TimerSet")).toHaveLength(8);
    expect(events.filter((e) => e.kind === "TimerFired")).toHaveLength(0);
    expect(events.filter((e) => e.kind === "StepStarted" && /^est_/.test((e as { stepId?: string }).stepId ?? ""))).toHaveLength(0);
    app.close();
  }, 30_000);
});
