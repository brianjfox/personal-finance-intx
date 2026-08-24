// Phase 4 through fin-host: the approval queue over a real proposal run
// -- scripted Market Manager driving the REAL tools (authorized as
// market_manager by the matrix), the real Auditor, the durable approval
// signal, and the prepared-never-sent instruction. Including the
// property the phase is named for: the DECISION delivered through the
// durable inbox while no host is running, honored on the next start.

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { SnapshotAccount } from "@fin/contracts";
import { fixtureAdapter, type InstitutionAdapter } from "@fin/institutions";
import type { InferenceSource } from "@intx/types/runtime";

import { createApp, type App } from "../src/app";
import { scriptedAgentFactory } from "./fixtures/scripted-agent";

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "fin-p4-"));
const stubSource = (): InferenceSource => ({ id: "stub", provider: "anthropic", baseURL: "http://localhost:1", apiKey: "stub", model: "stub" });

function writePlan(dataDir: string): void {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, "plan.json"),
    JSON.stringify({
      as_of: "2026-08-01",
      band: "0.05",
      targets: [
        { asset_class: "etf", weight: "0.55" },
        { asset_class: "equity", weight: "0.05" },
        { asset_class: "bond", weight: "0.4" },
      ],
      constraints: { do_not_sell: [], tax_cash_horizon_days: 60 },
    }),
  );
}

function adapters(now: Date): InstitutionAdapter[] {
  const asOf = now.toISOString();
  const broker: SnapshotAccount[] = [
    {
      account_id: "acct.broker.taxable",
      name: "Taxable",
      type: "brokerage",
      currency: "USD",
      as_of: asOf,
      balances: [{ balance_type: "total", amount: "108000" }],
      positions: [
        { instrument: { symbol: "VTI", asset_class: "etf" }, quantity: "240", price: "250", market_value: "60000", cost_basis: "50000" },
        { instrument: { symbol: "AAPL", asset_class: "equity" }, quantity: "100", price: "300", market_value: "30000", cost_basis: "12000", lots: [{ lot_id: "aapl-2020", quantity: "100", acquired_at: "2020-02-01", cost_basis: "12000" }] },
        { instrument: { symbol: "BND", asset_class: "bond" }, quantity: "100", price: "100", market_value: "10000", cost_basis: "10500" },
        { instrument: { symbol: "CASH", asset_class: "cash" }, quantity: "8000", price: "1", market_value: "8000", cost_basis: "8000" },
      ],
      transactions: [],
    },
  ];
  return [fixtureAdapter("inst.broker", { accounts: broker })];
}

const openApp = (dataDir: string): App =>
  createApp({ dataDir, adapters: adapters(new Date()), pollMs: 20, agentFactory: scriptedAgentFactory(), inferenceSource: stubSource });

describe("phase 4 through fin-host: the approval queue", () => {
  test("propose -> queue -> decide through the durable inbox while no host runs -> prepared -> revoke", async () => {
    const dataDir = tmp();
    writePlan(dataDir);
    const seed = openApp(dataDir);
    expect((await seed.runNightly({ runId: "nightly_p4" })).terminalStatus).toBe("completed");
    seed.close();

    // A separate process proposes (real tools under the market_manager
    // principal, real auditor) and exits with the run parked at the gate.
    const child = Bun.spawn(["bun", path.join(import.meta.dir, "fixtures/propose-child.ts"), dataDir], { stdout: "pipe", stderr: "pipe" });
    const out = await new Response(child.stdout).text();
    expect(await child.exited).toBe(0);
    const proposed = JSON.parse(out.trim().split("\n").at(-1) ?? "{}") as { state: string; runId: string; recommendation_id: string };
    expect(proposed.state).toBe("queued");

    // Inspect from the outside (no driver): the queue holds the cleared rec.
    const app = openApp(dataDir);
    const queue = app.approvalQueue();
    expect(queue).toHaveLength(1);
    const rec = queue[0]!.recommendation;
    expect(rec.id).toBe(proposed.recommendation_id);
    expect(rec.action).toMatchObject({ verb: "BUY", instrument: "BND", quantity: "300" });
    expect(queue[0]!.verdict.cleared).toBe(true);
    for (const id of rec.evidence) expect(app.ledger.getFact(id)).not.toBeNull();
    // The scripted agent's tool calls flowed through the policy under
    // market_manager and none were denied.
    expect(app.ledger.listAccess(2000).some((a) => a.action === "denied")).toBe(false);

    // The operator decides while NO host drives the run: durable inbox only.
    await app.decideRecommendation({
      recommendationId: rec.id,
      decision: "approve",
      bound: { max_quantity: "250", limit_price: "101" },
      note: "trim toward plan",
      signedBy: "brian",
      wait: false,
    });
    app.close();

    // The next host consumes it: decide -> route -> prepare -> run completes.
    const restart = Bun.spawn(["bun", path.join(import.meta.dir, "fixtures/resume-child.ts"), dataDir, proposed.runId, "until-complete"], { stdout: "pipe", stderr: "pipe" });
    const out2 = await new Response(restart.stdout).text();
    expect(await restart.exited).toBe(0);
    expect(out2).toContain('"event":"done"');

    const app2 = openApp(dataDir);
    const instructions = app2.listPreparedInstructions();
    expect(instructions).toHaveLength(1);
    expect(instructions[0]!.current_status).toBe("prepared"); // never "sent"
    expect(instructions[0]!.bound).toMatchObject({ max_quantity: "250", limit_price: "101" });
    expect(app2.approvalQueue()).toHaveLength(0);
    const journal = app2.ledger.listJournal().map((j) => j.summary).join("\n");
    expect(journal).toContain("auditor cleared");
    expect(journal).toContain("approved rec_");
    expect(journal).toContain("PREPARED (not sent -- execution is disabled)");

    // Revocable until sent -- and nothing is ever sent. Idempotent.
    const first = app2.revokeInstruction({ instructionId: instructions[0]!.id, note: "changed my mind" });
    expect(first.replayed).toBe(false);
    expect(app2.revokeInstruction({ instructionId: instructions[0]!.id }).replayed).toBe(true);
    expect(app2.listPreparedInstructions()[0]!.current_status).toBe("revoked");
    app2.close();
  }, 90_000);
});
