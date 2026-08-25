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
