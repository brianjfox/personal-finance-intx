// Model-backed `step` support for fin-host (Phase 3, D-010/D-018).
//
// Wraps `@intx/workflow-host`'s production `createWorkflowStepInvoker`
// (the `{ reply, turn }` envelope source) with the fin-specific env:
//
//   - The agent's context and audit live in ONE isogit repo per agent id
//     under `<dataDir>/context/<agentId>/` -- the conversation and the
//     tool-authorization trail survive restarts in the same git history
//     `bin/audit` reads. The cold instantiate-send-teardown path plus
//     the durable store IS the conversation continuity; no warm cache.
//   - Tool bundles get `env.fin` (ledger, tax profile, estate file,
//     clock) plus per-turn `evidence`/`journal` collectors. After every
//     completed turn the collectors and the reply are handed to
//     `onTurn` as a typed ChatTurn -- the transcript with provenance
//     the GUI renders and the outbox stores.
//   - Authorization flows through the SAME policy authorize the action
//     steps use: the reactor's per-tool-call `tool:<name> invoke` is
//     evaluated against the matrix under the step's principal.
//
// `agentFactory` is the test seam the production adapter already
// carries: tests inject a scripted agent and exercise every seam
// downstream of inference without a model or a key.

import fs from "node:fs";
import path from "node:path";

import type { ActionContext } from "@fin/actions";
import { CHAT_WORKFLOWS, type ChatWorkflowSpec } from "@fin/workflows";
import type { ChatAgent, ChatEvidence, ChatTurn } from "@fin/contracts";
import type { FinToolEnv } from "@fin/tools";
import { createDefaultDirectorRegistry, type Agent, type AgentDefinition, type BaseEnv } from "@intx/agent";
import { createIsogitStore } from "@intx/storage-isogit/node";
import type { InferenceSource } from "@intx/types/runtime";
import type { StepInvoker, WorkflowAuthorizeFn } from "@intx/workflow";
import { createWorkflowStepInvoker } from "@intx/workflow-host";

export interface FinStepInvokerOptions {
  dataDir: string;
  actx: Pick<ActionContext, "ledger" | "clock" | "taxProfile" | "estateFile" | "plan">;
  authorize: WorkflowAuthorizeFn;
  /** Resolve the live inference source; called per turn, throws loudly without a key. */
  source: () => InferenceSource;
  /** Called once per completed turn with the typed transcript entry. */
  onTurn: (turn: ChatTurn) => void;
  /** Test seam: a scripted agent instead of the real reactor+model. */
  agentFactory?: (def: AgentDefinition<BaseEnv>, env: BaseEnv) => Promise<Agent>;
}

const CHAT_BY_AGENT_ID = new Map<string, ChatWorkflowSpec>(CHAT_WORKFLOWS.map((s) => [s.agentId, s]));

interface TurnCollector {
  evidence: ChatEvidence[];
  journal: string[];
}

export function createFinStepInvoker(opts: FinStepInvokerOptions): StepInvoker {
  // One send is in flight per step at a time (the runtime serializes a
  // step's turns), and buildEnv runs per invocation -- so a per-invocation
  // collector handed to the tool env is race-free.
  let current: TurnCollector = { evidence: [], journal: [] };

  const inner = createWorkflowStepInvoker({
    workflowAuthorize: opts.authorize,
    buildEnv: async (req) => {
      const contextDir = path.join(opts.dataDir, "context", req.agent.id);
      fs.mkdirSync(contextDir, { recursive: true });
      const storage = await createIsogitStore(contextDir);
      const source = opts.source();
      const fin: FinToolEnv = {
        ledger: opts.actx.ledger,
        clock: opts.actx.clock,
        taxProfile: () => opts.actx.taxProfile?.() ?? null,
        estateFile: () => opts.actx.estateFile?.() ?? null,
        plan: () => opts.actx.plan?.() ?? null,
        evidence: (e) => current.evidence.push(e),
        journal: (id) => current.journal.push(id),
      };
      const env = {
        sources: [source],
        defaultSource: source.id,
        storage,
        workdir: contextDir,
        audit: storage,
        directors: createDefaultDirectorRegistry(),
        fin,
      };
      // The `fin` key is beyond BaseEnv; the bundles declare it via
      // `requires` and validateEnv checks it at instantiation.
      return env as typeof env & { fin: FinToolEnv };
    },
    ...(opts.agentFactory !== undefined ? { agentFactory: opts.agentFactory as never } : {}),
  });

  return async (req) => {
    current = { evidence: [], journal: [] };
    const message = messageOf(req.resume === undefined ? req.input : req.resume.kind === "input" ? req.resume.decision : null);
    const result = await inner(req);
    if ("output" in result) {
      const spec = CHAT_BY_AGENT_ID.get(req.agent.id);
      if (spec !== undefined && message !== null) {
        const output = result.output as { reply?: unknown };
        opts.onTurn({
          agent: spec.agent as ChatAgent,
          message_id: message.message_id,
          message: message.text,
          reply: typeof output.reply === "string" ? output.reply : JSON.stringify(output.reply ?? ""),
          evidence: current.evidence,
          journal_ids: current.journal,
          at: opts.actx.clock().toISOString(),
        });
      }
    }
    return result;
  };
}

/** Extract `{ text, message_id }` from a first input or an input-resume decision. */
function messageOf(raw: unknown): { text: string; message_id: string } | null {
  if (raw === null || typeof raw !== "object") return null;
  const o = raw as { text?: unknown; message_id?: unknown };
  if (typeof o.text !== "string" || typeof o.message_id !== "string") return null;
  return { text: o.text, message_id: o.message_id };
}

/** The Anthropic source fin-host uses; model from FIN_MODEL, key from ANTHROPIC_API_KEY. */
export function anthropicSourceFromEnv(): InferenceSource {
  const apiKey = process.env["ANTHROPIC_API_KEY"] ?? "";
  if (apiKey === "") {
    throw new Error(
      "fin-host: ANTHROPIC_API_KEY is not set; the advisory agents need an inference source. Export it (the key itself never enters the ledger or the logs).",
    );
  }
  const model = process.env["FIN_MODEL"] ?? "claude-sonnet-5";
  return {
    id: `anthropic:${model}`,
    provider: "anthropic",
    baseURL: "https://api.anthropic.com",
    apiKey,
    model,
  };
}
