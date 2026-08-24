// BUILD_PLAN §9 "Capability test: assert the slide-13 matrix cell by cell."
// Pulled forward from Phase 4 per STEPS.md: written in Phase 1 as a table
// that grows. The agent-tool-set halves (Strategist has no credential tool
// *factory*, etc.) are `todo` until the agents exist in Phase 3/4.

import { describe, expect, test } from "bun:test";

import { PRINCIPALS, type Principal } from "@fin/contracts";
import { createPolicyAuthorize, createPolicyStore, decide, MATRIX, RECORD_TABLES, rowFor, WRITE_TABLES } from "../src/index";

const store = createPolicyStore();
const allow = async (p: Principal, r: string, a: string) => (await decide(store, p, r, a)).effect === "allow";

// Deck slide 13, verbatim rows.
const SLIDE_13 = [
  //  principal            creds  read         write            orders  pii
  ["assets_manager", "R/O token", "yes", "own tables", "no", "yes"],
  ["tax_engine", "no", "yes", "own tables", "no", "yes"],
  ["strategist", "no", "aggregates", "journal only", "no", "masked"],
  ["market_manager", "no", "positions", "no", "no", "masked"],
  ["auditor", "no", "yes", "no", "no", "masked"],
  ["execution", "scoped, per-order", "yes", "receipts", "on approval", "yes"],
] as const;

describe("slide 13, cell by cell", () => {
  for (const [p, creds, read, write, orders, pii] of SLIDE_13) {
    const principal = p as Principal;
    test(`${principal}: institution credentials = ${creds}`, async () => {
      expect(await allow(principal, "credential:inst.schwab", "read")).toBe(creds !== "no");
    });
    test(`${principal}: read ledger = ${read}`, async () => {
      expect(await allow(principal, "ledger:fact:position", "read")).toBe(read === "yes");
      expect(await allow(principal, "ledger:aggregates", "read")).toBe(read === "yes" || read === "aggregates");
      expect(await allow(principal, "ledger:positions", "read")).toBe(read === "yes" || read === "positions");
      // A narrowed reader cannot read line-item facts of any kind.
      if (read !== "yes") {
        expect(await allow(principal, "ledger:fact:account", "read")).toBe(false);
        expect(await allow(principal, "ledger:fact:transaction", "read")).toBe(false);
      }
    });
    test(`${principal}: write ledger = ${write}`, async () => {
      const row = MATRIX.find((m) => m.principal === principal)!;
      for (const t of WRITE_TABLES) {
        expect(await allow(principal, `ledger:${t}`, "write")).toBe(row.write.includes(t));
      }
      if (write === "no") expect(row.write).toEqual([]);
      if (write === "journal only") expect(row.write).toEqual(["journal"]);
      if (write === "receipts") expect(row.write).toEqual(["receipt"]);
      for (const t of RECORD_TABLES) {
        expect(await allow(principal, `record:${t}`, "write")).toBe((row.records ?? []).includes(t));
      }
      // "own tables" means: some fact kinds, and no one else's.
      if (write === "own tables" && principal === "assets_manager") {
        expect(row.write).toEqual(["fact:account", "fact:balance", "fact:position", "fact:lot"]);
        expect(await allow(principal, "ledger:fact:transaction", "write")).toBe(false);
      }
    });
    test(`${principal}: place orders = ${orders}`, async () => {
      expect(await allow(principal, "orders", "place")).toBe(orders === "on approval");
    });
    test(`${principal}: sees full PII = ${pii}`, async () => {
      expect(await allow(principal, "pii:full", "read")).toBe(pii === "yes");
    });
  }
});

describe("invariants across all seventeen (plus the operator)", () => {
  test("the advisory tier holds no credential, writes no fact table, places no order", async () => {
    for (const p of ["strategist", "market_manager", "estate_planner"] as const) {
      expect(await allow(p, "credential:inst.any", "read")).toBe(false);
      for (const t of WRITE_TABLES.filter((x) => x.startsWith("fact:"))) {
        expect(await allow(p, `ledger:${t}`, "write")).toBe(false);
      }
      expect(await allow(p, "orders", "place")).toBe(false);
      expect(await allow(p, "pii:full", "read")).toBe(false);
    }
  });

  test("the governance chain: proposals recorded by the Auditor, signed by the operator, instructed by Execution", async () => {
    expect(await allow("auditor", "record:recommendation", "write")).toBe(true);
    expect(await allow("market_manager", "record:recommendation", "write")).toBe(false);
    expect(await allow("operator", "record:approval", "write")).toBe(true);
    expect(MATRIX.filter((m) => (m.records ?? []).includes("approval")).map((m) => m.principal)).toEqual(["operator"]);
    expect(MATRIX.filter((m) => (m.records ?? []).includes("instruction")).map((m) => m.principal)).toEqual(["execution"]);
  });

  test("exactly one principal may place orders, and only on approval", () => {
    const placers = MATRIX.filter((m) => m.place_orders !== "no");
    expect(placers.map((m) => m.principal)).toEqual(["execution"]);
    expect(placers[0]!.place_orders).toBe("on_approval");
  });

  test("every fact kind has exactly one writer in the matrix, and it is the contracts' FACT_WRITERS owner", async () => {
    const { FACT_WRITERS } = await import("@fin/contracts");
    for (const [kind, owner] of Object.entries(FACT_WRITERS)) {
      const writers = MATRIX.filter((m) => m.write.includes(`fact:${kind}`)).map((m) => m.principal);
      expect(writers).toEqual([owner]);
    }
  });

  test("the Market Manager never learns your account numbers (no pii:full, no account facts)", async () => {
    expect(await allow("market_manager", "pii:full", "read")).toBe(false);
    expect(await allow("market_manager", "ledger:fact:account", "read")).toBe(false);
    expect(await allow("market_manager", "ledger:positions", "read")).toBe(true);
  });

  test("deny by default: an unknown principal and an unknown resource both refuse", async () => {
    expect((await decide(store, "nobody" as Principal, "ledger:fact:position", "read")).effect).toBeNull();
    expect((await decide(store, "assets_manager", "mystery:thing", "poke")).effect).toBeNull();
    expect(PRINCIPALS).toHaveLength(MATRIX.length);
  });
});

describe("workflow authorize: step -> principal -> matrix cell", () => {
  test("a commit step run as assets_manager may write positions and not transactions; an unknown step is refused", async () => {
    const decisions: string[] = [];
    const authorize = createPolicyAuthorize({
      stepPrincipals: { commit_assets: "assets_manager", commit_flows: "cash_flow" },
      onDecision: (d) => decisions.push(`${String(d.stepId)}:${d.matrixResource}:${String(d.effect)}`),
    });
    const ctx = (stepId: string) => ({ stepId, runId: "r1", attempt: 1 });
    expect((await authorize("effect:ledger.write.fact.position", "invoke", ctx("commit_assets"))).effect).toBe("allow");
    expect((await authorize("effect:ledger.write.fact.transaction", "invoke", ctx("commit_assets"))).effect).toBe("deny");
    expect((await authorize("effect:ledger.write.fact.transaction", "invoke", ctx("commit_flows"))).effect).toBe("allow");
    expect((await authorize("effect:institution.read", "invoke", ctx("commit_flows"))).effect).toBe("deny");
    expect((await authorize("effect:ledger.write.fact.position", "invoke", ctx("mystery"))).effect).toBe("deny");
    expect((await authorize("effect:ledger.write.fact.position", "invoke", {})).effect).toBe("deny");
    expect(decisions).toEqual([
      "commit_assets:ledger:fact:position:allow",
      "commit_assets:ledger:fact:transaction:deny",
      "commit_flows:ledger:fact:transaction:allow",
      "commit_flows:credential:*:deny",
      "mystery:ledger:fact:position:null",
      "undefined:ledger:fact:position:null",
    ]);
  });
});

describe("tool-set halves (Phase 3: the advisory agents exist; Phase 4/5 rows stay todo)", () => {
  // The deploy-time capability walk the deck wants (slide 13): tool names
  // are STATICALLY declared on the factories, so these assertions never
  // instantiate an agent, and the matrix's `tools` column is the single
  // authority the reactor authorizes against at runtime.
  const FORBIDDEN = /credential|order|execute|trade|withdraw|transfer|commit|write_fact/i;

  test("Strategist: exactly the matrix's tools; no credential, execution, or fact-write tool; journal is the only write", async () => {
    const { strategistTools } = await import("@fin/tools");
    const { strategistAgent } = await import("@fin/agents");
    const declared = strategistTools.definitions.map((d) => d.name).sort();
    expect(declared).toEqual([...(rowFor("strategist").tools ?? [])].sort());
    for (const name of declared) expect(name).not.toMatch(FORBIDDEN);
    // The runtime enforces it: every declared tool authorizes as strategist, and a forged one refuses.
    for (const name of declared) expect(await allow("strategist", `tool:${name}`, "invoke")).toBe(true);
    expect(await allow("strategist", "tool:ledger_commit", "invoke")).toBe(false);
    expect(await allow("strategist", "tool:registry_read", "invoke")).toBe(false); // the estate planner's tool
    // The agent definition carries only this factory -- no second bundle can widen it silently.
    const def = strategistAgent("test-model");
    expect(def.toolFactories.map((f) => f.id)).toEqual(["fin/strategist"]);
  });

  test("Estate Planner: exactly the matrix's tools; findings only, no journal, no credentials", async () => {
    const { estateTools } = await import("@fin/tools");
    const { estatePlannerAgent } = await import("@fin/agents");
    const declared = estateTools.definitions.map((d) => d.name).sort();
    expect(declared).toEqual([...(rowFor("estate_planner").tools ?? [])].sort());
    for (const name of declared) expect(name).not.toMatch(FORBIDDEN);
    for (const name of declared) expect(await allow("estate_planner", `tool:${name}`, "invoke")).toBe(true);
    expect(await allow("estate_planner", "tool:journal_write", "invoke")).toBe(false);
    expect(await allow("estate_planner", "tool:run_scenario", "invoke")).toBe(false);
    const def = estatePlannerAgent("test-model");
    expect(def.toolFactories.map((f) => f.id)).toEqual(["fin/estate"]);
  });

  test("non-advisory principals hold no tools at all", async () => {
    for (const p of ["assets_manager", "reconciliation", "tax_engine", "scheduler", "operator"] as const) {
      expect(await allow(p, "tool:ledger_read_aggregates", "invoke")).toBe(false);
      expect(await allow(p, "tool:journal_write", "invoke")).toBe(false);
    }
  });

  test.todo("Market Manager agent definition has no tool that returns account identifiers or balances beyond positions");
  test.todo("Auditor narrator receives the verdict and has no tool that computes figures");
  test.todo("Execution is the only handler holding a write-scoped credential binding (Phase 5)");
});
