// Phase 0 gate (BUILD_PLAN §6, STEPS.md): a filesystem WorkflowRuntimeEnv
// must resume a run that was SIGKILLed while parked at an `awaitSignal`,
// accept the signal after restart, and complete without re-running any
// effect.
//
// Every test drives a REAL child process (`src/spike/cli.ts`) so the kill
// is a real kill -- no in-process "simulated crash". The parent only ever
// observes the child's stdout and the files on disk.

import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { WorkflowEvent } from "@intx/workflow";

import { effectsLogPath } from "../src/spike/toy";

const CLI = path.resolve(import.meta.dir, "../src/spike/cli.ts");

type Line = Record<string, unknown> & { event?: string };

class Child {
  readonly proc: ReturnType<typeof Bun.spawn>;
  readonly lines: Line[] = [];
  private waiters: { pred: (l: Line) => boolean; resolve: (l: Line) => void }[] = [];
  private stdoutDone: Promise<void>;

  constructor(args: string[]) {
    this.proc = Bun.spawn(["bun", CLI, ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    this.stdoutDone = this.pump();
  }

  private async pump(): Promise<void> {
    const reader = (this.proc.stdout as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (raw.trim() === "") continue;
        const line = JSON.parse(raw) as Line;
        this.lines.push(line);
        this.waiters = this.waiters.filter((w) => {
          if (w.pred(line)) {
            w.resolve(line);
            return false;
          }
          return true;
        });
      }
    }
  }

  waitFor(pred: (l: Line) => boolean, timeoutMs = 15_000): Promise<Line> {
    const existing = this.lines.find(pred);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        reject(
          new Error(
            `timed out waiting for child line; saw: ${JSON.stringify(this.lines)}`,
          ),
        );
      }, timeoutMs);
      this.waiters.push({
        pred,
        resolve: (l) => {
          clearTimeout(t);
          resolve(l);
        },
      });
    });
  }

  async stderrText(): Promise<string> {
    return new Response(this.proc.stderr as ReadableStream).text();
  }

  kill9(): void {
    this.proc.kill("SIGKILL");
  }

  async exited(): Promise<number> {
    const code = await this.proc.exited;
    await this.stdoutDone;
    return code;
  }
}

function freshDataDir(tag: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `fin-phase0-${tag}-`));
}

function readLog(dataDir: string, runId: string): WorkflowEvent[] {
  const file = path.join(dataDir, "runs", runId, "events.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as WorkflowEvent);
}

function effectLines(dataDir: string): string[] {
  const file = effectsLogPath(dataDir);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "");
}

function kinds(events: readonly WorkflowEvent[]): string[] {
  return events.map((e) => e.kind);
}

const children: Child[] = [];
function spawn(args: string[]): Child {
  const c = new Child(args);
  children.push(c);
  return c;
}
afterEach(() => {
  for (const c of children) {
    try {
      c.proc.kill("SIGKILL");
    } catch {
      // already gone
    }
  }
  children.length = 0;
});

async function deliver(
  dataDir: string,
  runId: string,
  signalId: string,
  payload: unknown,
): Promise<void> {
  const d = spawn(["deliver", dataDir, runId, signalId, JSON.stringify(payload)]);
  await d.waitFor((l) => l.event === "delivered");
  expect(await d.exited()).toBe(0);
}

describe("Phase 0 gate: crash-resume across a parked awaitSignal", () => {
  test("SIGKILL while parked -> restart -> deliver -> completes, every effect exactly once", async () => {
    const dataDir = freshDataDir("park");
    const runId = "run-park";
    const payload = { order: "toy-1" };

    // 1. Fresh run to the park.
    const p1 = spawn(["run", dataDir, runId, "toy", JSON.stringify(payload)]);
    await p1.waitFor((l) => l.event === "fresh");
    await p1.waitFor((l) => l.event === "parked" && l.kind === "SignalAwaited");

    // The park is durable on disk, and the pre-park effect ran once.
    const parkedLog = readLog(dataDir, runId);
    expect(kinds(parkedLog).at(-1)).toBe("SignalAwaited");
    expect(kinds(parkedLog)).toContain("StepCompleted");
    expect(effectLines(dataDir)).toEqual([`prepare ${JSON.stringify(payload)}`]);

    // 2. Kill it dead. No cleanup, no flush, no goodbye.
    p1.kill9();
    expect(await p1.exited()).not.toBe(0);
    // Nothing changed on disk because of the kill.
    expect(readLog(dataDir, runId)).toEqual(parkedLog);

    // 3. Restart the host for the same run. It must adopt the log and re-park.
    const p2 = spawn(["run", dataDir, runId, "toy", JSON.stringify({ order: "IGNORED" })]);
    await p2.waitFor((l) => l.event === "resumed");
    // Give the runtime a moment to re-park: it must NOT complete, and must
    // NOT re-run `prepare`.
    await new Promise((r) => setTimeout(r, 300));
    expect(p2.lines.find((l) => l.event === "done")).toBeUndefined();
    expect(p2.lines.find((l) => l.event === "error")).toBeUndefined();
    expect(effectLines(dataDir)).toEqual([`prepare ${JSON.stringify(payload)}`]);

    // 4. Deliver the approval from a DIFFERENT process (the GUI's path).
    const approval = { approved: true, by: "bfox", note: "phase 0" };
    await deliver(dataDir, runId, "approve-1", approval);

    // 5. The resumed run completes with the approval flowing into `finish`.
    const done = await p2.waitFor((l) => l.event === "done");
    expect(done.terminalStatus).toBe("completed");
    const outputs = done.outputs as Record<string, unknown>;
    expect(outputs.finish).toEqual({ finished: true, approval });
    expect(outputs.prepare).toEqual({ prepared: true, input: payload });
    expect(outputs.approve).toEqual(approval);
    expect(await p2.exited()).toBe(0);

    // 6. Exactly-once: one prepare, one finish, one SignalReceived, one
    //    StepCompleted per step, one RunCompleted.
    expect(effectLines(dataDir)).toEqual([
      `prepare ${JSON.stringify(payload)}`,
      `finish ${JSON.stringify(approval)}`,
    ]);
    const finalLog = readLog(dataDir, runId);
    const k = kinds(finalLog);
    expect(k.filter((x) => x === "SignalReceived")).toHaveLength(1);
    expect(k.filter((x) => x === "RunCompleted")).toHaveLength(1);
    expect(k.filter((x) => x === "RunStarted")).toHaveLength(1);
    expect(
      finalLog.filter((e) => e.kind === "StepCompleted").map((e) => e.stepId),
    ).toEqual(["prepare", "approve", "finish"]);
    // The resumed log is a strict extension of the parked log.
    expect(finalLog.slice(0, parkedLog.length)).toEqual(parkedLog);
  }, 30_000);

  test("signal delivered while the host is DOWN is consumed on restart", async () => {
    const dataDir = freshDataDir("offline");
    const runId = "run-offline";
    const p1 = spawn(["run", dataDir, runId, "toy"]);
    await p1.waitFor((l) => l.event === "parked");
    p1.kill9();
    await p1.exited();

    // No host process exists. Deliver anyway.
    const approval = { approved: true, while: "offline" };
    await deliver(dataDir, runId, "approve-offline", approval);
    expect(fs.readdirSync(path.join(dataDir, "runs", runId, "inbox"))).toHaveLength(1);

    const p2 = spawn(["run", dataDir, runId, "toy"]);
    const done = await p2.waitFor((l) => l.event === "done");
    expect(done.terminalStatus).toBe("completed");
    expect((done.outputs as Record<string, unknown>).finish).toEqual({
      finished: true,
      approval,
    });
    expect(await p2.exited()).toBe(0);
    expect(effectLines(dataDir)).toHaveLength(2);
  }, 30_000);

  test("the same signalId delivered twice produces exactly one SignalReceived (double-click safety)", async () => {
    const dataDir = freshDataDir("dedup");
    const runId = "run-dedup";
    const p1 = spawn(["run", dataDir, runId, "toy"]);
    await p1.waitFor((l) => l.event === "parked");

    await deliver(dataDir, runId, "approve-once", { approved: true, n: 1 });
    await deliver(dataDir, runId, "approve-once", { approved: true, n: 2 });

    const done = await p1.waitFor((l) => l.event === "done");
    expect(done.terminalStatus).toBe("completed");
    expect(await p1.exited()).toBe(0);
    const k = kinds(readLog(dataDir, runId));
    expect(k.filter((x) => x === "SignalReceived")).toHaveLength(1);
    expect(effectLines(dataDir)).toHaveLength(2);
  }, 30_000);

  test("a run killed twice (parked, restarted, parked again, killed) still completes on the third host", async () => {
    const dataDir = freshDataDir("twice");
    const runId = "run-twice";
    const p1 = spawn(["run", dataDir, runId, "toy"]);
    await p1.waitFor((l) => l.event === "parked");
    p1.kill9();
    await p1.exited();

    const p2 = spawn(["run", dataDir, runId, "toy"]);
    await p2.waitFor((l) => l.event === "resumed");
    await new Promise((r) => setTimeout(r, 300));
    p2.kill9();
    await p2.exited();
    const logAfterSecondKill = readLog(dataDir, runId);
    expect(kinds(logAfterSecondKill).at(-1)).toBe("SignalAwaited");

    const p3 = spawn(["run", dataDir, runId, "toy"]);
    await p3.waitFor((l) => l.event === "resumed");
    await deliver(dataDir, runId, "approve-3", { approved: true });
    const done = await p3.waitFor((l) => l.event === "done");
    expect(done.terminalStatus).toBe("completed");
    expect(await p3.exited()).toBe(0);
    expect(effectLines(dataDir)).toHaveLength(2);
    expect(kinds(readLog(dataDir, runId)).filter((x) => x === "SignalReceived")).toHaveLength(1);
  }, 30_000);
});

describe("Documented limit at the pinned framework version (DECISIONS.md D-006)", () => {
  test("a `sleep` parked across a restart is NOT resumable: the runtime refuses with RuntimeResumeUnsupportedError", async () => {
    const dataDir = freshDataDir("sleep");
    const runId = "run-sleep";
    const p1 = spawn(["run", dataDir, runId, "sleep"]);
    await p1.waitFor((l) => l.event === "parked" && l.kind === "TimerSet");
    p1.kill9();
    await p1.exited();

    const p2 = spawn(["run", dataDir, runId, "sleep"]);
    await p2.waitFor((l) => l.event === "resumed");
    const outcome = await p2.waitFor((l) => l.event === "error" || l.event === "done");
    // If this assertion ever FAILS because the run completes, the framework
    // has grown sleep-resume and D-006 must be revisited (that is good news).
    expect(outcome.event).toBe("error");
    expect(String(outcome.name)).toBe("RuntimeResumeUnsupportedError");
    expect(await p2.exited()).not.toBe(0);
    // And critically: the refusal did not re-run the pre-sleep effect.
    expect(effectLines(dataDir)).toHaveLength(1);
  }, 30_000);
});
