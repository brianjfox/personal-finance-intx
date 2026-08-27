// Which AI engines the advisory agents use. The operator configures any
// number of PROVIDERS -- Anthropic, OpenAI, Google Gemini (via its
// OpenAI-compatible endpoint), xAI, Mistral, DeepSeek, Groq, OpenRouter,
// a local server (Apple MLX / LM Studio / Ollama), or any other
// OpenAI-compatible endpoint -- then assigns one as the default and,
// optionally, one per task (Profile intake, Estate chat, Tax, Strategy).
//
// Two dialects cover everything: Anthropic's Messages API, and OpenAI
// Chat Completions (the runtime's "openai-compatible" adapter). API keys
// NEVER live in inference.json: they go to the Keychain (service
// fin-inference, account key:<providerId>); the Anthropic preset reuses
// the app's existing Anthropic key slot. Plain http is allowed only to
// loopback.

import fs from "node:fs";
import path from "node:path";

import { defaultSecretStore, type SecretStore } from "@fin/institutions";
import { type } from "arktype";
import type { InferenceSource } from "@intx/types/runtime";

import { anthropicProxyBaseURL } from "./anthropic-proxy";

export const INFERENCE_TASKS = ["profile", "estate", "tax", "strategy"] as const;
export type InferenceTask = (typeof INFERENCE_TASKS)[number];

export const INFERENCE_SERVICE = "fin-inference";

export const ProviderConfig = type({
  /** Stable id ("anthropic", "openai", "local", "other-2", ...). */
  id: /^[a-z][a-z0-9-]{0,40}$/,
  kind: "'anthropic' | 'openai-compatible'",
  label: "string > 0",
  base_url: "string > 0",
  model: "string > 0",
});
export type ProviderConfig = typeof ProviderConfig.infer;

export const InferenceSettingsV2 = type({
  version: "'2'",
  providers: ProviderConfig.array(),
  /** Provider id everything uses unless a task says otherwise. */
  default: "string > 0",
  "tasks?": type({ "profile?": "string", "estate?": "string", "tax?": "string", "strategy?": "string" }),
});
export type InferenceSettingsV2 = typeof InferenceSettingsV2.infer;
export type InferenceSettings = InferenceSettingsV2;

/** The dropdown of common providers. `model` is a suggestion the operator can change. */
export const PROVIDER_PRESETS: ReadonlyArray<{ id: string; label: string; kind: ProviderConfig["kind"]; base_url: string; model: string; keyless?: boolean }> = [
  { id: "anthropic", label: "Anthropic (Claude)", kind: "anthropic", base_url: "https://api.anthropic.com", model: "claude-sonnet-5" },
  { id: "openai", label: "OpenAI", kind: "openai-compatible", base_url: "https://api.openai.com/v1", model: "gpt-5.2" },
  { id: "google", label: "Google Gemini", kind: "openai-compatible", base_url: "https://generativelanguage.googleapis.com/v1beta/openai", model: "gemini-2.5-flash" },
  { id: "xai", label: "xAI (Grok)", kind: "openai-compatible", base_url: "https://api.x.ai/v1", model: "grok-4" },
  { id: "mistral", label: "Mistral", kind: "openai-compatible", base_url: "https://api.mistral.ai/v1", model: "mistral-large-latest" },
  { id: "deepseek", label: "DeepSeek", kind: "openai-compatible", base_url: "https://api.deepseek.com/v1", model: "deepseek-chat" },
  { id: "groq", label: "Groq", kind: "openai-compatible", base_url: "https://api.groq.com/openai/v1", model: "llama-3.3-70b-versatile" },
  { id: "openrouter", label: "OpenRouter", kind: "openai-compatible", base_url: "https://openrouter.ai/api/v1", model: "" },
  { id: "local", label: "Local (Apple MLX / LM Studio / Ollama)", kind: "openai-compatible", base_url: "http://127.0.0.1:8080/v1", model: "", keyless: true },
];

const URL_RULE = /^(https:\/\/[^\s]+|http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/[^\s]*)?)$/;

export function inferenceSettingsPath(dataDir: string): string {
  return path.join(dataDir, "inference.json");
}

const DEFAULTS: InferenceSettingsV2 = {
  version: "2",
  providers: [{ id: "anthropic", kind: "anthropic", label: "Anthropic (Claude)", base_url: "https://api.anthropic.com", model: "claude-sonnet-5" }],
  default: "anthropic",
};

/** V1 shape ({engine, base_url?, model?, tasks?}) -> V2, preserving per-task local/anthropic splits. */
function migrateV1(v1: Record<string, unknown>): InferenceSettingsV2 {
  const providers: ProviderConfig[] = JSON.parse(JSON.stringify(DEFAULTS.providers)) as ProviderConfig[];
  const addLocal = (id: string, base_url: string | undefined, model: string | undefined): string | null => {
    if (base_url === undefined || model === undefined || base_url === "" || model === "") return null;
    if (!providers.some((p) => p.id === id)) {
      providers.push({ id, kind: "openai-compatible", label: "Local (Apple MLX / LM Studio / Ollama)", base_url, model });
    }
    return id;
  };
  const globalLocal = addLocal("local", v1["base_url"] as string | undefined, v1["model"] as string | undefined);
  const tasks: Record<string, string> = {};
  const v1tasks = (v1["tasks"] ?? {}) as Record<string, { engine?: string; base_url?: string; model?: string } | undefined>;
  for (const t of INFERENCE_TASKS) {
    const c = v1tasks[t];
    if (c === undefined || c.engine === undefined || c.engine === "default") continue;
    if (c.engine === "anthropic") {
      if (c.model !== undefined && c.model !== "") {
        const id = `anthropic-${t}`;
        providers.push({ id, kind: "anthropic", label: `Anthropic (${c.model})`, base_url: "https://api.anthropic.com", model: c.model });
        tasks[t] = id;
      } else tasks[t] = "anthropic";
    } else {
      const hasOwn = (c.base_url !== undefined && c.base_url !== "") || (c.model !== undefined && c.model !== "");
      const own = hasOwn
        ? addLocal(`local-${t}`, c.base_url ?? (v1["base_url"] as string | undefined), c.model ?? (v1["model"] as string | undefined))
        : globalLocal;
      if (own !== null) tasks[t] = own;
    }
  }
  return {
    version: "2",
    providers,
    default: v1["engine"] === "local" && globalLocal !== null ? globalLocal : "anthropic",
    ...(Object.keys(tasks).length > 0 ? { tasks } : {}),
  };
}

export function readInferenceSettings(dataDir: string): InferenceSettingsV2 {
  const file = inferenceSettingsPath(dataDir);
  if (!fs.existsSync(file)) return DEFAULTS;
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  if (raw["version"] !== "2") return migrateV1(raw);
  const parsed = InferenceSettingsV2(raw);
  if (parsed instanceof type.errors) throw new Error(`inference.json: ${parsed.summary}`);
  return parsed;
}

export function writeInferenceSettings(dataDir: string, settings: InferenceSettingsV2): InferenceSettingsV2 {
  const seen = new Set<string>();
  for (const p of settings.providers) {
    if (seen.has(p.id)) throw new Error(`provider id ${p.id} appears twice`);
    seen.add(p.id);
    const url = p.base_url.trim().replace(/\/+$/, "");
    if (!URL_RULE.test(url)) throw new Error(`${p.label}: the server address must be https, or plain http only to 127.0.0.1/localhost`);
    p.base_url = url;
    if (p.model.trim() === "") throw new Error(`${p.label}: the model name is required`);
    p.model = p.model.trim();
  }
  if (!seen.has(settings.default)) throw new Error(`the default provider (${settings.default}) isn't in the list`);
  for (const t of INFERENCE_TASKS) {
    const id = settings.tasks?.[t];
    if (id !== undefined && !seen.has(id)) throw new Error(`${t}: provider ${id} isn't in the list`);
  }
  const checked = InferenceSettingsV2(settings);
  if (checked instanceof type.errors) throw new Error(`inference settings: ${checked.summary}`);
  const file = inferenceSettingsPath(dataDir);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(checked, null, 2));
  fs.renameSync(tmp, file);
  return checked;
}

/** Is this a loopback endpoint (keyless allowed)? */
function isLoopback(url: string): boolean {
  return /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(url);
}

export interface ResolveOptions {
  secrets?: SecretStore;
  /** The app's existing Anthropic key resolution (env, then Keychain). */
  anthropicKey: () => string | null;
  /** Workspace id for identity-linked Anthropic keys (null when not needed). */
  anthropicWorkspace?: () => string | null;
}

/** Provider config -> the InferenceSource the runtime consumes. Throws plain words when a key is missing. */
export function sourceForProvider(p: ProviderConfig, opts: ResolveOptions): InferenceSource {
  const secrets = opts.secrets ?? defaultSecretStore();
  let apiKey: string | null = secrets.get(INFERENCE_SERVICE, `key:${p.id}`);
  if (apiKey === null && p.kind === "anthropic") apiKey = opts.anthropicKey();
  if (apiKey === null && isLoopback(p.base_url)) apiKey = "local";
  if (apiKey === null || apiKey === "") {
    throw new Error(`${p.label}: no API key stored -- add it on the Credentials page (AI providers)`);
  }
  // Identity-linked Anthropic keys need an anthropic-workspace-id header
  // on every request; the runtime's adapter can't add one, so those
  // sources route through a loopback forwarder that does. The workspace
  // is part of the source id, so standing chats restart when it changes.
  let baseURL = p.base_url;
  let id = `${p.id}:${p.model}`;
  if (p.kind === "anthropic") {
    const ws = opts.anthropicWorkspace?.() ?? null;
    if (ws !== null && ws !== "") {
      baseURL = anthropicProxyBaseURL(ws, p.base_url);
      id = `${id}@${ws}`;
    }
  }
  return { id, provider: p.kind, baseURL, apiKey, model: p.model };
}

/** Task -> its assigned provider (or the default). */
export function providerForTask(settings: InferenceSettingsV2, task: InferenceTask | undefined): ProviderConfig {
  const id = (task !== undefined ? settings.tasks?.[task] : undefined) ?? settings.default;
  const p = settings.providers.find((x) => x.id === id);
  if (p === undefined) throw new Error(`provider ${id} isn't configured -- check the AI providers card on the Credentials page`);
  return p;
}

export function resolveTaskSource(settings: InferenceSettingsV2, task: InferenceTask | undefined, opts: ResolveOptions): InferenceSource {
  return sourceForProvider(providerForTask(settings, task), opts);
}

/**
 * One tiny round-trip to a source, so the GUI's Test button can say
 * "the model answered" before anything depends on it.
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
