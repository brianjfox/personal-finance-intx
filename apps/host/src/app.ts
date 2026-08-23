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

import { buildActions, type ActionContext } from "@fin/actions";
import { newId, type Principal } from "@fin/contracts";
import { loadInstitutions, type InstitutionAdapter, type LoadedInstitutions } from "@fin/institutions";
import { openLedger, type Ledger } from "@fin/ledger";
import { createPolicyAuthorize, type PolicyDecision } from "@fin/policy";
import { createVault, type Vault } from "@fin/vault";
import { allStepPrincipals, nightlyWorkflow, stepOutcomes, type StepOutcome } from "@fin/workflows";
import type { RunResult, WorkflowEvent } from "@intx/workflow";

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
  const actx: ActionContext = { ledger, vault, adapters: () => loaded.adapters, clock };
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

  const definitions = { [nightlyWorkflow.id]: nightlyWorkflow } as const;

  async function summarize(runId: string): Promise<RunSummary> {
    const events = await host.readLog(runId);
    const first = events[0];
    const last = events.at(-1);
    const terminal = last?.kind === "RunCompleted" ? "completed" : last?.kind === "RunFailed" ? "failed" : last?.kind === "RunCancelled" ? "cancelled" : "running";
    // Run ids are prefixed by workflow (`nightly_<ulid>`); RunStarted carries only a definition hash.
    const workflow = runId.startsWith("nightly") ? nightlyWorkflow.id : "unknown";
    return {
      runId,
      workflow,
      status: terminal,
      startedAt: first?.at ?? null,
      endedAt: terminal === "running" ? null : (last?.at ?? null),
      steps: stepOutcomes(events),
    };
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
        const def = definitions[s.workflow as keyof typeof definitions] ?? nightlyWorkflow;
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
    close() {
      ledger.close();
    },
  };
}
