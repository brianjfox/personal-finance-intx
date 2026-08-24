// The fin-host application: ledger + vault + institutions + workflow host,
// assembled over one data directory. `createApp` is what the CLI, the IPC
// server and the tests construct.
//
//   <dataDir>/ledger.db            the household ledger (SQLite, WAL)
//   <dataDir>/vault/               original documents, content-addressed
//   <dataDir>/institutions.json    the institution registry
//   <dataDir>/institutions/<id>/inbox/   file-drop inboxes (jsondrop/csvdrop)
//   <dataDir>/runs|blobs|effects/  the workflow host (fs-host)

import fs from "node:fs";
import path from "node:path";

import { buildActions, quarterSpec, type ActionContext } from "@fin/actions";
import {
  assertType,
  newId,
  TAX_QUARTERS,
  TaxProfile,
  type Principal,
  type TaxQuarter,
  type TaxStage,
} from "@fin/contracts";
import { loadInstitutions, type InstitutionAdapter, type LoadedInstitutions } from "@fin/institutions";
import { openLedger, views, type Ledger } from "@fin/ledger";
import { createPolicyAuthorize, type PolicyDecision } from "@fin/policy";
import { createVault, type Vault } from "@fin/vault";
import {
  allStepPrincipals,
  buildTaxYearWorkflow,
  deadlineSignal,
  nightlyWorkflow,
  skipSignalId,
  stepOutcomes,
  taxCheckWorkflow,
  taxYearWorkflowId,
  type FireAtOverrides,
  type StepOutcome,
} from "@fin/workflows";
import type { RunResult, WorkflowDefinition, WorkflowEvent } from "@intx/workflow";

import { createFsHost, type FsHost } from "./fs-host/index";

export interface AppOptions {
  dataDir: string;
  clock?: () => Date;
  /** Override the registry (tests). */
  adapters?: InstitutionAdapter[];
  pollMs?: number;
}

export interface RunSummary {
  runId: string;
  workflow: string;
  status: "running" | "completed" | "failed" | "cancelled";
  startedAt: string | null;
  endedAt: string | null;
  steps: Record<string, StepOutcome>;
}

export interface TaxStageStatus {
  /** armed = parked on the deadline timer; ran = the check chain fired; skipped = operator skip signal. */
  state: "pending" | "armed" | "ran" | "skipped" | "failed";
  fire_at: string | null;
  /** Coverage verdict when the chain ran: true = covered, false = escalated. */
  covered: boolean | null;
}

export interface TaxQuarterStatus {
  quarter: TaxQuarter;
  due: string;
  period_end: string;
  pre: TaxStageStatus;
  due_stage: TaxStageStatus;
  obligation: { fact_id: string; amount: string | null; due: string | null; observed_at: string; superseded: boolean } | null;
  /** The latest `tax.estimate` outbox payload for this quarter (either stage). */
  estimate: unknown;
}

export interface TaxStatus {
  profile: TaxProfile | null;
  year: number | null;
  runId: string | null;
  runStatus: RunSummary["status"] | null;
  quarters: TaxQuarterStatus[];
}

export interface App {
  readonly dataDir: string;
  readonly ledger: Ledger;
  readonly vault: Vault;
  readonly host: FsHost;
  institutions(): LoadedInstitutions;
  reloadInstitutions(): LoadedInstitutions;
  /** Start (or resume) a nightly run. Resolves when the run is terminal. */
  runNightly(opts?: { runId?: string; institutions?: string[] }): Promise<RunResult>;
  /** Resume every non-terminal run on disk (startup). */
  resumeInFlight(): Promise<RunSummary[]>;
  listRuns(): Promise<RunSummary[]>;
  runEvents(runId: string): Promise<readonly WorkflowEvent[]>;
  /** The operator's tax profile from `<dataDir>/tax-profile.json`, or null. */
  taxProfile(): TaxProfile | null;
  /**
   * Launch the standing tax-year run (all deadline gates park, timers
   * arm). Returns immediately -- the run lives until every deadline has
   * fired or been skipped. Refuses when one is already running.
   */
  startTaxYear(opts?: { year?: number; leadDays?: number; fireAt?: FireAtOverrides }): Promise<{ runId: string }>;
  /** The running tax-year run, if any. */
  activeTaxYearRun(): Promise<{ runId: string; year: number } | null>;
  /** Run the manual `tax-check` workflow once and wait for it. */
  runTaxCheck(opts: { quarter: TaxQuarter; stage: TaxStage; runId?: string }): Promise<RunResult>;
  /** Deliver the operator's skip signal for a deadline gate (durable inbox; works while parked). */
  skipTaxDeadline(opts: { quarter: TaxQuarter; stage: TaxStage; note?: string; decidedBy?: string }): Promise<{ runId: string; signalId: string }>;
  taxStatus(): Promise<TaxStatus>;
  close(): void;
}

export function createApp(opts: AppOptions): App {
  const dataDir = path.resolve(opts.dataDir);
  fs.mkdirSync(dataDir, { recursive: true });
  const clock = opts.clock ?? (() => new Date());
  const ledger = openLedger(path.join(dataDir, "ledger.db"), { clock });
  const vault = createVault({ dir: path.join(dataDir, "vault"), ledger, clock });

  let loaded: LoadedInstitutions =
    opts.adapters !== undefined ? { entries: [], adapters: opts.adapters } : loadInstitutions(dataDir);
  const taxProfilePath = path.join(dataDir, "tax-profile.json");
  const taxProfile = (): TaxProfile | null => {
    if (!fs.existsSync(taxProfilePath)) return null;
    return assertType(TaxProfile, JSON.parse(fs.readFileSync(taxProfilePath, "utf8")), "tax-profile.json");
  };
  const actx: ActionContext = { ledger, vault, adapters: () => loaded.adapters, clock, taxProfile };
  const actions = buildActions(actx);

  // Every policy decision lands in the access log; denials are loud.
  const onDecision = (d: PolicyDecision): void => {
    ledger.logAccess({
      at: clock().toISOString(),
      principal: (d.principal ?? "operator") as Principal,
      resource: d.matrixResource,
      action: d.effect === "allow" ? "invoke" : "denied",
      detail: `${d.resource} ${d.action} -> ${String(d.effect)}${d.principal === null ? " (no principal for step)" : ""}`,
      run_id: d.runId ?? null,
      step_id: d.stepId ?? null,
    });
  };
  const authorize = createPolicyAuthorize({ stepPrincipals: allStepPrincipals(), onDecision });

  const host = createFsHost({
    dataDir,
    actions,
    authorize,
    clock,
    ...(opts.pollMs !== undefined ? { pollMs: opts.pollMs } : {}),
  });

  // Run ids are prefixed by workflow (`nightly_...`, `taxyear2026_...`,
  // `taxcheck_...`); RunStarted carries only a definition hash, so the
  // prefix is how a log on disk is matched back to its definition.
  const taxYearOf = (runId: string): number | null => {
    const m = /^taxyear(\d{4})_/.exec(runId);
    return m === null ? null : Number(m[1]);
  };
  function workflowOf(runId: string): string {
    if (runId.startsWith("nightly")) return nightlyWorkflow.id;
    if (runId.startsWith("taxcheck")) return taxCheckWorkflow.id;
    const year = taxYearOf(runId);
    if (year !== null) return taxYearWorkflowId(year);
    return "unknown";
  }
  function definitionFor(runId: string): WorkflowDefinition | null {
    if (runId.startsWith("nightly")) return nightlyWorkflow;
    if (runId.startsWith("taxcheck")) return taxCheckWorkflow;
    const year = taxYearOf(runId);
    if (year !== null) {
      // Rebuilding with the current clock is safe: gates already parked
      // re-adopt their durable absolute timers; only never-parked gates
      // read these timeouts, and (deadline - now) is correct whenever
      // it is computed (see tax-year.ts).
      return buildTaxYearWorkflow({ taxYear: year, now: clock() }).definition;
    }
    return null;
  }

  async function summarize(runId: string): Promise<RunSummary> {
    const events = await host.readLog(runId);
    const first = events[0];
    const last = events.at(-1);
    const terminal = last?.kind === "RunCompleted" ? "completed" : last?.kind === "RunFailed" ? "failed" : last?.kind === "RunCancelled" ? "cancelled" : "running";
    return {
      runId,
      workflow: workflowOf(runId),
      status: terminal,
      startedAt: first?.at ?? null,
      endedAt: terminal === "running" ? null : (last?.at ?? null),
      steps: stepOutcomes(events),
    };
  }

  // Standing runs this process is driving; failures land here loudly
  // rather than as unhandled rejections.
  const standing = new Map<string, Promise<RunResult>>();
  function drive(definition: WorkflowDefinition, runId: string, triggerPayload?: unknown): Promise<RunResult> {
    const run = host.run(definition, { runId, ...(triggerPayload !== undefined ? { triggerPayload } : {}) });
    const p = run.complete;
    standing.set(runId, p);
    p.then(
      (r) => {
        if (r.terminalStatus !== "completed") {
          process.stderr.write(`fin-host: standing run ${runId} ended ${r.terminalStatus}\n`);
        }
      },
      (e: unknown) => {
        process.stderr.write(`fin-host: standing run ${runId} crashed: ${String(e)}\n`);
      },
    ).finally(() => standing.delete(runId));
    return p;
  }

  return {
    dataDir,
    ledger,
    vault,
    host,
    institutions: () => loaded,
    reloadInstitutions() {
      loaded = loadInstitutions(dataDir);
      return loaded;
    },
    async runNightly(o = {}) {
      const runId = o.runId ?? newId("nightly");
      const run = host.run(nightlyWorkflow, {
        runId,
        triggerPayload: { run_key: runId, ...(o.institutions !== undefined ? { institutions: o.institutions } : {}) },
      });
      return run.complete;
    },
    async resumeInFlight() {
      const out: RunSummary[] = [];
      for (const runId of host.listRuns()) {
        const s = await summarize(runId);
        if (s.status !== "running") continue;
        const def = definitionFor(runId) ?? nightlyWorkflow;
        if (taxYearOf(runId) !== null) {
          // A standing run: start driving it (parked gates re-arm their
          // timers) and report it as running -- it may stay parked for
          // months and must not block startup.
          drive(def, runId);
          out.push({ ...s, status: "running" });
          continue;
        }
        try {
          await host.run(def, { runId }).complete;
        } catch {
          // The runtime refuses some resumes (D-006); the log records why.
        }
        out.push(await summarize(runId));
      }
      return out;
    },
    async listRuns() {
      const ids = host.listRuns();
      const all = await Promise.all(ids.map(summarize));
      return all.sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""));
    },
    runEvents(runId) {
      return host.readLog(runId);
    },
    taxProfile,
    async startTaxYear(o = {}) {
      const profile = taxProfile();
      if (profile === null) {
        throw new Error(`tax: no ${taxProfilePath}; write the operator's tax profile before starting a tax year`);
      }
      const year = o.year ?? profile.tax_year;
      const active = await this.activeTaxYearRun();
      if (active !== null && active.year === year) {
        throw new Error(`tax: run ${active.runId} is already standing for ${String(year)}`);
      }
      const built = buildTaxYearWorkflow({
        taxYear: year,
        now: clock(),
        ...(o.leadDays !== undefined ? { leadDays: o.leadDays } : profile.prestage_lead_days !== undefined ? { leadDays: profile.prestage_lead_days } : {}),
        ...(o.fireAt !== undefined ? { fireAt: o.fireAt } : {}),
      });
      const runId = `taxyear${String(year)}_${newId("r").slice(2)}`;
      drive(built.definition, runId, { run_key: runId, tax_year: year });
      return { runId };
    },
    async activeTaxYearRun() {
      for (const runId of host.listRuns()) {
        const year = taxYearOf(runId);
        if (year === null) continue;
        const s = await summarize(runId);
        if (s.status === "running") return { runId, year };
      }
      return null;
    },
    async runTaxCheck(o) {
      const profile = taxProfile();
      if (profile === null) throw new Error("tax: no tax profile configured");
      const runId = o.runId ?? `taxcheck_${newId("r").slice(2)}`;
      const run = host.run(taxCheckWorkflow, {
        runId,
        triggerPayload: { run_key: runId, tax_year: profile.tax_year, quarter: o.quarter, stage: o.stage },
      });
      return run.complete;
    },
    async skipTaxDeadline(o) {
      const active = await this.activeTaxYearRun();
      if (active === null) throw new Error("tax: no standing tax-year run to signal");
      const signalId = skipSignalId(active.year, o.quarter, o.stage);
      const who = o.decidedBy ?? "operator";
      // The decision (who, why) is journaled HERE, durably, at delivery
      // time -- the workflow's skip step journals only the consumption
      // and deliberately reads nothing from the signal payload (D-015).
      ledger.appendJournal({
        at: clock().toISOString(),
        kind: "decision",
        subject: `household.tax.${String(active.year)}`,
        summary: `tax ${String(active.year)} Q${String(o.quarter)} ${o.stage}: ${who} asked to skip the deadline check${o.note ? ` -- ${o.note}` : ""}`,
        detail: { quarter: o.quarter, stage: o.stage, note: o.note ?? null, signal_id: signalId },
        refs: [],
        author: who,
      });
      host.deliver(active.runId, deadlineSignal(o.quarter, o.stage), { note: o.note ?? null, decided_by: who }, signalId);
      return { runId: active.runId, signalId };
    },
    async taxStatus() {
      const profile = taxProfile();
      const active = await this.activeTaxYearRun();
      const year = active?.year ?? profile?.tax_year ?? null;
      const summary = active === null ? null : await summarize(active.runId);
      const events = active === null ? [] : await host.readLog(active.runId);
      const fireAts = new Map<string, string>();
      for (const e of events) {
        if (e.kind === "TimerSet" && typeof (e as { stepId?: string }).stepId === "string") {
          fireAts.set((e as { stepId: string }).stepId, (e as unknown as { fireAt: string }).fireAt);
        }
      }
      const estimates = new Map<number, unknown>();
      // Coverage verdicts come from the durable outbox, not the run log:
      // the run body may buffer its step events until the next segment
      // boundary, while `tax.ready` / `tax.estimate` are durable the
      // moment the handler's effect commits.
      const ready = new Set<string>();
      const shortfall = new Set<string>();
      for (const ev of ledger.eventsSince(0, 10_000)) {
        if (ev.kind !== "tax.estimate" && ev.kind !== "tax.ready") continue;
        const p = ev.payload as { tax_year?: number; quarter?: number; stage?: string; reserve_ok?: boolean };
        if (year !== null && ev.kind === "tax.estimate" && p.tax_year !== year) continue;
        const key = `${String(p.quarter)}:${String(p.stage)}`;
        if (ev.kind === "tax.ready") {
          ready.add(key);
        } else {
          estimates.set(p.quarter ?? 0, ev.payload); // later events overwrite: seq order
          if (p.reserve_ok === false) shortfall.add(key);
          else shortfall.delete(key);
        }
      }
      const obligations = year === null ? [] : views.obligations(ledger).filter((ob) => ob.subject === `household.tax.${String(year)}`);
      const quarters: TaxQuarterStatus[] = [];
      for (const quarter of TAX_QUARTERS) {
        const spec = year === null ? null : quarterSpec(year, quarter);
        const stage = (s: TaxStage): TaxStageStatus => {
          const sfx = `q${String(quarter)}_${s}`;
          const steps = summary?.steps ?? {};
          const wait = steps[`wait_${sfx}`];
          const est = steps[`est_${sfx}`];
          const skip = steps[`skip_${sfx}`];
          const ok = steps[`ok_${sfx}`];
          const esc = steps[`esc_${sfx}`];
          let state: TaxStageStatus["state"] = "pending";
          if (wait?.status === "awaiting-signal") state = "armed";
          else if (est?.status === "completed") state = "ran";
          else if (est?.status === "failed" || skip?.status === "failed") state = "failed";
          else if (skip?.status === "completed" && wait?.status === "completed") state = "skipped";
          const key = `${String(quarter)}:${s}`;
          let covered: boolean | null = null;
          if (ready.has(key) || ok?.status === "completed") covered = true;
          else if (shortfall.has(key) || esc?.status === "completed") covered = false;
          return { state, fire_at: fireAts.get(`wait_${sfx}`) ?? null, covered };
        };
        const ob = obligations.find((x) => x.key === `q${String(quarter)}`) ?? null;
        quarters.push({
          quarter,
          due: spec?.due ?? "",
          period_end: spec?.periodEnd ?? "",
          pre: stage("pre"),
          due_stage: stage("due"),
          obligation:
            ob === null
              ? null
              : { fact_id: ob.fact_id, amount: ob.amount, due: ob.due, observed_at: ob.observed_at, superseded: ob.supersedes !== null },
          estimate: estimates.get(quarter) ?? null,
        });
      }
      return {
        profile,
        year,
        runId: active?.runId ?? null,
        runStatus: summary?.status ?? null,
        quarters,
      };
    },
    close() {
      ledger.close();
    },
  };
}
