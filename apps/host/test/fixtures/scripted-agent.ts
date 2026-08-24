// A scripted stand-in for the model (the step invoker's documented
// `agentFactory` seam): everything DOWNSTREAM of inference is real --
// the tool bundles run against the real ledger, authorization goes
// through the policy matrix exactly where the reactor's authz extension
// would call it, evidence and journal ids are collected by the real
// invoker, and the reply is recorded as a real ChatTurn. Only the
// "which tool, what words" decision is scripted.
//
// Command protocol (the test speaks it in `text`):
//   aggregates                      -> ledger_read_aggregates
//   sell <subject> <date> basis <n> dep <n>
//                                   -> run_scenario, then journal_write (the thesis)
//   registry                        -> registry_read
//   journal <summary...>            -> journal_write (to probe authorization)
//   anything else                   -> echoed reply, no tools

import type { Agent, AgentDefinition, BaseEnv, ToolBundle } from "@intx/agent";
import type { ScenarioResult } from "@fin/contracts";

export function scriptedAgentFactory(): (def: AgentDefinition<BaseEnv>, env: BaseEnv) => Promise<Agent> {
  return async (def, env) => {
    const factory = def.toolFactories[0];
    if (factory === undefined) throw new Error("scripted agent: definition has no tool factory");
    const bundle: ToolBundle = factory(env as never);
    let seq = 0;
    // Mirror the reactor's authz extension: authorize `tool:<name> invoke`
    // through the same env.authorize the real assembly would call.
    const call = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const decision = await env.authorize(`tool:${name}`, "invoke", undefined);
      if (decision.effect !== "allow") {
        throw new Error(`tool ${name} refused by policy (${String(decision.effect)})`);
      }
      seq += 1;
      const res = await bundle.run({ id: `call-${String(seq)}`, name, arguments: args }, new AbortController().signal);
      if (res.isError === true) throw new Error(typeof res.content === "string" ? res.content : JSON.stringify(res.content));
      return res.content as Record<string, unknown>;
    };

    return {
      async send(content) {
        const text = textOf(content);
        let reply: string;
        try {
          reply = await runScript(text, call);
        } catch (cause) {
          reply = `error: ${cause instanceof Error ? cause.message : String(cause)}`;
        }
        return { type: "reply", reply, turn: { role: "assistant", content: [{ type: "text", text: reply }] } as never };
      },
      stream() {
        throw new Error("scripted agent: stream() is not consumed without onEvent");
      },
      deliver() {
        /* not used by the invoker */
      },
      async close() {
        await bundle.dispose?.();
      },
      // The invoker never touches the surfaces below; present for the type.
      setSource() {},
      setSources() {},
      async history() {
        return [];
      },
      async checkpoints() {
        return [];
      },
      async readAt() {
        return [];
      },
      blobReader: {
        async read() {
          throw new Error("scripted agent: no blobs");
        },
      } as never,
    };
  };
}

async function runScript(text: string, call: (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>): Promise<string> {
  if (text === "aggregates") {
    const r = await call("ledger_read_aggregates", {});
    return `Net worth is ${String(r["net_worth"])} (assets ${String(r["assets"])}, liabilities ${String(r["liabilities"])}) -- from ledger_read_aggregates.`;
  }
  const sell = /^sell (\S+) (\d{4}-\d{2}-\d{2}) basis (\S+) dep (\S+)$/.exec(text);
  if (sell !== null) {
    const [, subject, date, basis, dep] = sell as unknown as [string, string, string, string, string];
    const s = (await call("run_scenario", { subject, sale_date: date, cost_basis: basis, depreciation_taken: dep })) as unknown as ScenarioResult;
    const thesis = `Selling ${subject} on ${date}: total tax ${s.tax?.total_tax ?? "?"}, Q${String(s.tax?.quarter ?? "?")} installment moves by ${s.tax?.installment_delta ?? "?"}; ${s.trust.in_trust ? `the asset sits in ${s.trust.trust ?? "a trust"} and the schedule must be updated` : "no trust impact"}.`;
    const j = await call("journal_write", { kind: "decision", summary: thesis, refs: s.evidence.slice(0, 8) });
    return `${thesis} (figures from run_scenario; journaled as ${String(j["journal_id"])})`;
  }
  if (text === "registry") {
    const r = (await call("registry_read", {})) as { entities?: unknown[]; observed_titling?: unknown[] };
    return `Registry holds ${String((r.entities ?? []).length)} entities and ${String((r.observed_titling ?? []).length)} observed titlings -- from registry_read.`;
  }
  const journal = /^journal (.+)$/.exec(text);
  if (journal !== null) {
    const j = await call("journal_write", { kind: "note", summary: journal[1] as string });
    return `journaled ${String(j["journal_id"])}`;
  }
  return `echo: ${text}`;
}

/** The invoker JSON-stringifies the projected `{ text, message_id }` input. */
function textOf(content: unknown): string {
  if (typeof content !== "string") return "";
  try {
    const o = JSON.parse(content) as { text?: unknown };
    return typeof o.text === "string" ? o.text : content;
  } catch {
    return content;
  }
}
