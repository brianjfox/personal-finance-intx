// The Ledger Analyst's tool set (D-044): line-item reads over the
// transaction facts, and nothing else. No credential tool, no fact
// write, no journal, no finding, no draft, no order -- enforced by the
// tool set and by the policy matrix, which grants exactly these names
// to the ledger_analyst principal.
//
// Figures NEVER come from the model: every number the analyst can quote
// is a field of one of these results, computed by deterministic code in
// @fin/ledger views over cited facts. Rows carry account NAMES, never
// account numbers (the analyst's matrix row is pii: masked).

import { defineTool, type BaseEnv } from "@intx/agent";
import { views } from "@fin/ledger";

import { finBundle, OBJECT_SCHEMA, type FinTool } from "./bundle";
import type { FinAgentEnvExtras } from "./env";
import { listSubjectsTool } from "./strategist";

export const LEDGER_ANALYST_TOOL_NAMES = ["transactions_query", "transactions_summary", "cash_flow", "recurring_charges", "list_subjects"] as const;

const TXN_TYPES = ["debit", "credit", "buy", "sell", "dividend", "interest", "fee", "tax", "transfer_in", "transfer_out", "income", "swap", "other"];

const FILTER_PROPS = {
  subject: { type: "string", description: "restrict to one account subject (from list_subjects)" },
  from: { type: "string", description: "inclusive start date, YYYY-MM-DD" },
  to: { type: "string", description: "inclusive end date, YYYY-MM-DD" },
  types: { type: "array", items: { type: "string", enum: TXN_TYPES }, description: "restrict to these transaction types" },
  description_contains: { type: "string", description: "case-insensitive substring of the description or the institution's category" },
  min_abs_amount: { type: "string", description: "keep |amount| >= this (decimal string, native currency)" },
  max_abs_amount: { type: "string", description: "keep |amount| <= this (decimal string, native currency)" },
  include_internal: {
    type: "boolean",
    description: "include transfer legs between household accounts and in-account buy/sell/swap (default false: they are excluded and counted as excluded_internal)",
  },
} as const;

type Filter = Parameters<typeof views.transactionRows>[1] & object;

function filterOf(args: Record<string, unknown>): Filter {
  const f: Filter = {};
  const s = (k: string): string | undefined => (typeof args[k] === "string" && (args[k] as string).trim() !== "" ? (args[k] as string).trim() : undefined);
  const subject = s("subject");
  if (subject !== undefined) f.subject = subject;
  const from = s("from");
  if (from !== undefined) f.from = from;
  const to = s("to");
  if (to !== undefined) f.to = to;
  const dc = s("description_contains");
  if (dc !== undefined) f.description_contains = dc;
  const min = s("min_abs_amount");
  if (min !== undefined) f.min_abs_amount = min;
  const max = s("max_abs_amount");
  if (max !== undefined) f.max_abs_amount = max;
  if (Array.isArray(args["types"])) {
    const types = args["types"].filter((t): t is string => typeof t === "string" && TXN_TYPES.includes(t));
    if (types.length > 0) f.types = types as NonNullable<Filter["types"]>;
  }
  if (args["include_internal"] === true) f.include_internal = true;
  return f;
}

const transactionsQuery: FinTool = {
  definition: {
    name: "transactions_query",
    description:
      "List transactions matching a filter, newest first, paged (limit default 100, max 500), with totals over EVERY matched row per native currency (count, inflow, outflow, net). Each row: posted date, signed amount, currency, type, description, the institution's category, and the account NAME. Internal movement (transfers between household accounts, buy/sell/swap) is excluded by default and counted. Use this when the operator wants to see specific lines; use transactions_summary for totals by month, category, merchant, account, or type.",
    inputSchema: OBJECT_SCHEMA({
      ...FILTER_PROPS,
      limit: { type: "integer", minimum: 1, maximum: views.TRANSACTION_PAGE_MAX },
      offset: { type: "integer", minimum: 0 },
    }),
  },
  handler: async (args, fin) => {
    const q: Parameters<typeof views.transactionRows>[1] = { ...filterOf(args) };
    if (typeof args["limit"] === "number") q.limit = args["limit"];
    if (typeof args["offset"] === "number") q.offset = args["offset"];
    const v = views.transactionRows(fin.ledger, q);
    return { result: { as_of: fin.clock().toISOString(), ...v }, fact_ids: v.rows.map((r) => r.fact_id) };
  },
};

const transactionsSummary: FinTool = {
  definition: {
    name: "transactions_summary",
    description:
      "Total the matching transactions by month, category (the institution's own label), description (merchant, normalised), account, or type. One bucket per group and native currency -- currencies are never mixed -- with count, inflow, outflow, net, and the fact ids behind it; largest outflow first. Internal movement excluded by default. This is how you answer 'how much did I spend on X / per month / at Y'.",
    inputSchema: OBJECT_SCHEMA(
      {
        group_by: { type: "string", enum: ["month", "category", "description", "account", "type"] },
        ...FILTER_PROPS,
      },
      ["group_by"],
    ),
  },
  handler: async (args, fin) => {
    const g = args["group_by"];
    if (g !== "month" && g !== "category" && g !== "description" && g !== "account" && g !== "type") {
      throw new Error("transactions_summary: group_by must be one of month, category, description, account, type");
    }
    const v = views.transactionSummary(fin.ledger, { ...filterOf(args), group_by: g });
    return { result: { as_of: fin.clock().toISOString(), ...v }, fact_ids: v.buckets.flatMap((b) => b.fact_ids) };
  },
};

const cashFlow: FinTool = {
  definition: {
    name: "cash_flow",
    description:
      "Household cash flow by calendar month (default 12 months, max 60), converted into the operator's display currency at ECB rates: inflow, outflow, net, and the number of transactions behind each month. Only money that enters or leaves the household counts; transfer legs and asset conversions are excluded and counted. Currencies with no rate are excluded and NAMED.",
    inputSchema: OBJECT_SCHEMA({
      months: { type: "integer", minimum: 1, maximum: 60 },
      subject: { type: "string", description: "restrict to one account subject (from list_subjects)" },
    }),
  },
  handler: async (args, fin) => {
    const fx = await fin.fx();
    const opts: Parameters<typeof views.cashFlow>[1] = { currency: fx.to, rates: fx.rates, now: fin.clock() };
    if (typeof args["months"] === "number") opts.months = args["months"];
    if (typeof args["subject"] === "string" && args["subject"].trim() !== "") opts.subject = args["subject"].trim();
    const v = views.cashFlow(fin.ledger, opts);
    const facts = views.transactions(fin.ledger, opts.subject !== undefined ? { subject: opts.subject } : {});
    return {
      result: { as_of: fin.clock().toISOString(), converted_at_ecb_rates_of: fx.date, ...(fx.stale ? { fx_stale: true } : {}), ...v },
      fact_ids: facts.map((f) => f.id),
    };
  },
};

const recurring: FinTool = {
  definition: {
    name: "recurring_charges",
    description:
      "Detect recurring charges and credits deterministically: transactions grouped by normalised description, kept when they recur at a weekly, biweekly, monthly, quarterly, or annual cadence with consistent amounts (at least min_occurrences, default 3). Each item: description, cadence, occurrences, first/last date, typical (median) and latest amount, monthly equivalent, currency, account names, next expected date, and the fact ids. Plus monthly-equivalent totals per currency. Subscriptions, payroll, rent, loan payments live here. A charge with too few observations is not listed -- history accumulates nightly.",
    inputSchema: OBJECT_SCHEMA({
      subject: { type: "string", description: "restrict to one account subject (from list_subjects)" },
      from: { type: "string", description: "inclusive start date, YYYY-MM-DD" },
      to: { type: "string", description: "inclusive end date, YYYY-MM-DD" },
      min_occurrences: { type: "integer", minimum: 2, maximum: 52 },
    }),
  },
  handler: async (args, fin) => {
    const opts: Parameters<typeof views.recurringCharges>[1] = {};
    for (const k of ["subject", "from", "to"] as const) {
      if (typeof args[k] === "string" && args[k].trim() !== "") opts[k] = args[k].trim();
    }
    if (typeof args["min_occurrences"] === "number") opts.min_occurrences = args["min_occurrences"];
    const v = views.recurringCharges(fin.ledger, opts);
    return { result: { as_of: fin.clock().toISOString(), ...v }, fact_ids: v.charges.flatMap((c) => c.fact_ids) };
  },
};

export const ledgerAnalystTools = defineTool<BaseEnv & FinAgentEnvExtras>({
  id: "fin/analyst",
  requires: ["fin"],
  definitions: LEDGER_ANALYST_TOOL_NAMES.map((name) => ({ name })),
  factory: (env) => finBundle(env.fin, [transactionsQuery, transactionsSummary, cashFlow, recurring, listSubjectsTool]),
});
