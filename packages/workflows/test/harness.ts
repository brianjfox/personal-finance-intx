// Test harness: run a product workflow under `runLocal` against a fresh
// ledger, vault and fixture adapters, with the real policy authorize.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildActions, type ActionContext } from "@fin/actions";
import type { InvestmentPlan, TaxProfile } from "@fin/contracts";
import type { InstitutionAdapter } from "@fin/institutions";
import { openLedger, type Ledger } from "@fin/ledger";
import { createPolicyAuthorize, type PolicyDecision } from "@fin/policy";
import { createVault, type Vault } from "@fin/vault";
import { runLocal, type RunResult, type StepInvoker, type WorkflowDefinition, type WorkflowRun } from "@intx/workflow";
import { proposalLoopFns } from "../src/proposal";

import type { RegisteredWorkflow } from "../src/index";

export interface Harness {
  ledger: Ledger;
  vault: Vault;
  dir: string;
  decisions: PolicyDecision[];
  setAdapters: (a: InstitutionAdapter[]) => void;
  setTaxProfile: (p: TaxProfile | null) => void;
  setInvestmentPlan: (p: InvestmentPlan | null) => void;
  run: (w: RegisteredWorkflow, payload: unknown, opts?: { now?: string; runId?: string; invokeStep?: StepInvoker }) => Promise<RunResult>;
  /** Like `run` but returns the live handle (for standing runs that need signals). */
  start: (w: RegisteredWorkflow, payload: unknown, opts?: { now?: string; runId?: string; invokeStep?: StepInvoker }) => WorkflowRun;
}

export function harness(opts: { now?: string } = {}): Harness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fin-wf-"));
  let nowIso = opts.now ?? "2026-08-23T06:00:00.000Z";
  const clock = () => new Date(nowIso);
  const ledger = openLedger(path.join(dir, "ledger.db"), { clock });
  const vault = createVault({ dir: path.join(dir, "vault"), ledger, clock });
  let adapters: InstitutionAdapter[] = [];
  let taxProfile: TaxProfile | null = null;
  let investmentPlan: InvestmentPlan | null = null;
  const actx: ActionContext = { ledger, vault, adapters: () => adapters, clock, taxProfile: () => taxProfile, plan: () => investmentPlan };
  const actions = buildActions(actx);
  const decisions: PolicyDecision[] = [];
  let seq = 0;
  const start = (w: RegisteredWorkflow, payload: unknown, o: { now?: string; runId?: string; invokeStep?: StepInvoker } = {}): WorkflowRun => {
    if (o.now !== undefined) nowIso = o.now;
    seq += 1;
    const runId = o.runId ?? `run-${String(seq)}`;
    const authorize = createPolicyAuthorize({ stepPrincipals: w.stepPrincipals, onDecision: (d) => decisions.push(d) });
    return runLocal(w.definition as WorkflowDefinition, {
      runId,
      triggerPayload: { run_key: runId, ...(payload as object) },
      actionResolver: (ref) => {
        const h = actions[ref];
        if (h === undefined) throw new Error(`no handler ${ref}`);
        return h;
      },
      authorize,
      clock,
      loopFns: proposalLoopFns,
      ...(o.invokeStep !== undefined ? { invokeStep: o.invokeStep } : {}),
    });
  };
  return {
    ledger,
    vault,
    dir,
    decisions,
    setAdapters: (a) => {
      adapters = a;
    },
    setTaxProfile: (p) => {
      taxProfile = p;
    },
    setInvestmentPlan: (p) => {
      investmentPlan = p;
    },
    run: async (w, payload, o = {}) => start(w, payload, o).complete,
    start,
  };
}
