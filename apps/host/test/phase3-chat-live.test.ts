// The slide-19 acceptance with a REAL model, end to end: skipped unless
// ANTHROPIC_API_KEY is exported. The scripted variant
// (phase3-chat.test.ts) proves every seam below inference; this proves
// the real reactor + tools + prompt produce an answer whose figures
// come from tool evidence and whose thesis lands in the journal.

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createApp } from "../src/app";
import { phase3Adapters, RENTAL, writePhase3Config } from "./fixtures/phase3-fixture";

const hasKey = (process.env["ANTHROPIC_API_KEY"] ?? "") !== "";

describe("phase 3 live (real model; needs ANTHROPIC_API_KEY)", () => {
  test.skipIf(!hasKey)(
    "the strategist answers the slide-19 question with tool-sourced figures and journals the thesis",
    async () => {
      const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fin-p3live-"));
      writePhase3Config(dataDir);
      const app = createApp({ dataDir, adapters: phase3Adapters(new Date()), pollMs: 20 });
      expect((await app.runNightly({ runId: "nightly_live" })).terminalStatus).toBe("completed");
      expect((await app.runEstateAudit()).terminalStatus).toBe("completed");

      const r = await app.sendChat({
        agent: "strategist",
        text:
          `If I sell the rental (${RENTAL}) next spring -- say 2027-04-20, cost basis 300000, depreciation taken 80000 -- ` +
          "what does that do to the Q2 estimate and the trust schedule? Use your tools for every figure, then record your thesis in the journal.",
        wait: true,
        timeoutMs: 180_000,
      });
      const turn = r.turn!;
      expect(turn.reply.length).toBeGreaterThan(0);
      // Figures came from tools: the scenario ran and cited real facts.
      const scenario = turn.evidence.find((e) => e.tool === "run_scenario");
      expect(scenario).toBeDefined();
      expect(scenario!.fact_ids.length).toBeGreaterThan(0);
      for (const id of scenario!.fact_ids) expect(app.ledger.getFact(id)).not.toBeNull();
      // The hand-computed answer is in the reply somewhere: 35,000 of tax.
      expect(turn.reply.includes("35,000") || turn.reply.includes("35000")).toBe(true);
      // The thesis landed in the journal.
      expect(turn.journal_ids.length).toBeGreaterThan(0);
      expect(app.ledger.listJournal().some((j) => j.author === "strategist")).toBe(true);
      app.close();
    },
    240_000,
  );
});
