// Free-text profile intake: the operator says anything about themselves
// or their family, and a model proposes structured profile fields. The
// model only PROPOSES -- the GUI merges the proposal into the unsaved
// form for the operator to review; nothing touches profile.json until
// they press Save. Output is forced through a tool schema (no prose to
// parse), validated before it leaves the host, and the rules are
// explicit: only what the text states, never invented dates.

import { HouseholdProfile, redactProfile, type ProfileRelation } from "@fin/contracts";
import { type } from "arktype";
import type { InferenceSource } from "@intx/types/runtime";

const PatchPerson = type({
  "legal_name?": "string",
  "preferred_name?": "string",
  "date_of_birth?": "string",
  "ssn?": "string",
  "citizenship?": "string",
  "country_of_residence?": "string",
  "state_or_province?": "string",
  "marital_status?": "'single' | 'married' | 'partnered' | 'divorced' | 'widowed'",
});

const PatchRelation = type({
  legal_name: "string > 0",
  "relationship?": "string",
  "date_of_birth?": "string",
  "note?": "string",
});

export const ProfilePatch = type({
  "person?": PatchPerson,
  "spouse?": PatchRelation.or("null"),
  "children?": PatchRelation.array(),
  "others?": PatchRelation.array(),
  "note?": "string",
});
export type ProfilePatch = typeof ProfilePatch.infer;

const TOOL_SCHEMA = {
  type: "object" as const,
  properties: {
    person: {
      type: "object",
      properties: {
        legal_name: { type: "string" },
        preferred_name: { type: "string" },
        date_of_birth: { type: "string", description: "YYYY-MM-DD, ONLY if the text states the actual date" },
        ssn: { type: "string", description: "only if the text literally contains it" },
        citizenship: { type: "string" },
        country_of_residence: { type: "string" },
        state_or_province: { type: "string" },
        marital_status: { type: "string", enum: ["single", "married", "partnered", "divorced", "widowed"] },
      },
    },
    spouse: {
      type: "object",
      properties: { legal_name: { type: "string" }, date_of_birth: { type: "string" }, note: { type: "string" } },
      required: ["legal_name"],
    },
    children: {
      type: "array",
      items: {
        type: "object",
        properties: { legal_name: { type: "string" }, relationship: { type: "string" }, date_of_birth: { type: "string" }, note: { type: "string" } },
        required: ["legal_name"],
      },
    },
    others: {
      type: "array",
      items: {
        type: "object",
        properties: { legal_name: { type: "string" }, relationship: { type: "string" }, date_of_birth: { type: "string" }, note: { type: "string" } },
        required: ["legal_name"],
      },
    },
    note: { type: "string", description: "one short sentence to the operator about anything ambiguous or skipped" },
  },
};

export interface ExtractOptions {
  source: () => InferenceSource;
  model?: string;
  text: string;
  current: HouseholdProfile | null;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export async function extractProfilePatch(opts: ExtractOptions): Promise<ProfilePatch> {
  const source = opts.source();
  const doFetch = opts.fetchImpl ?? fetch;
  const system = [
    "You extract household-profile fields from an operator's free text about themselves and their family, for an estate/tax profile form they will review before saving.",
    "Rules: include ONLY what the text states or clearly implies. Never invent a date -- an age like 'my daughter is 12' goes into that person's note (e.g. 'age 12 as of now'), not date_of_birth. Do not repeat values already in the current profile unless the text changes them.",
    "Relationships for 'others': whatever the text says (mother, brother, godson, friend, charity).",
    opts.current !== null ? `Current profile (tax id withheld): ${JSON.stringify(redactProfile(opts.current))}` : "Current profile: none yet.",
  ].join("\n");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 45_000);
  let resp: Response;
  try {
    resp = await doFetch(`${source.baseURL}/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": source.apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: opts.model ?? source.model,
        max_tokens: 1024,
        system,
        messages: [{ role: "user", content: opts.text }],
        tools: [{ name: "fill_profile", description: "Report the extracted profile fields.", input_schema: TOOL_SCHEMA }],
        tool_choice: { type: "tool", name: "fill_profile" },
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!resp.ok) throw new Error(`the model call failed: ${resp.status} ${(await resp.text()).slice(0, 200)}`);
  const body = (await resp.json()) as { content?: Array<{ type: string; name?: string; input?: unknown }> };
  const call = (body.content ?? []).find((c) => c.type === "tool_use" && c.name === "fill_profile");
  if (call === undefined) throw new Error("the model didn't return profile fields -- try rephrasing");
  const patch = ProfilePatch(scrub(call.input));
  if (patch instanceof type.errors) throw new Error(`couldn't understand the model's reply (${patch.summary}) -- try rephrasing`);
  return patch;
}

/** Drop empty strings and empty objects the model sometimes emits, and malformed date fields. */
function scrub(input: unknown): unknown {
  if (typeof input !== "object" || input === null) return {};
  const out: Record<string, unknown> = {};
  const cleanRel = (r: unknown): ProfileRelation | null => {
    if (typeof r !== "object" || r === null) return null;
    const rr = r as Record<string, unknown>;
    if (typeof rr["legal_name"] !== "string" || rr["legal_name"].trim() === "") return null;
    const rel: Record<string, unknown> = { legal_name: (rr["legal_name"] as string).trim() };
    for (const k of ["relationship", "note"]) if (typeof rr[k] === "string" && (rr[k] as string).trim() !== "") rel[k] = (rr[k] as string).trim();
    if (typeof rr["date_of_birth"] === "string" && /^\d{4}-\d{2}-\d{2}$/.test(rr["date_of_birth"] as string)) rel["date_of_birth"] = rr["date_of_birth"];
    return rel as unknown as ProfileRelation;
  };
  const i = input as Record<string, unknown>;
  if (typeof i["person"] === "object" && i["person"] !== null) {
    const p: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(i["person"] as Record<string, unknown>)) {
      if (typeof v !== "string" || v.trim() === "") continue;
      if (k === "date_of_birth" && !/^\d{4}-\d{2}-\d{2}$/.test(v)) continue;
      p[k] = v.trim();
    }
    if (Object.keys(p).length > 0) out["person"] = p;
  }
  const spouse = cleanRel(i["spouse"]);
  if (spouse !== null) out["spouse"] = spouse;
  for (const k of ["children", "others"]) {
    if (Array.isArray(i[k])) {
      const list = (i[k] as unknown[]).map(cleanRel).filter((r): r is ProfileRelation => r !== null);
      if (list.length > 0) out[k] = list;
    }
  }
  if (typeof i["note"] === "string" && i["note"].trim() !== "") out["note"] = i["note"].trim();
  return out;
}
