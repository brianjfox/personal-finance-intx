// The AI-engine switch: settings round-trip and validation, the local
// source shape the agent runtime consumes (openai-compatible), and the
// profile intake speaking the OpenAI dialect to a local server --
// including the JSON-in-prose fallback for models that ignore
// tool_choice.

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createApp } from "../src/app";
import { localSource, readInferenceSettings, writeInferenceSettings } from "../src/inference";

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "fin-inf-"));

describe("inference settings", () => {
  test("default anthropic; local round-trips; bad local URLs refused", () => {
    const dataDir = tmp();
    expect(readInferenceSettings(dataDir)).toEqual({ engine: "anthropic" });
    const saved = writeInferenceSettings(dataDir, { engine: "local", base_url: "http://127.0.0.1:8080/v1/", model: "qwen" });
    expect(saved).toEqual({ engine: "local", base_url: "http://127.0.0.1:8080/v1", model: "qwen" }); // trailing slash trimmed
    expect(readInferenceSettings(dataDir)).toEqual(saved);
    const src = localSource(saved as never);
    expect(src).toMatchObject({ provider: "openai-compatible", baseURL: "http://127.0.0.1:8080/v1", model: "qwen" });
    expect(() => writeInferenceSettings(dataDir, { engine: "local", base_url: "http://evil.example/v1", model: "m" })).toThrow(/loopback|127\.0\.0\.1/);
    expect(() => writeInferenceSettings(dataDir, { engine: "local", base_url: "http://127.0.0.1:8080/v1" })).toThrow(/model name/);
    // Back to anthropic drops the local fields.
    expect(writeInferenceSettings(dataDir, { engine: "anthropic", base_url: "x", model: "y" })).toEqual({ engine: "anthropic" });
  });

  test("the profile intake speaks the OpenAI dialect to a local engine (tool_calls, then JSON-prose fallback)", async () => {
    let mode: "tools" | "prose" = "tools";
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/v1/chat/completions") {
          const body = (await req.json()) as { tool_choice?: { function?: { name?: string } }; messages: Array<{ role: string; content: string }> };
          expect(body.tool_choice?.function?.name).toBe("fill_profile");
          expect(body.messages[0]?.role).toBe("system");
          if (mode === "tools") {
            return Response.json({
              choices: [{ message: { tool_calls: [{ function: { name: "fill_profile", arguments: JSON.stringify({ person: { legal_name: "Brian" } }) } }] } }],
            });
          }
          return Response.json({ choices: [{ message: { content: 'Sure! {"person": {"state_or_province": "MA"}}' } }] });
        }
        return new Response("not found", { status: 404 });
      },
    });
    try {
      const dataDir = tmp();
      writeInferenceSettings(dataDir, { engine: "local", base_url: `http://127.0.0.1:${server.port}/v1`, model: "qwen" });
      const app = createApp({ dataDir });
      try {
        const p1 = await app.extractProfile("I'm Brian");
        expect(p1.person?.legal_name).toBe("Brian");
        mode = "prose"; // a model that ignored tool_choice
        const p2 = await app.extractProfile("I live in MA");
        expect(p2.person?.state_or_province).toBe("MA");
      } finally {
        app.close();
      }
    } finally {
      server.stop();
    }
  });
});

describe("engine switches reach standing chats", () => {
  test("changing the engine retires the standing run; the next message starts fresh; transcript survives", async () => {
    const { phase3Adapters, writePhase3Config } = await import("./fixtures/phase3-fixture");
    const { scriptedAgentFactory } = await import("./fixtures/scripted-agent");
    const dataDir = tmp();
    writePhase3Config(dataDir);
    const app = createApp({
      dataDir,
      adapters: phase3Adapters(new Date()),
      pollMs: 20,
      agentFactory: scriptedAgentFactory(),
      inferenceSource: () => {
        // Fingerprint follows the settings file, like resolveSource would.
        const s = readInferenceSettings(dataDir);
        return s.engine === "local"
          ? { id: `local:${s.model as string}`, provider: "openai-compatible", baseURL: s.base_url as string, apiKey: "x", model: s.model as string }
          : { id: "anthropic:claude-sonnet-5", provider: "anthropic", baseURL: "http://localhost:1", apiKey: "x", model: "claude-sonnet-5" };
      },
    });
    try {
      const t1 = await app.sendChat({ agent: "strategist", text: "net worth?", wait: true, timeoutMs: 30_000 });
      expect(t1.turn).not.toBeNull();
      const run1 = (await app.activeChatRun("strategist"))?.runId;
      expect(run1).toBeDefined();

      writeInferenceSettings(dataDir, { engine: "local", base_url: "http://127.0.0.1:8080/v1", model: "test-model" });
      const t2 = await app.sendChat({ agent: "strategist", text: "and now?", wait: true, timeoutMs: 30_000 });
      expect(t2.turn).not.toBeNull();
      const run2 = (await app.activeChatRun("strategist"))?.runId;
      expect(run2).toBeDefined();
      expect(run2).not.toBe(run1); // the stale-engine run was retired

      const runs = await app.listRuns();
      expect(runs.find((r) => r.runId === run1)?.status).toBe("cancelled");
      // Both turns remain visible: the transcript lives in the ledger, not the run.
      const transcript = app.chatTranscript("strategist");
      expect(transcript.map((t) => t.message)).toEqual(["net worth?", "and now?"]);

      // Same engine again: the run is NOT churned.
      const t3 = await app.sendChat({ agent: "strategist", text: "third", wait: true, timeoutMs: 30_000 });
      expect(t3.turn).not.toBeNull();
      expect((await app.activeChatRun("strategist"))?.runId).toBe(run2);
    } finally {
      app.close();
    }
  }, 60_000);
});
