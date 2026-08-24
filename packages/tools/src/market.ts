// The Market Manager's tool set (deck slides 8 and 13): positions (no
// balances beyond positions, no masked numbers), the written plan, the
// deterministic drift engine, and `emit_proposal` -- which canonicalizes
// a draft FROM a drift candidate so the model NEVER types a figure. No
// credential tool, no execution tool, no ledger write of any kind.

import { assertType, InvestmentPlan, type PositionPayload } from "@fin/contracts";
import { buildProposalDraft, computeDrift } from "@fin/actions";
import { defineTool, type BaseEnv } from "@intx/agent";

import { finBundle, OBJECT_SCHEMA, type FinTool } from "./bundle";
import type { FinAgentEnvExtras, FinToolEnv } from "./env";

export const MARKET_TOOL_NAMES = ["ledger_read_positions", "read_plan_targets", "compute_rebalance", "emit_proposal"] as const;

function planOf(fin: FinToolEnv): InvestmentPlan {
  const raw = fin.plan();
  if (raw === null) throw new Error("no plan.json is configured; there is no written plan to rebalance against");
  return assertType(InvestmentPlan, raw, "plan.json");
}

function driftNow(fin: FinToolEnv, runKey: string) {
  return computeDrift({
    runKey,
    now: fin.clock(),
    plan: planOf(fin),
    positions: fin.ledger.asOf({ kind: "position" }),
    lots: fin.ledger.asOf({ kind: "lot" }),
  });
}

const readPositions: FinTool = {
  definition: {
    name: "ledger_read_positions",
    description: "Read current positions: account subject, symbol, asset class, quantity, price, market value. No account numbers, no non-position balances.",
    inputSchema: OBJECT_SCHEMA({}),
  },
  handler: async (_args, fin) => {
    const facts = fin.ledger.asOf({ kind: "position" });
    return {
      result: {
        positions: facts.map((f) => {
          const p = f.payload as PositionPayload;
          return {
            account: p.account_id,
            symbol: p.instrument.symbol,
            asset_class: p.instrument.asset_class,
            quantity: p.quantity,
            price: p.price ?? null,
            market_value: p.market_value ?? null,
          };
        }),
      },
      fact_ids: facts.map((f) => f.id),
    };
  },
};

const readPlan: FinTool = {
  definition: {
    name: "read_plan_targets",
    description: "Read the written investment plan: target allocation, drift band, and standing constraints (do-not-sell, max order value, max position weight, tax-cash horizon).",
    inputSchema: OBJECT_SCHEMA({}),
  },
  handler: async (_args, fin) => ({ result: planOf(fin) as unknown as Record<string, unknown>, fact_ids: [], evidence: false }),
};

const rebalance: FinTool = {
  definition: {
    name: "compute_rebalance",
    description:
      "Run the deterministic drift engine: class weights vs the plan's targets, and canonical candidate orders for every out-of-band class (largest drift first). The Auditor re-runs exactly this; a proposal that does not match a candidate is blocked as unreproducible. Arguments: run_key from your task input.",
    inputSchema: OBJECT_SCHEMA({ run_key: { type: "string" } }, ["run_key"]),
  },
  handler: async (args, fin) => {
    const runKey = String(args["run_key"] ?? "");
    if (runKey === "") throw new Error("compute_rebalance: run_key is required");
    const report = driftNow(fin, runKey);
    return { result: report as unknown as Record<string, unknown>, fact_ids: report.evidence };
  },
};

const emitProposal: FinTool = {
  definition: {
    name: "emit_proposal",
    description:
      "Canonicalize ONE drift candidate into a proposal draft: pass the candidate_index from compute_rebalance plus your thesis and confidence. The returned draft carries the candidate's exact figures and the evidence fact ids -- reply with EXACTLY this JSON and nothing else. 'No evidence, no proposal.'",
    inputSchema: OBJECT_SCHEMA(
      {
        run_key: { type: "string" },
        candidate_index: { type: "integer", minimum: 0 },
        thesis: { type: "string", minLength: 1 },
        confidence: { type: "number", minimum: 0, maximum: 1 },
      },
      ["run_key", "candidate_index", "thesis", "confidence"],
    ),
  },
  handler: async (args, fin) => {
    const runKey = String(args["run_key"] ?? "");
    const report = driftNow(fin, runKey);
    const draft = buildProposalDraft(report, Number(args["candidate_index"]), {
      thesis: String(args["thesis"] ?? ""),
      confidence: Number(args["confidence"]),
      now: fin.clock(),
    });
    return { result: draft as unknown as Record<string, unknown>, fact_ids: draft.evidence };
  },
};

export const marketTools = defineTool<BaseEnv & FinAgentEnvExtras>({
  id: "fin/market",
  requires: ["fin"],
  definitions: MARKET_TOOL_NAMES.map((name) => ({ name })),
  factory: (env) => finBundle(env.fin, [readPositions, readPlan, rebalance, emitProposal]),
});
