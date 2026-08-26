// Which AI engine the advisory agents use: Anthropic's cloud (the
// default; key from the Credentials page) or a LOCAL server -- Apple
// MLX via `mlx_lm.server`, LM Studio, or any OpenAI-compatible
// endpoint. The pinned agent runtime ships an "openai-compatible"
// adapter, so a local engine is just a different InferenceSource; with
// it, nothing the agents say ever leaves this machine.
//
// Settings live in `<dataDir>/inference.json` (no secrets -- the
// Anthropic key stays in the Keychain). Plain http is allowed only to
// loopback, matching the app's other outbound rules.

import fs from "node:fs";
import path from "node:path";

import { type } from "arktype";
import type { InferenceSource } from "@intx/types/runtime";

export const INFERENCE_TASKS = ["profile", "estate", "tax", "strategy"] as const;
export type InferenceTask = (typeof INFERENCE_TASKS)[number];

/** One task's engine choice: follow the default, or pin an engine (with optional overrides). */
export const TaskChoice = type({
  engine: "'default' | 'anthropic' | 'local'",
  /** Override the model for this task (Anthropic model name, or the local server's model). */
  "model?": "string",
  /** Local only: a different server than the global local one. */
  "base_url?": "string",
});
export type TaskChoice = typeof TaskChoice.infer;

export const InferenceSettings = type({
  engine: "'anthropic' | 'local'",
  /** Local only: the server's base URL including /v1 (e.g. http://127.0.0.1:8080/v1). */
  "base_url?": "string",
  /** Local only: the model name the server expects. */
  "model?": "string",
  /** Per-task assignments: Profile intake, Estate chat, Tax, Strategy chat. Absent task -> default engine. */
  "tasks?": type({ "profile?": TaskChoice, "estate?": TaskChoice, "tax?": TaskChoice, "strategy?": TaskChoice }),
});
export type InferenceSettings = typeof InferenceSettings.infer;

const LOCAL_URL = /^(https:\/\/[^\s]+|http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/[^\s]*)?)$/;

export function inferenceSettingsPath(dataDir: string): string {
  return path.join(dataDir, "inference.json");
}

export function readInferenceSettings(dataDir: string): InferenceSettings {
  const file = inferenceSettingsPath(dataDir);
  if (!fs.existsSync(file)) return { engine: "anthropic" };
  const parsed = InferenceSettings(JSON.parse(fs.readFileSync(file, "utf8")));
  if (parsed instanceof type.errors) throw new Error(`inference.json: ${parsed.summary}`);
  return parsed;
}

export function writeInferenceSettings(dataDir: string, settings: InferenceSettings): InferenceSettings {
  const tasks = settings.tasks;
  if (settings.engine === "local") {
    const url = (settings.base_url ?? "").trim().replace(/\/+$/, "");
    const model = (settings.model ?? "").trim();
    if (url === "" || model === "") {
      throw new Error("a local engine needs both the server address (e.g. http://127.0.0.1:8080/v1) and the model name");
    }
    if (!LOCAL_URL.test(url)) {
      throw new Error("the server address must be https, or plain http only to 127.0.0.1/localhost");
    }
    settings = { engine: "local", base_url: url, model };
  } else {
    settings = { engine: "anthropic" };
  }
  if (tasks !== undefined) {
    const cleaned: NonNullable<InferenceSettings["tasks"]> = {};
    for (const t of INFERENCE_TASKS) {
      const c = tasks[t];
      if (c === undefined || c.engine === "default") continue;
      const model = (c.model ?? "").trim();
      const url = (c.base_url ?? "").trim().replace(/\/+$/, "");
      if (url !== "" && !LOCAL_URL.test(url)) {
        throw new Error(`${t}: the server address must be https, or plain http only to 127.0.0.1/localhost`);
      }
      if (c.engine === "local" && settings.engine !== "local" && (url === "" || model === "")) {
        throw new Error(`${t}: a local assignment needs a server address and model (or set the default engine to local first)`);
      }
      cleaned[t] = { engine: c.engine, ...(model !== "" ? { model } : {}), ...(url !== "" ? { base_url: url } : {}) };
    }
    if (Object.keys(cleaned).length > 0) settings = { ...settings, tasks: cleaned };
  }
  const file = inferenceSettingsPath(dataDir);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2));
  fs.renameSync(tmp, file);
  return settings;
}

/** The InferenceSource for a LOCAL engine (the Anthropic path stays in step-invoker's anthropicSourceFromEnv). */
export function localSource(settings: { base_url?: string; model?: string }): InferenceSource {
  return {
    id: `local:${settings.model as string}`,
    provider: "openai-compatible",
    baseURL: settings.base_url as string,
    apiKey: "local",
    model: settings.model as string,
  };
}

/**
 * Resolve one task's source: its own assignment first, the default
 * engine otherwise. `anthropic` builds on the given fallback source
 * (key/base) with an optional per-task model override; `local` falls
 * back to the global local server when the task doesn't name one.
 */
export function resolveTaskSource(
  settings: InferenceSettings,
  task: InferenceTask | undefined,
  anthropicSource: () => InferenceSource,
): InferenceSource {
  const choice = task !== undefined ? settings.tasks?.[task] : undefined;
  const engine = choice === undefined || choice.engine === "default" ? settings.engine : choice.engine;
  if (engine === "local") {
    const base_url = choice?.base_url ?? settings.base_url;
    const model = choice?.model ?? settings.model;
    if (base_url === undefined || model === undefined) {
      throw new Error(`${task ?? "default"}: local engine chosen but no server/model configured -- set it on the Credentials page`);
    }
    return localSource({ base_url, model });
  }
  const src = anthropicSource();
  return choice?.model !== undefined && choice.model !== "" ? { ...src, id: `anthropic:${choice.model}`, model: choice.model } : src;
}

/**
 * One tiny round-trip to whatever engine is configured, so the GUI's
 * Test button can say "the model answered" before anything depends on it.
 */
export async function testInference(source: InferenceSource, fetchImpl: typeof fetch = fetch): Promise<{ ok: boolean; detail: string }> {
  try {
    if (source.provider === "anthropic") {
      const r = await fetchImpl(`${source.baseURL}/v1/messages`, {
        method: "POST",
        headers: { "x-api-key": source.apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({ model: source.model, max_tokens: 16, messages: [{ role: "user", content: "Say OK." }] }),
      });
      if (!r.ok) return { ok: false, detail: `${r.status} ${(await r.text()).slice(0, 160)}` };
      return { ok: true, detail: `${source.model} answered` };
    }
    const r = await fetchImpl(`${source.baseURL}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${source.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: source.model, max_tokens: 16, messages: [{ role: "user", content: "Say OK." }] }),
    });
    if (!r.ok) return { ok: false, detail: `${r.status} ${(await r.text()).slice(0, 160)}` };
    const body = (await r.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const said = body.choices?.[0]?.message?.content ?? "";
    return { ok: true, detail: `${source.model} answered${said !== "" ? `: ${said.slice(0, 60)}` : ""}` };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}
