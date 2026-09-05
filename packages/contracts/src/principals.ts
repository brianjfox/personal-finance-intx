// The agents of the interchange, named as principals.
//
// Deck slide 5: four tiers, seventeen agents (plus the Ledger Analyst,
// D-044: an eighteenth, read-only chat agent over transactions). Most of them are
// deterministic `action` handlers (BUILD_PLAN §3), but every one of them
// is a *principal* in the policy layer and a candidate `writer` on the
// ledger -- capability scoping is by who is acting, not by what code ran.

import { type } from "arktype";

export const LEDGER_PRINCIPALS = [
  "assets_manager",
  "liabilities",
  "cash_flow",
  "document_vault",
  "registry",
] as const;
export const INTERPRET_PRINCIPALS = [
  "reconciliation",
  "tax_engine",
  "risk",
  "projections",
] as const;
export const ADVISE_PRINCIPALS = ["strategist", "market_manager", "estate_planner", "ledger_analyst"] as const;
export const GOVERN_PRINCIPALS = [
  "auditor",
  "execution",
  "security",
  "journal",
  "scheduler",
] as const;
/** The human operating the system. Not an agent, but a principal: approvals and resolutions are theirs. */
export const HUMAN_PRINCIPALS = ["operator"] as const;

export const PRINCIPALS = [
  ...LEDGER_PRINCIPALS,
  ...INTERPRET_PRINCIPALS,
  ...ADVISE_PRINCIPALS,
  ...GOVERN_PRINCIPALS,
  ...HUMAN_PRINCIPALS,
] as const;

export type Principal = (typeof PRINCIPALS)[number];
export const Principal = type.enumerated(...PRINCIPALS);

export type Tier = "ledger" | "interpret" | "advise" | "govern" | "human";
export function tierOf(p: Principal): Tier {
  if ((LEDGER_PRINCIPALS as readonly string[]).includes(p)) return "ledger";
  if ((INTERPRET_PRINCIPALS as readonly string[]).includes(p)) return "interpret";
  if ((ADVISE_PRINCIPALS as readonly string[]).includes(p)) return "advise";
  if ((GOVERN_PRINCIPALS as readonly string[]).includes(p)) return "govern";
  return "human";
}
