// Phase 3 acceptance through fin-host (BUILD_PLAN §6): the slide-19
// question -- "If I sell the rental next spring, what does that do to
// the Q2 estimate and the trust schedule?" -- answered with every
// figure a clickable ledger fact and the thesis landing in the journal.
//
// The model is a scripted stand-in (the invoker's documented
// agentFactory seam); everything downstream is real: the unbounded chat
// step and its input parks, the tool bundles against the live ledger,
// authorization through the policy matrix under the step's principal,
// evidence/journal capture, the durable ChatTurn transcript, and
// crash-resume of a conversation parked mid-life. The live-model
// variant of the same question is phase3-chat-live.test.ts, gated on
// ANTHROPIC_API_KEY.

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { InferenceSource } from "@intx/types/runtime";

import { createApp, type App } from "../src/app";
import { phase3Adapters, RENTAL, writePhase3Config } from "./fixtures/phase3-fixture";
import { scriptedAgentFactory } from "./fixtures/scripted-agent";

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "fin-p3-"));
const stubSource = (): InferenceSource => ({ id: "stub", provider: "anthropic", baseURL: "http://localhost:1", apiKey: "stub", model: "stub" });

const openApp = (dataDir: string): App =>
  createApp({
    dataDir,
    adapters: phase3Adapters(new Date()),
    pollMs: 20,
    agentFactory: scriptedAgentFactory(),
    inferenceSource: stubSource,
  });

describe("phase 3 through fin-host: the strategist chat over real tools", () => {
  test("a chat with no inference source fails fast with the step's own message, not a long timeout", async () => {
    const dataDir = tmp();
    const app = createApp({
      dataDir,
      adapters: [],
      pollMs: 20,
      inferenceSource: () => {
        throw new Error("fin-host: ANTHROPIC_API_KEY is not set (test)");
      },
    });
    try {
      const started = Date.now();
      expect(app.sendChat({ agent: "strategist", text: "hello", timeoutMs: 60_000 })).rejects.toThrow(/ANTHROPIC_API_KEY is not set/);
      await app.sendChat({ agent: "strategist", text: "hello", timeoutMs: 60_000 }).catch(() => {});
      // The run died instantly; the wait must not burn the 60s timeout.
      expect(Date.now() - started).toBeLessThan(20_000);
    } finally {
      app.close();
    }
  });

  test("the slide-19 scenario: figures from tools, facts clickable, thesis journaled; policy refuses cross-agent tools", async () => {
    const dataDir = tmp();
    writePhase3Config(dataDir);
    const app = openApp(dataDir);
    expect((await app.runNightly({ runId: "nightly_p3" })).terminalStatus).toBe("completed");
    expect((await app.runEstateAudit()).terminalStatus).toBe("completed");
    // The registry synced observed titling into facts; the plan's unlinked
    // will is the one hygiene finding.
    expect(app.ledger.asOf({ kind: "titling", subject: RENTAL })).toHaveLength(1);
    expect(app.ledger.openFindings({ requiresHuman: true }).map((f) => f.code)).toEqual(["estate_doc_missing"]);

    // --- the acceptance question, scripted protocol ---------------------
    const r = await app.sendChat({ agent: "strategist", text: `sell ${RENTAL} 2027-04-20 basis 300000 dep 80000`, wait: true });
    const turn = r.turn!;
    // The figures in the reply came from run_scenario (hand-computed in
    // the projections tests): 35,000 total tax, Q2 installment unchanged
    // under the prior-year safe harbour, and the trust schedule flagged.
    expect(turn.reply).toContain("total tax 35000.00");
    expect(turn.reply).toContain("Q2 installment moves by 0.00");
    expect(turn.reply).toContain("the asset sits in ent.trust");
    // Evidence: the scenario's tool result, carrying the fact ids -- and
    // every one of them resolves to a real ledger fact (clickable).
    expect(turn.evidence).toHaveLength(1);
    expect(turn.evidence[0]!.tool).toBe("run_scenario");
    const factIds = turn.evidence[0]!.fact_ids;
    expect(factIds.length).toBeGreaterThanOrEqual(7);
    for (const id of factIds) expect(app.ledger.getFact(id)).not.toBeNull();
    // The thesis landed in the journal, authored by the strategist, with refs.
    expect(turn.journal_ids).toHaveLength(1);
    const entry = app.ledger.listJournal().find((j) => j.id === turn.journal_ids[0]);
    expect(entry?.author).toBe("strategist");
    expect(entry?.kind).toBe("decision");
    expect(entry?.summary).toContain("total tax 35000.00");
    expect(entry?.refs.length).toBeGreaterThan(0);
    for (const ref of entry?.refs ?? []) expect(app.ledger.getFact(ref)).not.toBeNull();

    // --- second turn rides the input park ------------------------------
    const r2 = await app.sendChat({ agent: "strategist", text: "aggregates", wait: true });
    expect(r2.turn!.reply).toContain("Net worth is");
    expect(r2.turn!.evidence[0]!.tool).toBe("ledger_read_aggregates");
    const transcript = app.chatTranscript("strategist");
    expect(transcript.map((t) => t.message_id)).toEqual([r.message_id, r2.message_id]);

    // --- the estate planner's chat, and the policy boundary -------------
    const e1 = await app.sendChat({ agent: "estate_planner", text: "registry", wait: true });
    expect(e1.turn!.reply).toContain("2 entities");
    expect(e1.turn!.reply).toContain("3 observed titlings");
    // journal_write belongs to the strategist; the estate planner's call
    // is refused by the matrix, through the same authorize the reactor uses.
    const e2 = await app.sendChat({ agent: "estate_planner", text: "journal should not work", wait: true });
    expect(e2.turn!.reply).toContain("refused by policy");
    expect(app.ledger.listJournal().every((j) => j.author !== "estate_planner")).toBe(true);

    // --- the ledger analyst's chat: line items the strategist cannot see -
    const a1 = await app.sendChat({ agent: "ledger_analyst", text: "transactions payroll", wait: true });
    expect(a1.turn!.reply).toContain("5 transactions matched; USD inflow 40000, outflow 0; newest: PAYROLL 8000 on Checking");
    expect(a1.turn!.evidence[0]!.tool).toBe("transactions_query");
    expect(a1.turn!.evidence[0]!.fact_ids).toHaveLength(5);
    for (const id of a1.turn!.evidence[0]!.fact_ids) expect(app.ledger.getFact(id)?.kind).toBe("transaction");
    const a2 = await app.sendChat({ agent: "ledger_analyst", text: "recurring", wait: true });
    expect(a2.turn!.reply).toContain("payroll monthly 8000 x5 next 2027-06-14");
    const a3 = await app.sendChat({ agent: "ledger_analyst", text: "spend by month", wait: true });
    expect(a3.turn!.reply).toContain("2027-01=8000/0(1)");
    // It writes nothing: the journal is the strategist's, and the matrix refuses.
    const a4 = await app.sendChat({ agent: "ledger_analyst", text: "journal should not work", wait: true });
    expect(a4.turn!.reply).toContain("refused by policy");
    expect(app.ledger.listJournal().every((j) => j.author !== "ledger_analyst")).toBe(true);
    // The strategist's transaction-blind tool set is unchanged by the analyst's existence.
    const s3 = await app.sendChat({ agent: "strategist", text: "transactions payroll", wait: true });
    expect(s3.turn!.reply).toContain("refused by policy");
    expect(app.chatTranscript("ledger_analyst")).toHaveLength(4);
    expect(app.chatTranscript("strategist")).toHaveLength(3);

    // Chat runs are standing runs.
    expect((await app.listRuns()).filter((x) => x.workflow.endsWith("-chat")).every((x) => x.status === "running")).toBe(true);
    app.close();
  }, 60_000);

  test("a conversation SIGKILLed while parked between turns resumes: the next message is the next turn", async () => {
    const dataDir = tmp();
    writePhase3Config(dataDir);
    const seed = openApp(dataDir);
    expect((await seed.runNightly({ runId: "nightly_p3c" })).terminalStatus).toBe("completed");
    seed.close();

    const child = Bun.spawn(["bun", path.join(import.meta.dir, "fixtures/chat-child.ts"), dataDir], { stdout: "pipe", stderr: "pipe" });
    const out = await new Response(child.stdout).text();
    expect(await child.exited).not.toBe(0);
    const lines = out.trim().split("\n").map((l) => JSON.parse(l) as { event: string; reply?: string });
    expect(lines.some((l) => l.event === "turn" && (l.reply ?? "").includes("Net worth"))).toBe(true);
    expect(lines.at(-1)?.event).toBe("parked");

    // Restart: the chat run resumes as a standing run, re-parks on the
    // recovered input channel, and the next message just works.
    const app2 = openApp(dataDir);
    const resumed = await app2.resumeInFlight();
    expect(resumed.some((x) => x.workflow === "strategist-chat" && x.status === "running")).toBe(true);
    const r = await app2.sendChat({ agent: "strategist", text: "echo hello after the crash", wait: true });
    expect(r.turn!.reply).toBe("echo: echo hello after the crash");
    expect(app2.chatTranscript("strategist")).toHaveLength(2);
    app2.close();
  }, 60_000);
});
