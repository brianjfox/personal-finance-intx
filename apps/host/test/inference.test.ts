// The provider registry: multiple engines, presets, per-task
// assignments, Keychain-held keys (presence only), v1 migration, and
// the standing-chat restart when a task's provider changes.

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { memorySecretStore } from "@fin/institutions";

import { createApp } from "../src/app";
import { readInferenceSettings, resolveTaskSource, sourceForProvider, writeInferenceSettings, type InferenceSettingsV2 } from "../src/inference";

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "fin-inf-"));
const NO_KEY = { anthropicKey: () => null };

const settingsWith = (over: Partial<InferenceSettingsV2>): InferenceSettingsV2 => ({
  version: "2",
  providers: [
    { id: "anthropic", kind: "anthropic", label: "Anthropic (Claude)", base_url: "https://api.anthropic.com", model: "claude-sonnet-5" },
    { id: "local", kind: "openai-compatible", label: "Local", base_url: "http://127.0.0.1:8080/v1", model: "gpt-oss-20b" },
    { id: "openai", kind: "openai-compatible", label: "OpenAI", base_url: "https://api.openai.com/v1", model: "gpt-5.2" },
  ],
  default: "anthropic",
  ...over,
});

describe("provider registry", () => {
  test("round-trips; validation refuses bad urls, missing models, unknown assignments, duplicate ids", () => {
    const dataDir = tmp();
    const saved = writeInferenceSettings(dataDir, settingsWith({ tasks: { profile: "local", strategy: "openai" } }));
    expect(readInferenceSettings(dataDir)).toEqual(saved);
    expect(saved.providers).toHaveLength(3);

    expect(() =>
      writeInferenceSettings(dataDir, settingsWith({ providers: [{ id: "x", kind: "openai-compatible", label: "X", base_url: "http://evil.example/v1", model: "m" }], default: "x" })),
    ).toThrow(/loopback|127\.0\.0\.1/);
    expect(() =>
      writeInferenceSettings(dataDir, settingsWith({ providers: [{ id: "x", kind: "openai-compatible", label: "X", base_url: "https://ok.example/v1", model: " " }], default: "x" })),
    ).toThrow(/model name is required/);
    expect(() => writeInferenceSettings(dataDir, settingsWith({ default: "nope" }))).toThrow(/isn't in the list/);
    expect(() => writeInferenceSettings(dataDir, settingsWith({ tasks: { tax: "nope" } }))).toThrow(/tax: provider nope/);
    const dup = settingsWith({});
    dup.providers = [...dup.providers, { ...dup.providers[0]! }];
    expect(() => writeInferenceSettings(dataDir, dup)).toThrow(/appears twice/);
  });

  test("key resolution: Keychain per provider; Anthropic falls back to the app key; loopback is keyless", () => {
    const s = settingsWith({ tasks: { profile: "local", strategy: "openai" } });
    const secrets = memorySecretStore({ "fin-inference/key:openai": "sk-openai-1" });

    const strat = resolveTaskSource(s, "strategy", { secrets, anthropicKey: () => null });
    expect(strat).toMatchObject({ provider: "openai-compatible", baseURL: "https://api.openai.com/v1", apiKey: "sk-openai-1", model: "gpt-5.2" });
    const prof = resolveTaskSource(s, "profile", { secrets, anthropicKey: () => null });
    expect(prof).toMatchObject({ provider: "openai-compatible", apiKey: "local", model: "gpt-oss-20b" }); // loopback: keyless
    const est = resolveTaskSource(s, "estate", { secrets, anthropicKey: () => "sk-ant-app" });
    expect(est).toMatchObject({ provider: "anthropic", apiKey: "sk-ant-app", model: "claude-sonnet-5" }); // default + app key
    expect(() => resolveTaskSource(s, "estate", { secrets, anthropicKey: () => null })).toThrow(/no API key stored/);
    // A provider-specific key beats the fallback.
    secrets.set!("fin-inference", "key:anthropic", "sk-ant-specific");
    expect(sourceForProvider(s.providers[0]!, { secrets, anthropicKey: () => "sk-ant-app" }).apiKey).toBe("sk-ant-specific");
  });

  test("v1 files migrate: engines become providers, per-task splits survive", () => {
    const dataDir = tmp();
    fs.writeFileSync(
      path.join(dataDir, "inference.json"),
      JSON.stringify({
        engine: "local",
        base_url: "http://127.0.0.1:8080/v1",
        model: "gpt-oss-20b",
        tasks: { profile: { engine: "local", model: "tiny" }, strategy: { engine: "anthropic" } },
      }),
    );
    const s = readInferenceSettings(dataDir);
    expect(s.version).toBe("2");
    expect(s.default).toBe("local");
    expect(s.providers.map((p) => p.id).sort()).toEqual(["anthropic", "local", "local-profile"]);
    expect(s.providers.find((p) => p.id === "local-profile")?.model).toBe("tiny");
    expect(s.tasks).toEqual({ profile: "local-profile", strategy: "anthropic" });
  });

  test("the profile intake uses the profile task's provider", async () => {
    let hits = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/v1/chat/completions") {
          hits += 1;
          const body = (await req.json()) as { model: string };
          expect(body.model).toBe("tiny-intake-model");
          return Response.json({ choices: [{ message: { tool_calls: [{ function: { name: "fill_profile", arguments: JSON.stringify({ person: { legal_name: "B" } }) } }] } }] });
        }
        return new Response("nope", { status: 404 });
      },
    });
    try {
      const dataDir = tmp();
      writeInferenceSettings(dataDir, settingsWith({
        providers: [
          { id: "anthropic", kind: "anthropic", label: "Anthropic", base_url: "https://api.anthropic.com", model: "claude-sonnet-5" },
          { id: "tiny", kind: "openai-compatible", label: "Tiny", base_url: `http://127.0.0.1:${server.port}/v1`, model: "tiny-intake-model" },
        ],
        default: "anthropic",
        tasks: { profile: "tiny" },
      }));
      const app = createApp({ dataDir });
      try {
        const p = await app.extractProfile("I'm B");
        expect(p.person?.legal_name).toBe("B");
        expect(hits).toBe(1);
      } finally {
        app.close();
      }
    } finally {
      server.stop();
    }
  });

  test("keys pasted at save go to the secret store and report presence only", () => {
    const secrets = memorySecretStore();
    const app = createApp({ dataDir: tmp(), connectors: { secrets } });
    try {
      app.setInferenceSettings(settingsWith({}), { openai: "sk-live-secret", local: "" });
      expect(secrets.dump()["fin-inference/key:openai"]).toBe("sk-live-secret");
      const got = app.getInferenceSettings();
      expect(got.key_set["openai"]).toBe(true);
      expect(got.key_set["local"]).toBe(true); // loopback: keyless counts as ready
      expect(got.key_set["anthropic"]).toBe(typeof process.env["ANTHROPIC_API_KEY"] === "string" && process.env["ANTHROPIC_API_KEY"] !== "");
      expect(JSON.stringify(got)).not.toContain("sk-live-secret");
      expect(got.presets.some((p) => p.id === "openai")).toBe(true);
    } finally {
      app.close();
    }
  });
});

describe("provider switches reach standing chats", () => {
  test("reassigning a task's provider retires the standing run; the next message starts fresh; transcript survives", async () => {
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
        const s = readInferenceSettings(dataDir);
        const id = s.tasks?.strategy ?? s.default;
        const p = s.providers.find((x) => x.id === id)!;
        return { id: `${p.id}:${p.model}`, provider: p.kind, baseURL: p.base_url, apiKey: "x", model: p.model };
      },
    });
    try {
      writeInferenceSettings(dataDir, settingsWith({}));
      const t1 = await app.sendChat({ agent: "strategist", text: "net worth?", wait: true, timeoutMs: 30_000 });
      expect(t1.turn).not.toBeNull();
      const run1 = (await app.activeChatRun("strategist"))?.runId;
      expect(run1).toBeDefined();

      writeInferenceSettings(dataDir, settingsWith({ tasks: { strategy: "local" } }));
      const t2 = await app.sendChat({ agent: "strategist", text: "and now?", wait: true, timeoutMs: 30_000 });
      expect(t2.turn).not.toBeNull();
      const run2 = (await app.activeChatRun("strategist"))?.runId;
      expect(run2).toBeDefined();
      expect(run2).not.toBe(run1!);
      expect((await app.listRuns()).find((r) => r.runId === run1)?.status).toBe("cancelled");
      expect(app.chatTranscript("strategist").map((t) => t.message)).toEqual(["net worth?", "and now?"]);

      const t3 = await app.sendChat({ agent: "strategist", text: "third", wait: true, timeoutMs: 30_000 });
      expect(t3.turn).not.toBeNull();
      expect((await app.activeChatRun("strategist"))?.runId).toBe(run2!);
    } finally {
      app.close();
    }
  }, 60_000);
});

describe("identity-linked Anthropic keys (workspace id)", () => {
  test("with a workspace configured, anthropic requests carry anthropic-workspace-id via the loopback forwarder", async () => {
    let seenWorkspace: string | null = null;
    let seenKey: string | null = null;
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/v1/messages") {
          seenWorkspace = req.headers.get("anthropic-workspace-id");
          seenKey = req.headers.get("x-api-key");
          return Response.json({ content: [{ type: "text", text: "OK" }] });
        }
        return new Response("nope", { status: 404 });
      },
    });
    try {
      const s = settingsWith({});
      s.providers[0]!.base_url = `http://127.0.0.1:${upstream.port}`;
      const src = resolveTaskSource(s, "estate", {
        secrets: memorySecretStore(),
        anthropicKey: () => "sk-ant-linked",
        anthropicWorkspace: () => "wrkspc_abc123",
      });
      expect(src.baseURL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(src.baseURL).not.toBe(`http://127.0.0.1:${upstream.port}`); // it's the forwarder
      expect(src.id).toContain("@wrkspc_abc123"); // engine fingerprint changes with the workspace

      const r = await fetch(`${src.baseURL}/v1/messages`, {
        method: "POST",
        headers: { "x-api-key": src.apiKey, "content-type": "application/json" },
        body: JSON.stringify({ model: src.model, max_tokens: 8, messages: [] }),
      });
      expect(r.status).toBe(200);
      expect(seenWorkspace ?? "").toBe("wrkspc_abc123");
      expect(seenKey ?? "").toBe("sk-ant-linked"); // the key travels in the caller's own headers

      // Without a workspace, the source points straight at the API.
      const plain = resolveTaskSource(s, "estate", { secrets: memorySecretStore(), anthropicKey: () => "sk" });
      expect(plain.baseURL).toBe(`http://127.0.0.1:${upstream.port}`);
      expect(plain.id).not.toContain("@");
    } finally {
      const { stopAnthropicProxies } = await import("../src/anthropic-proxy");
      stopAnthropicProxies();
      upstream.stop(true);
    }
  });

  test("the workspace id is an optional credential field: saves without it, stores it, clears it", () => {
    const secrets = memorySecretStore();
    const app = createApp({ dataDir: tmp(), connectors: { secrets } });
    // setCredential mirrors the key into process.env; keep the suite's env clean.
    const savedEnvKey = process.env["ANTHROPIC_API_KEY"];
    try {
      app.setCredential("anthropic", { anthropic: "sk-ant-x", workspace_id: "" });
      let slot = app.credentialsStatus().slots.find((s) => s.id === "anthropic")!;
      expect(slot.configured).toBe(true); // optional field absent is still set up
      expect(slot.fields.find((f) => f.account === "workspace_id")?.set).toBe(false);

      app.setCredential("anthropic", { anthropic: "sk-ant-x", workspace_id: "wrkspc_1" });
      expect(secrets.dump()["fin-interchange/workspace_id"]).toBe("wrkspc_1");
      slot = app.credentialsStatus().slots.find((s) => s.id === "anthropic")!;
      expect(slot.fields.find((f) => f.account === "workspace_id")?.set).toBe(true);

      app.setCredential("anthropic", { anthropic: "sk-ant-x", workspace_id: "" });
      expect(secrets.dump()["fin-interchange/workspace_id"]).toBeUndefined();
    } finally {
      if (savedEnvKey === undefined) delete process.env["ANTHROPIC_API_KEY"];
      else process.env["ANTHROPIC_API_KEY"] = savedEnvKey;
      app.close();
    }
  });
});
