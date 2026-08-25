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

export const InferenceSettings = type({
  engine: "'anthropic' | 'local'",
  /** Local only: the server's base URL including /v1 (e.g. http://127.0.0.1:8080/v1). */
  "base_url?": "string",
  /** Local only: the model name the server expects. */
  "model?": "string",
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
  const file = inferenceSettingsPath(dataDir);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2));
  fs.renameSync(tmp, file);
  return settings;
}

/** The InferenceSource for a LOCAL engine (the Anthropic path stays in step-invoker's anthropicSourceFromEnv). */
export function localSource(settings: InferenceSettings & { engine: "local" }): InferenceSource {
  return {
    id: `local:${settings.model as string}`,
    provider: "openai-compatible",
    baseURL: settings.base_url as string,
    apiKey: "local",
    model: settings.model as string,
  };
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
