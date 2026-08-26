// Deck slide 13 -- "Who is allowed to do what", as data.
//
// Capability scoping is enforced by the host, not by asking the agent
// nicely in a prompt. Every row below is a principal; every column a
// resource/action. Anything not granted is denied: `@intx/authz` is
// fail-closed (no matching grant -> null -> refusal), and the explicit
// denies below exist so a later, broader allow cannot accidentally win on
// specificity for the cells that must never open.
//
// Resource vocabulary (colon-separated, `*` glob):
//   credential:<institution>          read          -- institution tokens (R/O)
//   ledger:<table>                     read | write  -- fact tables by kind, finding, journal, ...
//   ledger:aggregates                  read          -- net worth, totals; no line items
//   ledger:positions                   read          -- positions without account identifiers
//   orders                             place
//   pii:full                           read          -- unmasked account numbers, balances
//   effect:<capability>                invoke        -- the workflow-runtime view of the same (see CAPABILITY_RESOURCES)

import { FACT_KINDS, type Principal } from "@fin/contracts";
import type { GrantRule } from "@intx/types/authz";

export interface MatrixRow {
  principal: Principal;
  /** Institution credentials: which, read-only. */
  credentials: "none" | "read_only" | "scoped_per_order";
  /** Ledger read scope. */
  read: "none" | "yes" | "aggregates" | "positions";
  /** Ledger write scope: the fact kinds / ledger tables this principal owns (slide 13 "Write ledger"). */
  write: readonly string[];
  /** Governance-chain records this principal may append (recommendation, approval, instruction, resolution). Not "the ledger". */
  records?: readonly string[];
  /**
   * Agent tool names this principal may invoke (`tool:<name>` grants; the
   * reactor authorizes every tool call through the same policy). Only the
   * advisory tier holds tools; the matrix is the authority and the
   * capability test cross-checks it against the bundles' static
   * declarations, so a tool added to a bundle without a matrix row here
   * is refused at runtime AND fails the test.
   */
  tools?: readonly string[];
  place_orders: "no" | "on_approval";
  pii: "full" | "masked";
}

/** The slide-13 rows plus the rest of the seventeen, derived from deck slides 6-9. */
export const MATRIX: readonly MatrixRow[] = [
  // Tier 1 -- ledger: own the facts
  { principal: "assets_manager", credentials: "read_only", read: "yes", write: ["fact:account", "fact:balance", "fact:position", "fact:lot"], place_orders: "no", pii: "full" },
  { principal: "liabilities", credentials: "read_only", read: "yes", write: ["fact:obligation"], place_orders: "no", pii: "full" },
  { principal: "cash_flow", credentials: "none", read: "yes", write: ["fact:transaction"], place_orders: "no", pii: "full" },
  { principal: "document_vault", credentials: "none", read: "yes", write: ["fact:tax_document", "document"], place_orders: "no", pii: "full" },
  { principal: "registry", credentials: "none", read: "yes", write: ["fact:entity", "fact:titling"], place_orders: "no", pii: "full" },
  // Tier 2 -- interpret: read-only over the ledger; compute; never fetch, never trade
  { principal: "reconciliation", credentials: "none", read: "yes", write: ["finding"], place_orders: "no", pii: "full" },
  { principal: "tax_engine", credentials: "none", read: "yes", write: ["finding"], place_orders: "no", pii: "full" },
  { principal: "risk", credentials: "none", read: "yes", write: ["finding"], place_orders: "no", pii: "full" },
  { principal: "projections", credentials: "none", read: "yes", write: [], place_orders: "no", pii: "masked" },
  // Tier 3 -- advise: propose only; no keys at all
  {
    principal: "strategist",
    credentials: "none",
    read: "aggregates",
    write: ["journal"],
    tools: ["ledger_read_aggregates", "list_subjects", "run_projection", "run_scenario", "journal_write", "household_profile", "save_draft"],
    place_orders: "no",
    pii: "masked",
  },
  // Slide 13: Market Manager "write ledger: no". Its proposals are *emitted*
  // (the agent's reply), then parsed and recorded by the Auditor's pipeline
  // (BUILD_PLAN §8.1 bridge action) -- so the `recommendation` record is the
  // Auditor's, not the Market Manager's. The capability test enforces this.
  {
    principal: "market_manager",
    credentials: "none",
    read: "positions",
    write: [],
    tools: ["ledger_read_positions", "read_plan_targets", "compute_rebalance", "emit_proposal"],
    place_orders: "no",
    pii: "masked",
  },
  {
    principal: "estate_planner",
    credentials: "none",
    read: "yes",
    write: ["finding"],
    tools: ["registry_read", "document_read", "emit_finding", "household_profile", "save_draft"],
    place_orders: "no",
    pii: "masked",
  },
  // Tier 4 -- govern: check, gate, remember
  { principal: "auditor", credentials: "none", read: "yes", write: [], records: ["recommendation", "verdict"], place_orders: "no", pii: "masked" },
  { principal: "execution", credentials: "scoped_per_order", read: "yes", write: ["receipt"], records: ["instruction"], place_orders: "on_approval", pii: "full" },
  { principal: "security", credentials: "none", read: "yes", write: ["access_log"], place_orders: "no", pii: "full" },
  { principal: "journal", credentials: "none", read: "yes", write: ["journal"], place_orders: "no", pii: "full" },
  { principal: "scheduler", credentials: "none", read: "yes", write: ["event"], place_orders: "no", pii: "masked" },
  // The human
  { principal: "operator", credentials: "none", read: "yes", write: ["journal"], records: ["approval", "resolution"], place_orders: "no", pii: "full" },
];

/** Ledger tables: the fact kinds plus the ledger-side records. Slide 13's "Write ledger" column. */
export const WRITE_TABLES = [
  ...FACT_KINDS.map((k) => `fact:${k}`),
  "finding",
  "document",
  "receipt",
  "journal",
  "access_log",
  "event",
] as const;
/** Governance-chain records (deck slide 12): proposals, signatures, instructions, and the operator's resolutions. */
export const RECORD_TABLES = ["recommendation", "verdict", "approval", "instruction", "resolution"] as const;

export function rowFor(p: Principal): MatrixRow {
  const r = MATRIX.find((m) => m.principal === p);
  if (r === undefined) throw new Error(`no matrix row for ${p}`);
  return r;
}

/**
 * Map the action-handler capability names (`action({ effect: { requires } })`)
 * onto matrix resources. The runtime authorizes `effect:<cap>` / `invoke`;
 * we translate to the matrix cell so one table governs both views.
 */
export function capabilityToResource(cap: string): { resource: string; action: string } {
  if (cap === "institution.read") return { resource: "credential:*", action: "read" };
  if (cap === "vault.write") return { resource: "ledger:document", action: "write" };
  if (cap === "ledger.write.finding") return { resource: "ledger:finding", action: "write" };
  if (cap === "ledger.emit") return { resource: "ledger:event", action: "write" };
  if (cap === "ledger.read") return { resource: "ledger:*", action: "read" };
  if (cap === "ledger.read.positions") return { resource: "ledger:positions", action: "read" };
  const rec = /^record\.([a-z_]+)$/.exec(cap);
  if (rec !== null) return { resource: `record:${rec[1] ?? ""}`, action: "write" };
  const m = /^ledger\.write\.fact\.([a-z_]+)$/.exec(cap);
  if (m !== null) return { resource: `ledger:fact:${m[1]}`, action: "write" };
  if (cap === "orders.place") return { resource: "orders", action: "place" };
  return { resource: `effect:${cap}`, action: "invoke" };
}

let grantSeq = 0;
function grant(principal: Principal, resource: string, action: string, effect: "allow" | "deny"): GrantRule {
  grantSeq += 1;
  return {
    id: `g${String(grantSeq)}:${principal}:${effect}:${resource}:${action}`,
    principalId: principal,
    roleId: null,
    resource,
    action,
    effect,
    origin: "system",
    conditions: null,
    expiresAt: null,
  };
}

/** Expand the matrix into grant rules. Deny-by-default plus explicit denies on the never-cells. */
export function matrixGrants(): GrantRule[] {
  const out: GrantRule[] = [];
  for (const row of MATRIX) {
    const p = row.principal;
    // credentials
    if (row.credentials === "none") out.push(grant(p, "credential:*", "read", "deny"));
    else out.push(grant(p, "credential:*", "read", "allow"));
    // read
    switch (row.read) {
      case "yes":
        out.push(grant(p, "ledger:*", "read", "allow"));
        break;
      case "aggregates":
        out.push(grant(p, "ledger:aggregates", "read", "allow"));
        out.push(grant(p, "ledger:journal", "read", "allow"));
        out.push(grant(p, "ledger:fact:*", "read", "deny"));
        break;
      case "positions":
        out.push(grant(p, "ledger:positions", "read", "allow"));
        out.push(grant(p, "ledger:fact:*", "read", "deny"));
        break;
      case "none":
        out.push(grant(p, "ledger:*", "read", "deny"));
        break;
    }
    // write: only the owned tables; everything else explicitly denied
    for (const t of WRITE_TABLES) {
      out.push(grant(p, `ledger:${t}`, "write", row.write.includes(t) ? "allow" : "deny"));
    }
    for (const t of RECORD_TABLES) {
      out.push(grant(p, `record:${t}`, "write", (row.records ?? []).includes(t) ? "allow" : "deny"));
    }
    // orders
    out.push(grant(p, "orders", "place", row.place_orders === "no" ? "deny" : "allow"));
    // pii
    out.push(grant(p, "pii:full", "read", row.pii === "full" ? "allow" : "deny"));
    // agent tools: exactly the named tools; everything else fails closed
    // (no matching grant -> null -> refusal), plus an explicit wildcard
    // deny for principals that hold no tools at all.
    if (row.tools !== undefined && row.tools.length > 0) {
      for (const t of row.tools) out.push(grant(p, `tool:${t}`, "invoke", "allow"));
    } else {
      out.push(grant(p, "tool:*", "invoke", "deny"));
    }
  }
  return out;
}
