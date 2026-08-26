// The Strategist's tool set (deck slides 8 and 13): aggregates, the
// deterministic projection/scenario engines, and the decision journal.
// No credential tool, no fact write, no order tool -- enforced by the
// tool set, not the prompt; the policy matrix grants exactly these
// names to the strategist principal and nothing else.
//
// Figures NEVER come from the model: every number the Strategist can
// quote is a field of one of these tools' results, computed by
// deterministic code over cited ledger facts.

import {
  assertType,
  decimal,
  ProjectionRequest,
  ScenarioRequest,
  type AccountPayload,
} from "@fin/contracts";
import { monteCarlo, resolveProjectionInputs, runScenario } from "@fin/actions";
import { views } from "@fin/ledger";
import { defineTool, type BaseEnv } from "@intx/agent";

import { finBundle, OBJECT_SCHEMA, type FinTool } from "./bundle";
import { saveDraftTool } from "./draft";
import { householdProfileTool } from "./profile";
import type { FinAgentEnvExtras } from "./env";

export const STRATEGIST_TOOL_NAMES = [
  "ledger_read_aggregates",
  "list_subjects",
  "run_projection",
  "run_scenario",
  "journal_write",
  "household_profile",
  "save_draft",
] as const;

export const aggregatesTool: FinTool = {
  definition: {
    name: "ledger_read_aggregates",
    description:
      "Read the household's aggregate financial position: assets, liabilities, net worth, and totals by account type. No account identifiers or line items. Returns the ledger fact ids the figures rest on.",
    inputSchema: OBJECT_SCHEMA({}),
  },
  handler: async (_args, fin) => {
    // Convert BEFORE summing: a euro property and a dollar account only
    // total honestly in one display currency. A currency with no rate is
    // excluded and NAMED, never silently mixed at face value.
    const fx = await fin.fx();
    const nw = views.netWorth(fin.ledger, { currency: fx.to, rates: fx.rates });
    const byType = new Map<string, string>();
    for (const line of nw.lines) {
      if (line.display_value != null) byType.set(line.type, decimal.add(byType.get(line.type) ?? "0", line.display_value));
    }
    return {
      result: {
        as_of: fin.clock().toISOString(),
        assets: nw.assets,
        liabilities: nw.liabilities,
        net_worth: nw.net_worth,
        currency: nw.currency,
        converted_at_ecb_rates_of: fx.date,
        ...(fx.stale ? { fx_stale: true } : {}),
        ...(nw.fx_missing.length > 0 ? { excluded_currencies_without_rates: nw.fx_missing } : {}),
        by_account_type: Object.fromEntries([...byType.entries()].sort()),
        provisional: nw.provisional,
      },
      fact_ids: nw.lines.flatMap((l) => l.fact_ids),
    };
  },
};

const listSubjects: FinTool = {
  definition: {
    name: "list_subjects",
    description:
      "List the household's account subjects (id, name, type) so a conversation can name a specific asset -- e.g. to run a scenario. No balances, no account numbers.",
    inputSchema: OBJECT_SCHEMA({}),
  },
  handler: async (_args, fin) => {
    const accounts = fin.ledger.asOf({ kind: "account" });
    return {
      result: {
        subjects: accounts.map((f) => {
          const p = f.payload as AccountPayload;
          return { subject: p.account_id, name: p.name, type: p.type };
        }),
      },
      fact_ids: accounts.map((f) => f.id),
      evidence: false,
    };
  },
};

const projection: FinTool = {
  definition: {
    name: "run_projection",
    description:
      "Run the deterministic Monte Carlo engine (annual GBM steps, seeded PRNG -- the same inputs always reproduce the same figures). start_value defaults to the current net worth. Returns per-year p10/p50/p90 and the ruin probability, with the fact ids behind the start value.",
    inputSchema: OBJECT_SCHEMA(
      {
        years: { type: "integer", minimum: 1, maximum: 60 },
        start_value: { type: "string", description: "decimal string; omit to use current net worth" },
        mu: { type: "string", description: "expected annual return, e.g. \"0.05\"" },
        sigma: { type: "string", description: "annual volatility, e.g. \"0.15\"" },
        annual_flow: { type: "string", description: "annual contribution (negative = withdrawal)" },
        paths: { type: "integer", minimum: 100, maximum: 20000 },
        seed: { type: "string" },
      },
      ["years"],
    ),
  },
  handler: async (args, fin) => {
    const req = assertType(ProjectionRequest, args, "run_projection arguments");
    const nw = views.netWorth(fin.ledger);
    const inputs = resolveProjectionInputs(req, { startValue: nw.net_worth, evidence: nw.lines.flatMap((l) => l.fact_ids) }, fin.clock().toISOString());
    const result = monteCarlo(inputs);
    return { result: result as unknown as Record<string, unknown>, fact_ids: result.evidence };
  },
};

const scenario: FinTool = {
  definition: {
    name: "run_scenario",
    description:
      "Run the deterministic sell-asset scenario: capital gain and depreciation recapture, the estimated-tax installment impact for the quarter the sale falls in (before/after/delta), and the trust-schedule consequences from the observed titling. Use list_subjects to find the asset's subject first. Every figure carries ledger fact ids; a missing basis is a caveat, never a guess.",
    inputSchema: OBJECT_SCHEMA(
      {
        subject: { type: "string", description: "account subject, e.g. acct.prop.rental" },
        sale_date: { type: "string", description: "YYYY-MM-DD" },
        sale_price: { type: "string", description: "decimal string; omit to use the ledger's current value" },
        cost_basis: { type: "string" },
        depreciation_taken: { type: "string" },
      },
      ["subject", "sale_date"],
    ),
  },
  handler: async (args, fin) => {
    const req = assertType(ScenarioRequest, { kind: "sell_asset", ...args }, "run_scenario arguments");
    const result = runScenario(
      { ledger: fin.ledger, taxProfile: fin.taxProfile(), estateFile: fin.estateFile(), now: fin.clock() },
      req,
    );
    return { result: result as unknown as Record<string, unknown>, fact_ids: result.evidence };
  },
};

const journalWrite: FinTool = {
  definition: {
    name: "journal_write",
    description:
      "Record a decision or thesis in the household's decision journal: what was decided or advised, why, and what is expected -- so it can be graded against reality later. refs are the ledger fact/finding ids the thesis rests on.",
    inputSchema: OBJECT_SCHEMA(
      {
        kind: { type: "string", enum: ["decision", "note"] },
        summary: { type: "string" },
        detail: { type: "object", additionalProperties: true },
        refs: { type: "array", items: { type: "string" } },
      },
      ["kind", "summary"],
    ),
  },
  handler: async (args, fin) => {
    const kind = args["kind"] === "decision" ? "decision" : "note";
    const summary = String(args["summary"] ?? "").trim();
    if (summary === "") throw new Error("journal_write: summary is required");
    const refs = Array.isArray(args["refs"]) ? args["refs"].filter((r): r is string => typeof r === "string") : [];
    const id = fin.ledger.appendJournal({
      at: fin.clock().toISOString(),
      kind,
      summary,
      detail: (args["detail"] as Record<string, unknown> | undefined) ?? {},
      refs,
      author: "strategist",
    });
    fin.journal(id);
    return { result: { journal_id: id }, fact_ids: refs, evidence: false };
  },
};

export const strategistTools = defineTool<BaseEnv & FinAgentEnvExtras>({
  id: "fin/strategist",
  requires: ["fin"],
  definitions: STRATEGIST_TOOL_NAMES.map((name) => ({ name })),
  factory: (env) => finBundle(env.fin, [aggregatesTool, listSubjects, projection, scenario, journalWrite, householdProfileTool, saveDraftTool]),
});
