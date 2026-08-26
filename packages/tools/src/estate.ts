// The Estate Planner's tool set (deck slides 8 and 13): read the
// registry and the vault, flag concerns as findings. No credentials, no
// execution, no journal, no fact writes -- the deterministic hygiene
// audit (estate.audit) owns the structural checks; the agent's
// `emit_finding` is limited to the `advisory_note` code so a model can
// raise a cited concern but never fabricate a detector's verdict.

import type { AccountPayload, EntityPayload, TitlingPayload } from "@fin/contracts";
import { defineTool, type BaseEnv } from "@intx/agent";

import { finBundle, OBJECT_SCHEMA, type FinTool } from "./bundle";
import { saveDraftTool } from "./draft";
import { householdProfileTool } from "./profile";
import type { FinAgentEnvExtras } from "./env";

export const ESTATE_TOOL_NAMES = ["registry_read", "document_read", "emit_finding", "household_profile", "save_draft"] as const;

const registryRead: FinTool = {
  definition: {
    name: "registry_read",
    description:
      "Read the estate registry: entities (people, trusts, LLCs), the OBSERVED titling and beneficiaries per account (what the paperwork says, dated), the PLAN's intended titling, expected documents, and executors. Returns the fact ids behind the observations.",
    inputSchema: OBJECT_SCHEMA({}),
  },
  handler: async (_args, fin) => {
    const entities = fin.ledger.asOf({ kind: "entity" });
    const titling = fin.ledger.asOf({ kind: "titling" });
    const accounts = fin.ledger.asOf({ kind: "account" });
    const estate = fin.estateFile();
    return {
      result: {
        entities: entities.map((f) => f.payload as EntityPayload),
        observed_titling: titling.map((f) => f.payload as TitlingPayload),
        accounts: accounts.map((f) => {
          const p = f.payload as AccountPayload;
          return { subject: p.account_id, name: p.name, type: p.type };
        }),
        plan:
          estate === null
            ? null
            : {
                titling: estate.plan.titling,
                documents: estate.plan.documents.map((d) => ({ kind: d.kind, description: d.description, linked: d.vault_sha256 != null })),
                executors: estate.plan.executors,
                digital_access_recorded: estate.plan.digital_access != null && estate.plan.digital_access.trim() !== "",
              },
      },
      fact_ids: [...entities, ...titling, ...accounts].map((f) => f.id),
    };
  },
};

const documentRead: FinTool = {
  definition: {
    name: "document_read",
    description:
      "List the document vault's holdings: kind, filename, tax year, sha256 and ingestion date. Metadata only; original bytes stay in the vault.",
    inputSchema: OBJECT_SCHEMA({}),
  },
  handler: async (_args, fin) => {
    const docs = fin.ledger.listDocuments(1000);
    return {
      result: {
        documents: docs.map((d) => ({
          id: d.id,
          kind: d.kind,
          filename: d.filename,
          tax_year: d.tax_year ?? null,
          sha256: d.sha256,
          ingested_at: d.ingested_at,
        })),
      },
      fact_ids: [],
      evidence: false,
    };
  },
};

const emitFinding: FinTool = {
  definition: {
    name: "emit_finding",
    description:
      "Raise an advisory concern into the exception queue, cited to ledger fact ids. Use for qualitative estate gaps the deterministic audit cannot see (an outdated will clause, a titling nuance). The finding is recorded as an advisory_note requiring the operator's decision -- never as a detector verdict, and never with a computed figure.",
    inputSchema: OBJECT_SCHEMA(
      {
        subject: { type: "string", description: "what the concern is about (account subject, entity, or household.estate)" },
        summary: { type: "string" },
        severity: { type: "string", enum: ["info", "low", "medium", "high"] },
        evidence: { type: "array", items: { type: "string" }, description: "ledger fact ids the concern rests on" },
      },
      ["subject", "summary"],
    ),
  },
  handler: async (args, fin) => {
    const subject = String(args["subject"] ?? "").trim();
    const summary = String(args["summary"] ?? "").trim();
    if (subject === "" || summary === "") throw new Error("emit_finding: subject and summary are required");
    const severity = ["info", "low", "medium", "high"].includes(args["severity"] as string) ? (args["severity"] as "info" | "low" | "medium" | "high") : "medium";
    const evidence = Array.isArray(args["evidence"]) ? args["evidence"].filter((r): r is string => typeof r === "string") : [];
    const at = fin.clock().toISOString();
    const id = fin.ledger.appendFinding({
      kind: "info",
      code: "advisory_note",
      severity,
      subject,
      summary,
      detail: { fingerprint: `advisory_note|${subject}|${summary}` },
      evidence,
      before: [],
      after: [],
      requires_human: true,
      emitted_by: "estate_planner",
      as_of: at,
      provenance: { source_id: "estate.planner", source_doc_id: null, observed_at: at, via: "agent@1" },
    });
    return { result: { finding_id: id }, fact_ids: evidence, evidence: false };
  },
};

export const estateTools = defineTool<BaseEnv & FinAgentEnvExtras>({
  id: "fin/estate",
  requires: ["fin"],
  definitions: ESTATE_TOOL_NAMES.map((name) => ({ name })),
  factory: (env) => finBundle(env.fin, [registryRead, documentRead, emitFinding, householdProfileTool, saveDraftTool]),
});
