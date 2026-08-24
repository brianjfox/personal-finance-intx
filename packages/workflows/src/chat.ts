// The chat surfaces (Phase 3, deck slides 8 and 19): one standing run
// per advisory agent, whose whole DAG is a single UNBOUNDED agent step.
//
// BUILD_PLAN §3 mapped the Strategist chat to `onTrigger` over a mail
// trigger; at the pinned framework version the simpler and stronger
// shape is `step({ triggers: "unbounded" })` (DECISIONS.md D-018): the
// runtime re-arms the step on a reserved input-park channel between
// turns, each delivered message is the next turn's input, a crash while
// parked re-parks on the recovered channel (the same machinery as the
// Phase 0 gate), and the agent's context lives in a durable git repo so
// the conversation itself survives restarts. `onTrigger`,
// `childWorkflow` and the mail transport stay unwired-loud until a
// product workflow needs a child.
//
// The launch trigger payload is the FIRST message: `{ run_key, text,
// message_id }`. The host discovers the current input channel from the
// run's reduced state and delivers subsequent messages there; each
// turn's reply is recorded by the host's step invoker as a ChatTurn in
// the ledger outbox -- the transcript is data with provenance, not
// scrollback.

import { estatePlannerAgent, strategistAgent, type ESTATE_PLANNER_AGENT_ID, type STRATEGIST_AGENT_ID } from "@fin/agents";
import type { ChatAgent, Principal } from "@fin/contracts";
import { defineWorkflow, step, type WorkflowDefinition } from "@intx/workflow";

export interface ChatWorkflowSpec {
  agent: ChatAgent;
  workflowId: string;
  runIdPrefix: string;
  /** Step ids are global across workflows in the principal table, so each chat step carries its agent. */
  stepId: string;
  agentId: typeof STRATEGIST_AGENT_ID | typeof ESTATE_PLANNER_AGENT_ID;
  principal: Principal;
}

export const CHAT_WORKFLOWS: readonly ChatWorkflowSpec[] = [
  { agent: "strategist", workflowId: "strategist-chat", runIdPrefix: "chatstrategist", stepId: "chat_strategist", agentId: "strategist", principal: "strategist" },
  { agent: "estate_planner", workflowId: "estate-chat", runIdPrefix: "chatestate", stepId: "chat_estate", agentId: "estate-planner", principal: "estate_planner" },
];

export function chatWorkflowSpec(agent: ChatAgent): ChatWorkflowSpec {
  const spec = CHAT_WORKFLOWS.find((s) => s.agent === agent);
  if (spec === undefined) throw new Error(`no chat workflow for agent ${agent}`);
  return spec;
}

/**
 * Build the chat workflow for one advisory agent. `model` names the
 * inference model; the host supplies the live source at agent build
 * time, so the definition stays hashable and key-free.
 */
export function buildChatWorkflow(agent: ChatAgent, model: string): { definition: WorkflowDefinition; stepPrincipals: Record<string, Principal>; spec: ChatWorkflowSpec } {
  const spec = chatWorkflowSpec(agent);
  const def = agent === "strategist" ? strategistAgent(model) : estatePlannerAgent(model);
  return {
    definition: defineWorkflow({
      id: spec.workflowId,
      triggers: [{ type: "manual" }],
      steps: {
        [spec.stepId]: step({
          agent: def,
          // The whole trigger payload ({ run_key, text, message_id }) is the
          // first turn's input; the invoker synthesizes it as the inbound
          // message content.
          input: { project: { from: "trigger.payload" }, fields: ["text", "message_id"] },
          triggers: "unbounded",
          drainBehavior: "wait",
        }),
      },
    }),
    stepPrincipals: { [spec.stepId]: spec.principal },
    spec,
  };
}

/** The reference instances the static tests and lints walk (model name is a placeholder there). */
export const REFERENCE_CHAT_MODEL = "claude-sonnet-5";
