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
//   transactions [<needle>]         -> transactions_query (the Ledger Analyst)
//   spend by <group_by>             -> transactions_summary
//   recurring                       -> recurring_charges
//   cashflow                        -> cash_flow
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
        let reply: string;
        try {
          if (def.id === "market-manager") {
            reply = await runMarketScript(inputOf(content), call);
          } else {
            reply = await runScript(textOf(content), call);
          }
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

/**
 * The Market Manager script: the step input is the drift report (plus
 * attempt/prior on redrafts). Recompute through the REAL tools -- so
 * policy authorizes `tool:compute_rebalance` / `tool:emit_proposal`
 * under the market_manager principal -- pick candidate 0, and reply
 * with exactly the canonical draft JSON, as the prompt demands.
 */
async function runMarketScript(
  input: unknown,
  call: (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>,
): Promise<string> {
  const o = (input ?? {}) as { run_key?: string; candidates?: unknown[]; attempt?: number };
  const runKey = String(o.run_key ?? "");
  const report = await call("compute_rebalance", { run_key: runKey });
  const candidates = (report["candidates"] as unknown[] | undefined) ?? [];
  if (candidates.length === 0) return "NOTHING";
  // Test hook: a plan whose notes read `decline[: <reason>]` scripts the
  // prompt's rule-4 decline on judgement, reason and all.
  const plan = await call("read_plan_targets", {});
  const decline = /^decline(?::\s*(.*))?$/i.exec(String(plan["notes"] ?? "").trim());
  if (decline !== null) return decline[1] !== undefined && decline[1] !== "" ? `NOTHING: ${decline[1]}` : "NOTHING";
  const draft = await call("emit_proposal", {
    run_key: runKey,
    candidate_index: 0,
    thesis: `attempt ${String(o.attempt ?? 1)}: rebalance toward the written plan`,
    confidence: 0.7,
  });
  return JSON.stringify(draft);
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
  const txns = /^transactions(?: (.+))?$/.exec(text);
  if (txns !== null) {
    const args: Record<string, unknown> = txns[1] !== undefined ? { description_contains: txns[1] } : {};
    const r = (await call("transactions_query", args)) as { matched?: number; rows?: Array<{ description: string; amount: string; account: string | null }>; totals_by_currency?: Record<string, { inflow: string; outflow: string }> };
    const usd = r.totals_by_currency?.["USD"];
    const first = r.rows?.[0];
    return `${String(r.matched ?? 0)} transactions matched; USD inflow ${usd?.inflow ?? "0"}, outflow ${usd?.outflow ?? "0"}; newest: ${first?.description ?? "-"} ${first?.amount ?? ""} on ${first?.account ?? "?"} -- from transactions_query.`;
  }
  const spend = /^spend by (\w+)$/.exec(text);
  if (spend !== null) {
    const r = (await call("transactions_summary", { group_by: spend[1] })) as { buckets?: Array<{ key: string; inflow: string; outflow: string; count: number }> };
    return `buckets: ${(r.buckets ?? []).map((b) => `${b.key}=${b.inflow}/${b.outflow}(${String(b.count)})`).join(", ")} -- from transactions_summary.`;
  }
  if (text === "recurring") {
    const r = (await call("recurring_charges", {})) as { charges?: Array<{ normalized: string; cadence: string; typical_amount: string; occurrences: number; next_expected: string }> };
    return `recurring: ${(r.charges ?? []).map((c) => `${c.normalized} ${c.cadence} ${c.typical_amount} x${String(c.occurrences)} next ${c.next_expected}`).join("; ")} -- from recurring_charges.`;
  }
  if (text === "cashflow") {
    const r = (await call("cash_flow", { months: 6 })) as { months?: Array<{ month: string; inflow: string; outflow: string }> };
    return `cash flow: ${(r.months ?? []).map((m) => `${m.month} ${m.inflow}/${m.outflow}`).join(", ")} -- from cash_flow.`;
  }
  const journal = /^journal (.+)$/.exec(text);
  if (journal !== null) {
    const j = await call("journal_write", { kind: "note", summary: journal[1] as string });
    return `journaled ${String(j["journal_id"])}`;
  }
  return `echo: ${text}`;
}

/** The invoker JSON-stringifies the step's input object. */
function inputOf(content: unknown): unknown {
  if (typeof content !== "string") return null;
  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
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
