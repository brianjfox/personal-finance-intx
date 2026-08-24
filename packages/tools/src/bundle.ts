// Shared bundle plumbing: dispatch by name, never throw (errors become
// isError ToolResults the model can read and recover from), and record
// every successful structured result as turn evidence with its fact ids.

import type { ChatEvidence } from "@fin/contracts";
import type { ToolBundle } from "@intx/agent";
import type { ToolCall, ToolDefinition, ToolResult } from "@intx/types/runtime";

import type { FinToolEnv } from "./env";

export interface FinTool {
  definition: ToolDefinition;
  /** Compute the structured result and the ledger fact ids it cites. */
  handler: (args: Record<string, unknown>, fin: FinToolEnv) => Promise<{ result: Record<string, unknown>; fact_ids: string[]; evidence?: boolean }>;
}

export function finBundle(fin: FinToolEnv, tools: readonly FinTool[]): ToolBundle {
  const byName = new Map(tools.map((t) => [t.definition.name, t]));
  return {
    definitions: tools.map((t) => t.definition),
    async run(call: ToolCall): Promise<ToolResult> {
      const t = byName.get(call.name);
      if (t === undefined) {
        return { callId: call.id, content: `unknown tool: ${call.name}`, isError: true };
      }
      try {
        const { result, fact_ids, evidence } = await t.handler(call.arguments, fin);
        if (evidence !== false) {
          const e: ChatEvidence = { tool: call.name, result, fact_ids, at: fin.clock().toISOString() };
          fin.evidence(e);
        }
        return { callId: call.id, content: result };
      } catch (cause) {
        return { callId: call.id, content: cause instanceof Error ? cause.message : String(cause), isError: true };
      }
    },
  };
}

export const OBJECT_SCHEMA = (props: Record<string, unknown>, required: string[] = []): Record<string, unknown> => ({
  type: "object",
  properties: props,
  required,
  additionalProperties: false,
});
