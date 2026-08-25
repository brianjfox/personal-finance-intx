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

import {
  buildActions,
  approvalSignalId,
  monteCarlo,
  quarterSpec,
  resolveProjectionInputs,
  runScenario,
  type ActionContext,
} from "@fin/actions";
import {
  assertType,
  EstateFile,
  InvestmentPlan,
  newId,
  TAX_QUARTERS,
  TaxProfile,
  type ChatAgent,
  type ChatTurn,
  type Principal,
  type ProjectionRequest,
  type ProjectionResult,
  type ScenarioRequest,
  type ScenarioResult,
  type TaxQuarter,
  type TaxStage,
} from "@fin/contracts";
import {
  addInstitutionEntry,
  COINBASE_SERVICE,
  detectWalletHolding,
  parseCoinbaseCredential,
  parseCoinbaseKey,
  defaultSecretStore,
  ENABLEBANKING_SERVICE,
  loadInstitutions,
  PLAID_SERVICE,
  removeInstitutionEntry,
  setInstitutionEnabled as setEnabledInRegistry,
  updateInstitutionOptions,
  type InstitutionAdapter,
  type InstitutionEntry,
  type LoadedInstitutions,
  type WalletHolding,
} from "@fin/institutions";
import { approvalQueue, listInstructions, markInstruction, openLedger, verdictsFor, views, type Ledger, type QueuedApproval, type InstructionRow } from "@fin/ledger";
import { createPolicyAuthorize, type PolicyDecision } from "@fin/policy";
import { createVault, type Vault } from "@fin/vault";
import {
  allStepPrincipals,
  APPROVAL_SIGNAL,
  buildChatWorkflow,
  buildProposalWorkflow,
  buildTaxYearWorkflow,
  CHAT_WORKFLOWS,
  chatWorkflowSpec,
  deadlineSignal,
  ESTATE_AUDIT_ID,
  estateAuditWorkflow,
  nightlyWorkflow,
  PROPOSAL_ID,
  proposalLoopFns,
  skipSignalId,
  stepOutcomes,
  taxCheckWorkflow,
  taxYearWorkflowId,
  type FireAtOverrides,
  type StepOutcome,
} from "@fin/workflows";
import type { Agent, AgentDefinition, BaseEnv } from "@intx/agent";
import type { InferenceSource } from "@intx/types/runtime";
import type { RunResult, WorkflowDefinition, WorkflowEvent } from "@intx/workflow";

import { createConnectors, type ConnectorConfig } from "./connect";
import {
  credentialsStatus,
  deleteConnectionTokens,
  deleteCredential,
  setCredential,
  type CredentialsStatus,
} from "./credentials";
import { seedDemo } from "./demo";
import { runBreakGlassExport, type BreakGlassResult } from "./export/break-glass";
import { anthropicSourceFromEnv, createFinStepInvoker, createFsHost, type FsHost } from "./fs-host/index";
import {
  closeManagedAccount,
  initManagedInstitution,
  isManaged,
  readManagedAccounts,
  upsertManagedAccount,
  type ManagedAccount,
  type UpsertManagedInput,
} from "./managed";

export interface AppOptions {
  dataDir: string;
  clock?: () => Date;
  /** Override the registry (tests). */
  adapters?: InstitutionAdapter[];
  pollMs?: number;
  /** Test seam: a scripted agent instead of the real reactor+model. */
  agentFactory?: (def: AgentDefinition<BaseEnv>, env: BaseEnv) => Promise<Agent>;
  /** Test seam: the inference source resolver (default: Anthropic from env). */
  inferenceSource?: () => InferenceSource;
  /** Model the chat definitions name (default FIN_MODEL or claude-sonnet-5). */
  model?: string;
  /** Connector config (Plaid / Enable Banking): secret store, base-URL overrides (tests/mocks), redirect URL. */
  connectors?: Partial<ConnectorConfig>;
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
  /** Everything the Institutions page shows: registry entries joined with ledger accounts and open fetch problems. */
  institutionsOverview(): InstitutionsOverview;
  /**
   * Create a connection from the GUI. `managed` = the operator types
   * values into forms (the host writes the snapshots); `files` = export
   * files are uploaded into the inbox. Both are jsondrop underneath.
   */
  addInstitution(input: { name: string; mode: "managed" | "files" }): InstitutionEntry;
  /** Remove a connection from the registry. Ledger history and inbox files stay -- nothing is erased. */
  removeInstitution(institutionId: string): boolean;
  /** Pause/resume a connection without losing its configuration or history. */
  setInstitutionEnabled(institutionId: string, enabled: boolean): boolean;
  /** Store an uploaded export file into the institution's inbox; call `refreshInstitution` after. */
  storeInstitutionFile(institutionId: string, filename: string, bytes: Uint8Array): { filename: string };
  /** Reconcile one institution now (a nightly scoped to it). */
  refreshInstitution(institutionId: string): Promise<{ runId: string; status: string }>;
  /** The managed (typed-in) accounts of a managed institution. */
  managedAccounts(institutionId: string): ManagedAccount[];
  /** Add or update a managed account, then reconcile that institution. */
  saveManagedAccount(institutionId: string, input: UpsertManagedInput): Promise<{ account: ManagedAccount; runId: string; status: string }>;
  /** Remove a managed account: it is observed at 0 (history stays), then reconciled. */
  removeManagedAccount(institutionId: string, accountId: string): Promise<{ runId: string; status: string }>;
  /** One click of made-up data: seed the fictional household and run the first reconciliation. */
  seedDemoData(): Promise<{ institutions: number; runId: string; status: string }>;
  /** Plaid, step 1: a Hosted Link session for the operator to open in the browser. */
  connectPlaidStart(): Promise<{ link_token: string; hosted_link_url: string | null }>;
  /**
   * Plaid, step 2: exchange the finished Link session (or an explicit
   * public_token) for the read-only access token, store it in the secret
   * store, and reconcile. New entry by `name`, or a reconnect of an
   * existing `institutionId`.
   */
  connectPlaidComplete(opts: { name?: string; institutionId?: string; linkToken?: string; publicToken?: string }): Promise<{ institution_id: string; runId: string; status: string }>;
  /** Enable Banking: the banks available in a country (two-letter code). */
  ebListBanks(country: string): Promise<Array<{ name: string; country: string }>>;
  /** Enable Banking, step 1: start the bank's own consent page. New entry by `name`, or a reconnect of `institutionId`. */
  connectEbStart(opts: { name?: string; institutionId?: string; country: string; bank: string; redirectUrl?: string }): Promise<{ url: string; state: string }>;
  /** Enable Banking, step 2: the code from the redirect becomes a 90-180 day read-only session; store and reconcile. */
  connectEbComplete(opts: { state: string; code: string }): Promise<{ institution_id: string; consent_until: string | null; runId: string; status: string }>;
  /**
   * Coinbase: store the view-only CDP API key (name + EC private key)
   * in the secret store, add the entry (or rotate `institutionId`'s
   * key), and reconcile. The key is validated before it is stored.
   */
  connectCoinbase(opts: { name?: string; institutionId?: string; apiKeyName: string; privateKey: string }): Promise<{ institution_id: string; runId: string; status: string }>;
  /**
   * Watch-only wallet (Ledger/Trezor/any): public addresses only --
   * structurally unable to move funds. Rows without an explicit kind are
   * chain-detected from the address syntax; unrecognized rows refuse in
   * plain words rather than guessing.
   */
  connectWallet(opts: { name?: string; holdings: Array<{ value: string; label?: string; kind?: WalletHolding["kind"] }> }): Promise<{ institution_id: string; runId: string; status: string }>;
  /** The Credentials page: which keys are set (presence only -- values never leave the host). */
  credentialsStatus(): CredentialsStatus;
  /** Store a global credential (Anthropic / Plaid / Enable Banking); validated before storing; Anthropic takes effect without a restart. */
  setCredential(id: string, values: Record<string, string>): void;
  /** Remove a stored global credential. */
  deleteCredential(id: string): boolean;
  /** Remove the per-connection tokens an institution owns (also happens on institution delete). */
  deleteConnectionTokens(institutionId: string): number;
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
  /** The operator's estate plan from `<dataDir>/estate.json`, or null. */
  estateFile(): EstateFile | null;
  /** Run the estate hygiene audit (sync estate.json into registry facts, then plan-vs-reality checks). */
  runEstateAudit(): Promise<RunResult>;
  estateStatus(): EstateStatus;
  /** Deterministic sell-asset scenario -- no model involved. */
  runScenarioNow(req: ScenarioRequest): ScenarioResult;
  /** Deterministic Monte Carlo -- no model involved. */
  runProjectionNow(req: ProjectionRequest): ProjectionResult;
  /**
   * Send a message to an advisory agent's standing chat run (started
   * lazily on the first message). With `wait`, resolves with the
   * recorded ChatTurn; otherwise returns the message id to poll for.
   */
  sendChat(opts: { agent: ChatAgent; text: string; wait?: boolean; timeoutMs?: number }): Promise<{ message_id: string; turn: ChatTurn | null }>;
  /** The recorded conversation, oldest first. */
  chatTranscript(agent: ChatAgent): ChatTurn[];
  activeChatRun(agent: ChatAgent): Promise<{ runId: string } | null>;
  /** The written investment plan from `<dataDir>/plan.json`, or null. */
  plan(): InvestmentPlan | null;
  /**
   * Start a rebalance-proposal run: drift -> Market Manager draft ->
   * Auditor -> (cleared) the approval queue. Resolves once the run is
   * parked at the approval gate or terminal (blocked/exhausted).
   */
  startProposal(opts?: { timeoutMs?: number }): Promise<{ runId: string; state: "queued" | "terminal"; status: string }>;
  /** The home screen's top half: cleared, unexpired, undecided recommendations. */
  approvalQueue(): QueuedApproval[];
  /**
   * Deliver the operator's decision on a queued recommendation: scoped
   * to that proposal id, bounded, expiring; idempotent by signal id
   * (D-001). Works through the durable inbox while no host runs.
   */
  decideRecommendation(opts: {
    recommendationId: string;
    decision: "approve" | "reject";
    bound?: { max_quantity?: string | null; limit_price?: string | null };
    note?: string;
    signedBy?: string;
    wait?: boolean;
    timeoutMs?: number;
  }): Promise<{ runId: string; signalId: string }>;
  listPreparedInstructions(): InstructionRow[];
  /** Revocable until sent -- and in Phase 4 nothing is ever sent. */
  revokeInstruction(opts: { instructionId: string; by?: string; note?: string }): { replayed: boolean };
  /** The break-glass export (slide 21): CSVs, documents, the operating guide. */
  exportBreakGlass(opts?: { outDir?: string }): BreakGlassResult;
  close(): void;
}

export interface InstitutionAccountRow {
  account_id: string;
  name: string;
  type: string;
  currency: string;
  /** Latest ledger value (net-worth line), or the typed-in value when no nightly has run yet. */
  value: string | null;
  observed_at: string | null;
  closed: boolean;
}

export interface InstitutionOverview {
  institution_id: string;
  name: string;
  adapter: InstitutionEntry["adapter"];
  enabled: boolean;
  managed: boolean;
  accounts: InstitutionAccountRow[];
  /** Open `fetch_failed` findings for this institution, in plain words. */
  problems: string[];
  /** For connector institutions: when the bank consent runs out (Enable Banking). */
  consent_until: string | null;
  /** For Enable Banking institutions: which bank, for the reconnect flow. */
  aspsp: { name: string; country: string } | null;
}

export interface InstitutionsOverview {
  institutions: InstitutionOverview[];
  /** True once the ledger holds any account line at all. */
  hasFacts: boolean;
}

export interface EstateStatus {
  configured: boolean;
  entities: Array<{ subject: string; fact_id: string; payload: unknown }>;
  titling: Array<{ subject: string; fact_id: string; payload: unknown }>;
  plan: EstateFile["plan"] | null;
  openFindings: number;
  lastAudit: unknown;
}

function isAspsp(v: unknown): v is { name: string; country: string } {
  return typeof v === "object" && v !== null && typeof (v as Record<string, unknown>)["name"] === "string" && typeof (v as Record<string, unknown>)["country"] === "string";
}

export function createApp(opts: AppOptions): App {
  const dataDir = path.resolve(opts.dataDir);
  fs.mkdirSync(dataDir, { recursive: true });
  const clock = opts.clock ?? (() => new Date());
  const ledger = openLedger(path.join(dataDir, "ledger.db"), { clock });
  const vault = createVault({ dir: path.join(dataDir, "vault"), ledger, clock });

  // Connector credentials (Plaid, Enable Banking) resolve through one
  // secret store: env + macOS Keychain by default, injected in tests.
  const secrets = opts.connectors?.secrets ?? defaultSecretStore();
  const connectorCfg: ConnectorConfig = {
    secrets,
    clock,
    ...(opts.connectors?.plaidBaseUrl ?? process.env["FIN_PLAID_BASE_URL"]
      ? { plaidBaseUrl: (opts.connectors?.plaidBaseUrl ?? process.env["FIN_PLAID_BASE_URL"]) as string }
      : {}),
    plaidEnvironment: opts.connectors?.plaidEnvironment ?? (process.env["FIN_PLAID_ENV"] === "sandbox" ? "sandbox" : "production"),
    ...(opts.connectors?.ebBaseUrl ?? process.env["FIN_EB_BASE_URL"]
      ? { ebBaseUrl: (opts.connectors?.ebBaseUrl ?? process.env["FIN_EB_BASE_URL"]) as string }
      : {}),
    ...(opts.connectors?.ebRedirectUrl !== undefined
      ? { ebRedirectUrl: opts.connectors.ebRedirectUrl }
      : process.env["FIN_EB_REDIRECT_URL"] !== undefined
        ? { ebRedirectUrl: process.env["FIN_EB_REDIRECT_URL"] }
        : {}),
    ...(opts.connectors?.coinbaseBaseUrl ?? process.env["FIN_COINBASE_BASE_URL"]
      ? { coinbaseBaseUrl: (opts.connectors?.coinbaseBaseUrl ?? process.env["FIN_COINBASE_BASE_URL"]) as string }
      : {}),
    ...(opts.connectors?.walletApis !== undefined ? { walletApis: opts.connectors.walletApis } : {}),
    ...(opts.connectors?.fetchImpl !== undefined ? { fetchImpl: opts.connectors.fetchImpl } : {}),
  };
  const connectors = createConnectors(connectorCfg);
  const reloadRegistry = (): LoadedInstitutions => loadInstitutions(dataDir, undefined, secrets);
  /** Registry options a new connector entry should carry (mock base URLs in tests, environment otherwise). */
  const plaidEntryOptions = (): Record<string, unknown> =>
    connectorCfg.plaidBaseUrl !== undefined ? { base_url: connectorCfg.plaidBaseUrl } : { environment: connectorCfg.plaidEnvironment };
  const storeSecret = (service: string, account: string, value: string): void => {
    if (secrets.set === undefined) throw new Error("the configured secret store cannot persist tokens");
    secrets.set(service, account, value);
  };

  let loaded: LoadedInstitutions =
    opts.adapters !== undefined ? { entries: [], adapters: opts.adapters } : reloadRegistry();
  const taxProfilePath = path.join(dataDir, "tax-profile.json");
  const taxProfile = (): TaxProfile | null => {
    if (!fs.existsSync(taxProfilePath)) return null;
    return assertType(TaxProfile, JSON.parse(fs.readFileSync(taxProfilePath, "utf8")), "tax-profile.json");
  };
  const estateFilePath = path.join(dataDir, "estate.json");
  const estateFile = (): EstateFile | null => {
    if (!fs.existsSync(estateFilePath)) return null;
    return assertType(EstateFile, JSON.parse(fs.readFileSync(estateFilePath, "utf8")), "estate.json");
  };
  const planPath = path.join(dataDir, "plan.json");
  const plan = (): InvestmentPlan | null => {
    if (!fs.existsSync(planPath)) return null;
    return assertType(InvestmentPlan, JSON.parse(fs.readFileSync(planPath, "utf8")), "plan.json");
  };
  const actx: ActionContext = { ledger, vault, adapters: () => loaded.adapters, clock, taxProfile, estateFile, plan };
  const actions = buildActions(actx);
  const model = opts.model ?? process.env["FIN_MODEL"] ?? "claude-sonnet-5";

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

  // Model-backed steps (Phase 3): every completed chat turn lands in the
  // outbox as a typed ChatTurn, idempotent by message id.
  const invokeStep = createFinStepInvoker({
    dataDir,
    actx,
    authorize,
    source: opts.inferenceSource ?? anthropicSourceFromEnv,
    onTurn: (turn) => {
      ledger.emitEvent({
        id: `chat:${turn.agent}:${turn.message_id}`,
        kind: "chat.turn",
        subject: `chat.${turn.agent}`,
        payload: turn,
      });
    },
    ...(opts.agentFactory !== undefined ? { agentFactory: opts.agentFactory } : {}),
  });

  const host = createFsHost({
    dataDir,
    actions,
    invokeStep,
    loopFns: proposalLoopFns,
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
  const chatSpecOf = (runId: string) => CHAT_WORKFLOWS.find((s) => runId.startsWith(`${s.runIdPrefix}_`)) ?? null;
  /** Runs that live indefinitely (or for days at the approval gate): driven without awaiting, resumed as running. */
  const isStandingRun = (runId: string): boolean => taxYearOf(runId) !== null || chatSpecOf(runId) !== null || runId.startsWith("proposal_");
  function workflowOf(runId: string): string {
    if (runId.startsWith("nightly")) return nightlyWorkflow.id;
    if (runId.startsWith("taxcheck")) return taxCheckWorkflow.id;
    if (runId.startsWith("estateaudit")) return ESTATE_AUDIT_ID;
    if (runId.startsWith("proposal_")) return PROPOSAL_ID;
    const chat = chatSpecOf(runId);
    if (chat !== null) return chat.workflowId;
    const year = taxYearOf(runId);
    if (year !== null) return taxYearWorkflowId(year);
    return "unknown";
  }
  function definitionFor(runId: string): WorkflowDefinition | null {
    if (runId.startsWith("nightly")) return nightlyWorkflow;
    if (runId.startsWith("taxcheck")) return taxCheckWorkflow;
    if (runId.startsWith("estateaudit")) return estateAuditWorkflow;
    if (runId.startsWith("proposal_")) return buildProposalWorkflow({ model }).definition;
    const chat = chatSpecOf(runId);
    if (chat !== null) return buildChatWorkflow(chat.agent, model).definition;
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

  function runNightlyOnce(o: { runId?: string; institutions?: string[] } = {}): Promise<RunResult> {
    const runId = o.runId ?? newId("nightly");
    const run = host.run(nightlyWorkflow, {
      runId,
      triggerPayload: { run_key: runId, ...(o.institutions !== undefined ? { institutions: o.institutions } : {}) },
    });
    return run.complete;
  }

  /** Reconcile one institution and report the run plainly (used after every GUI edit/upload). */
  async function refreshInstitution(institutionId: string): Promise<{ runId: string; status: string }> {
    const runId = newId("nightly");
    const r = await runNightlyOnce({ runId, institutions: [institutionId] });
    return { runId, status: r.terminalStatus };
  }

  return {
    dataDir,
    ledger,
    vault,
    host,
    institutions: () => loaded,
    reloadInstitutions() {
      loaded = reloadRegistry();
      return loaded;
    },
    institutionsOverview() {
      const accts = views.accounts(ledger);
      const nw = views.netWorth(ledger);
      const lineByAccount = new Map(nw.lines.map((l) => [l.account_id, l]));
      const open = ledger.openFindings();
      const institutions = loaded.entries.map((e) => {
        const managed = isManaged(e);
        const managedList = managed ? readManagedAccounts(dataDir, e.institution_id) : [];
        const closedIds = new Set(managedList.filter((a) => a.closed_at !== undefined).map((a) => a.account_id));
        const rows: InstitutionAccountRow[] = accts
          .filter((a) => a.institution_id === e.institution_id)
          .map((a) => {
            const line = lineByAccount.get(a.account_id);
            return {
              account_id: a.account_id,
              name: a.name,
              type: a.type,
              currency: a.currency,
              value: line?.value ?? null,
              observed_at: line?.observed_at ?? a.observed_at,
              closed: closedIds.has(a.account_id),
            };
          });
        // Managed accounts typed in but not yet reconciled into the ledger.
        for (const m of managedList) {
          if (!rows.some((r) => r.account_id === m.account_id)) {
            rows.push({
              account_id: m.account_id,
              name: m.name,
              type: m.type,
              currency: m.currency,
              value: m.closed_at !== undefined ? "0" : m.value,
              observed_at: null,
              closed: m.closed_at !== undefined,
            });
          }
        }
        const problems = open.filter((f) => f.code === "fetch_failed" && f.subject === e.institution_id).map((f) => f.summary);
        return {
          institution_id: e.institution_id,
          name: e.name,
          adapter: e.adapter,
          enabled: e.enabled !== false,
          managed,
          accounts: rows,
          problems,
          consent_until: typeof e.options?.["valid_until"] === "string" ? (e.options["valid_until"] as string) : null,
          aspsp: isAspsp(e.options?.["aspsp"]) ? (e.options["aspsp"] as { name: string; country: string }) : null,
        };
      });
      return { institutions, hasFacts: nw.lines.length > 0 };
    },
    addInstitution(input) {
      const entry = addInstitutionEntry(dataDir, {
        name: input.name,
        adapter: "jsondrop",
        ...(input.mode === "managed" ? { options: { managed: true } } : {}),
      });
      if (input.mode === "managed") initManagedInstitution(dataDir, entry.institution_id, clock());
      loaded = reloadRegistry();
      return entry;
    },
    removeInstitution(institutionId) {
      // A deleted connection's tokens are no longer needed: remove them
      // from the Keychain too (the ledger history stays, as always).
      const entry = loaded.entries.find((e) => e.institution_id === institutionId);
      if (entry !== undefined) deleteConnectionTokens(secrets, entry);
      const removed = removeInstitutionEntry(dataDir, institutionId);
      if (removed) loaded = reloadRegistry();
      return removed;
    },
    credentialsStatus() {
      return credentialsStatus(secrets, loaded.entries);
    },
    setCredential(id, values) {
      setCredential(secrets, id, values);
    },
    deleteCredential(id) {
      return deleteCredential(secrets, id);
    },
    deleteConnectionTokens(institutionId) {
      const entry = loaded.entries.find((e) => e.institution_id === institutionId);
      if (entry === undefined) throw new Error(`unknown institution ${institutionId}`);
      return deleteConnectionTokens(secrets, entry);
    },
    setInstitutionEnabled(institutionId, enabled) {
      const changed = setEnabledInRegistry(dataDir, institutionId, enabled);
      if (changed) loaded = reloadRegistry();
      return changed;
    },
    storeInstitutionFile(institutionId, filename, bytes) {
      if (!loaded.entries.some((e) => e.institution_id === institutionId)) {
        throw new Error(`unknown institution ${institutionId}`);
      }
      const inbox = path.join(dataDir, "institutions", institutionId.replace(/^inst\./, ""), "inbox");
      fs.mkdirSync(inbox, { recursive: true });
      const base = path.basename(filename).replace(/[^A-Za-z0-9._-]+/g, "_") || "upload.json";
      // Prefix with the upload time so the newest upload wins jsondrop's name ordering.
      const stored = `${clock().toISOString().replace(/[:.]/g, "-")}-${base}`;
      fs.writeFileSync(path.join(inbox, stored), bytes);
      return { filename: stored };
    },
    refreshInstitution,
    managedAccounts(institutionId) {
      return readManagedAccounts(dataDir, institutionId);
    },
    async saveManagedAccount(institutionId, input) {
      const entry = loaded.entries.find((e) => e.institution_id === institutionId);
      if (entry === undefined || !isManaged(entry)) throw new Error(`${institutionId} is not a managed institution`);
      const account = upsertManagedAccount(dataDir, institutionId, input, clock());
      const run = await refreshInstitution(institutionId);
      return { account, ...run };
    },
    async removeManagedAccount(institutionId, accountId) {
      if (!closeManagedAccount(dataDir, institutionId, accountId, clock())) {
        throw new Error(`no open managed account ${accountId} at ${institutionId}`);
      }
      return refreshInstitution(institutionId);
    },
    async seedDemoData() {
      seedDemo(dataDir, 1);
      loaded = reloadRegistry();
      const runId = newId("nightly");
      const r = await runNightlyOnce({ runId });
      return { institutions: loaded.entries.length, runId, status: r.terminalStatus };
    },
    connectPlaidStart: () => connectors.plaidLinkStart(),
    async connectPlaidComplete(o) {
      const ex = await connectors.plaidExchange({
        ...(o.linkToken !== undefined ? { linkToken: o.linkToken } : {}),
        ...(o.publicToken !== undefined ? { publicToken: o.publicToken } : {}),
      });
      let institutionId = o.institutionId ?? null;
      if (institutionId === null) {
        const entry = addInstitutionEntry(dataDir, { name: o.name ?? "Bank (Plaid)", adapter: "plaid", options: plaidEntryOptions() });
        institutionId = entry.institution_id;
      } else if (!loaded.entries.some((e) => e.institution_id === institutionId && e.adapter === "plaid")) {
        throw new Error(`${institutionId} is not a Plaid connection`);
      }
      storeSecret(PLAID_SERVICE, `access_token:${institutionId}`, ex.accessToken);
      if (ex.itemId !== null) updateInstitutionOptions(dataDir, institutionId, { item_id: ex.itemId });
      loaded = reloadRegistry();
      const run = await refreshInstitution(institutionId);
      return { institution_id: institutionId, ...run };
    },
    ebListBanks: (country) => connectors.ebListBanks(country),
    connectEbStart(o) {
      return connectors.ebAuthStart({
        name: o.name ?? "Bank (Enable Banking)",
        ...(o.institutionId !== undefined ? { institutionId: o.institutionId } : {}),
        country: o.country,
        bank: o.bank,
        ...(o.redirectUrl !== undefined ? { redirectUrl: o.redirectUrl } : {}),
      });
    },
    async connectEbComplete(o) {
      const pending = connectors.ebPending(o.state);
      if (pending === null) throw new Error("unknown or expired connect attempt -- start the bank connection again");
      const s = await connectors.ebSessionCreate(o.code);
      let institutionId = pending.institutionId;
      if (institutionId === null) {
        const entry = addInstitutionEntry(dataDir, {
          name: pending.name,
          adapter: "enablebanking",
          options: {
            aspsp: pending.aspsp,
            ...(connectorCfg.ebBaseUrl !== undefined ? { base_url: connectorCfg.ebBaseUrl } : {}),
            ...(s.validUntil !== null ? { valid_until: s.validUntil } : {}),
          },
        });
        institutionId = entry.institution_id;
      } else {
        if (!loaded.entries.some((e) => e.institution_id === institutionId && e.adapter === "enablebanking")) {
          throw new Error(`${institutionId} is not an Enable Banking connection`);
        }
        updateInstitutionOptions(dataDir, institutionId, { ...(s.validUntil !== null ? { valid_until: s.validUntil } : {}) });
      }
      storeSecret(ENABLEBANKING_SERVICE, `session:${institutionId}`, s.sessionId);
      loaded = reloadRegistry();
      const run = await refreshInstitution(institutionId);
      return { institution_id: institutionId, consent_until: s.validUntil, ...run };
    },
    async connectCoinbase(o) {
      // The downloaded CDP key file may be pasted whole; its fields win.
      const cred = parseCoinbaseCredential(o.apiKeyName, o.privateKey);
      if (cred.apiKeyName === "") throw new Error("missing the API key name (organizations/…/apiKeys/…) -- or paste the whole downloaded key file into the key box");
      // Refuse a key that doesn't parse (Ed25519 base64 or ECDSA PEM) before anything is stored.
      parseCoinbaseKey(cred.privateKey);
      let institutionId = o.institutionId ?? null;
      if (institutionId === null) {
        const entry = addInstitutionEntry(dataDir, {
          name: o.name ?? "Coinbase",
          adapter: "coinbase",
          ...(connectorCfg.coinbaseBaseUrl !== undefined ? { options: { base_url: connectorCfg.coinbaseBaseUrl } } : {}),
        });
        institutionId = entry.institution_id;
      } else if (!loaded.entries.some((e) => e.institution_id === institutionId && e.adapter === "coinbase")) {
        throw new Error(`${institutionId} is not a Coinbase connection`);
      }
      storeSecret(COINBASE_SERVICE, `api_key_name:${institutionId}`, cred.apiKeyName);
      storeSecret(COINBASE_SERVICE, `private_key:${institutionId}`, cred.privateKey);
      loaded = reloadRegistry();
      const run = await refreshInstitution(institutionId);
      return { institution_id: institutionId, ...run };
    },
    async connectWallet(o) {
      if (o.holdings.length === 0) throw new Error("add at least one address to watch");
      const holdings: WalletHolding[] = o.holdings.map((h) => {
        if (h.kind !== undefined) return { kind: h.kind, value: h.value.trim(), ...(h.label !== undefined ? { label: h.label } : {}) };
        const d = detectWalletHolding(h.value);
        if (!d.ok) throw new Error(`${h.value.trim().slice(0, 16)}…: ${d.reason}`);
        // d.value is what to store: for a pasted Ledger Live account
        // object it is the extracted address, not the JSON blob.
        const label = h.label ?? d.label;
        return { kind: d.kind, value: d.value, ...(label !== undefined ? { label } : {}) };
      });
      const entry = addInstitutionEntry(dataDir, {
        name: o.name ?? "Self-custody wallet",
        adapter: "wallet",
        options: { holdings, ...connectorCfg.walletApis },
      });
      loaded = reloadRegistry();
      const run = await refreshInstitution(entry.institution_id);
      return { institution_id: entry.institution_id, ...run };
    },
    async runNightly(o = {}) {
      return runNightlyOnce(o);
    },
    async resumeInFlight() {
      const out: RunSummary[] = [];
      for (const runId of host.listRuns()) {
        const s = await summarize(runId);
        if (s.status !== "running") continue;
        const def = definitionFor(runId) ?? nightlyWorkflow;
        if (isStandingRun(runId)) {
          // A standing run (tax year, chat): start driving it (parked
          // gates re-arm) and report it as running -- it may stay parked
          // for months and must not block startup.
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
    estateFile,
    async runEstateAudit() {
      const runId = `estateaudit_${newId("r").slice(2)}`;
      return host.run(estateAuditWorkflow, { runId, triggerPayload: { run_key: runId } }).complete;
    },
    estateStatus() {
      const estate = estateFile();
      const entities = ledger.asOf({ kind: "entity" }).map((f) => ({ subject: f.subject, fact_id: f.id, payload: f.payload }));
      const titling = ledger.asOf({ kind: "titling" }).map((f) => ({ subject: f.subject, fact_id: f.id, payload: f.payload }));
      const estateCodes = new Set(["titling_gap", "beneficiary_mismatch", "estate_doc_missing", "executor_gap", "advisory_note"]);
      const openFindings = ledger.openFindings({ requiresHuman: true }).filter((f) => estateCodes.has(f.code)).length;
      const lastAudit = ledger
        .eventsSince(0, 10_000)
        .filter((e) => e.kind === "estate.audited")
        .at(-1) ?? null;
      return { configured: estate !== null, entities, titling, plan: estate?.plan ?? null, openFindings, lastAudit };
    },
    runScenarioNow(req) {
      return runScenario({ ledger, taxProfile: taxProfile(), estateFile: estateFile(), now: clock() }, req);
    },
    runProjectionNow(req) {
      const nw = views.netWorth(ledger);
      const inputs = resolveProjectionInputs(req, { startValue: nw.net_worth, evidence: nw.lines.flatMap((l) => l.fact_ids) }, clock().toISOString());
      return monteCarlo(inputs);
    },
    async activeChatRun(agent) {
      const spec = chatWorkflowSpec(agent);
      for (const runId of host.listRuns()) {
        if (!runId.startsWith(`${spec.runIdPrefix}_`)) continue;
        const s = await summarize(runId);
        if (s.status === "running") return { runId };
      }
      return null;
    },
    async sendChat(o) {
      const spec = chatWorkflowSpec(o.agent);
      const messageId = newId("msg");
      const active = await this.activeChatRun(o.agent);
      let runId: string;
      if (active === null) {
        runId = `${spec.runIdPrefix}_${newId("r").slice(2)}`;
        drive(buildChatWorkflow(o.agent, model).definition, runId, { run_key: runId, text: o.text, message_id: messageId });
      } else {
        runId = active.runId;
        // Deliver on the step's CURRENT input channel: the reserved
        // signal name of the newest input park not yet consumed. While a
        // turn is in flight there is no open channel -- poll until the
        // re-arm parks it (or time out as "busy").
        const channel = await openInputChannel(runId, spec.stepId, o.timeoutMs ?? 30_000);
        host.deliver(runId, channel, { text: o.text, message_id: messageId }, messageId);
      }
      if (o.wait === false) return { message_id: messageId, turn: null };
      const turn = await waitForTurn(o.agent, runId, messageId, o.timeoutMs ?? 240_000);
      return { message_id: messageId, turn };
    },
    chatTranscript(agent) {
      return ledger
        .eventsSince(0, 10_000)
        .filter((e) => e.kind === "chat.turn" && e.subject === `chat.${agent}`)
        .map((e) => e.payload as ChatTurn);
    },
    plan,
    async startProposal(o = {}) {
      if (plan() === null) throw new Error(`market: no ${planPath}; write the investment plan before proposing`);
      const runId = `proposal_${newId("r").slice(2)}`;
      drive(buildProposalWorkflow({ model }).definition, runId, { run_key: runId });
      // Resolve once the run either parks at the approval gate (queued)
      // or settles (blocked/exhausted/failed).
      const deadline = Date.now() + (o.timeoutMs ?? 600_000);
      for (;;) {
        const s = await summarize(runId);
        if (s.status !== "running") return { runId, state: "terminal", status: s.status };
        const events = await host.readLog(runId);
        const parked = events.some(
          (e) => e.kind === "SignalAwaited" && (e as { stepId?: string }).stepId === "approve" && (e as { signalName?: string }).signalName === APPROVAL_SIGNAL,
        );
        if (parked) return { runId, state: "queued", status: "running" };
        const settled = events.some((e) => e.kind === "StepCompleted" && ["exhausted", "expired"].includes((e as { stepId?: string }).stepId ?? ""));
        if (settled) return { runId, state: "terminal", status: s.status };
        if (Date.now() > deadline) throw new Error(`proposal ${runId} neither queued nor settled within the wait window; it is still running`);
        await new Promise((r) => setTimeout(r, 250));
      }
    },
    approvalQueue() {
      return approvalQueue(ledger, clock());
    },
    async decideRecommendation(o) {
      // rec ids are `rec_<run_key>.<attempt>`; recover the run to signal.
      const m = /^rec_(.+)\.\d+$/.exec(o.recommendationId);
      if (m === null) throw new Error(`unrecognized recommendation id ${o.recommendationId}`);
      const runId = m[1] as string;
      if (!host.repoStore.hasRun(runId)) throw new Error(`no run ${runId} for ${o.recommendationId}`);
      const signalId = approvalSignalId(o.recommendationId);
      host.deliver(
        runId,
        APPROVAL_SIGNAL,
        {
          recommendation_id: o.recommendationId,
          decision: o.decision,
          ...(o.bound !== undefined ? { bound: o.bound } : {}),
          signed_by: o.signedBy ?? "operator",
          ...(o.note !== undefined ? { note: o.note } : {}),
        },
        signalId,
      );
      if (o.wait !== false) {
        const deadline = Date.now() + (o.timeoutMs ?? 60_000);
        for (;;) {
          const decided = ledger.eventsSince(0, 50_000).some((e) => e.id === `${runId}:decided`);
          if (decided) break;
          if (Date.now() > deadline) throw new Error(`decision for ${o.recommendationId} delivered but not yet recorded; the run may be resuming`);
          await new Promise((r) => setTimeout(r, 150));
        }
      }
      return { runId, signalId };
    },
    listPreparedInstructions() {
      return listInstructions(ledger);
    },
    exportBreakGlass(o = {}) {
      return runBreakGlassExport({
        ledger,
        vault,
        dataDir,
        outDir: o.outDir ?? path.join(dataDir, "exports"),
        now: clock(),
        estateFile: estateFile(),
        operator: process.env["USER"] ?? "operator",
      });
    },
    revokeInstruction(o) {
      const at = clock().toISOString();
      const by = o.by ?? "operator";
      const r = markInstruction(ledger, { instructionId: o.instructionId, status: "revoked", by, at, ...(o.note !== undefined ? { note: o.note } : {}) });
      if (!r.replayed) {
        ledger.appendJournal({
          at,
          kind: "decision",
          summary: `revoked instruction ${o.instructionId}${o.note ? ` -- ${o.note}` : ""}`,
          detail: { instruction_id: o.instructionId },
          refs: [],
          author: by,
        });
        ledger.emitEvent({ id: `revoke:${o.instructionId}`, kind: "instruction.revoked", payload: { instruction_id: o.instructionId, by } });
      }
      return r;
    },
    close() {
      ledger.close();
    },
  };

  async function openInputChannel(runId: string, stepId: string, timeoutMs: number): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const events = await host.readLog(runId);
      const received = new Set<string>();
      const awaited: string[] = [];
      for (const e of events) {
        if (e.kind === "SignalReceived") received.add((e as { signalName: string }).signalName);
        if (e.kind === "SignalAwaited" && (e as { stepId?: string }).stepId === stepId && (e as { parkKind?: string }).parkKind === "input") {
          awaited.push((e as { signalName: string }).signalName);
        }
      }
      const open = awaited.filter((n) => !received.has(n)).at(-1);
      if (open !== undefined) return open;
      if (Date.now() > deadline) {
        throw new Error(`chat: ${runId} has no open input channel (a turn is still in flight); try again shortly`);
      }
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  async function waitForTurn(agent: ChatAgent, runId: string, messageId: string, timeoutMs: number): Promise<ChatTurn> {
    const evtId = `chat:${agent}:${messageId}`;
    const deadline = Date.now() + timeoutMs;
    for (let i = 0; ; i += 1) {
      const hit = ledger
        .eventsSince(0, 10_000)
        .find((e) => e.kind === "chat.turn" && e.id === evtId);
      if (hit !== undefined) return hit.payload as ChatTurn;
      // A dead run will never reply: surface the failing step's own
      // message now (e.g. "ANTHROPIC_API_KEY is not set") instead of
      // letting the operator wait out the full timeout. Checked every
      // ~1s -- reading the log is heavier than the event poll above.
      if (i % 5 === 4) {
        const events = await host.readLog(runId);
        const last = events.at(-1);
        if (last !== undefined && (last.kind === "RunFailed" || last.kind === "RunCancelled")) {
          const failed = [...events].reverse().find((e) => e.kind === "StepFailed") as { error?: { message?: string } } | undefined;
          throw new Error(failed?.error?.message ?? `chat: the ${agent} run ${last.kind === "RunFailed" ? "failed" : "was cancelled"} before replying`);
        }
      }
      if (Date.now() > deadline) throw new Error(`chat: no reply for ${messageId} within ${String(timeoutMs)}ms; the turn may still be running -- poll the transcript`);
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}
