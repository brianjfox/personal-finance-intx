// fin-host: assemble a `WorkflowRuntimeEnv` over the filesystem and run
// workflows against it with `runtimeRun` -- the same runtime body
// `runLocal` and the production child use.
//
// Phase 0 scope: `action`, `awaitSignal`, `sleep`, `gate`, `map`, `loop`
// (via runLocal's loop-iteration seam) are supported. Model-backed
// `step`s are NOT wired yet (`invokeStep` throws) -- that is Phase 3
// work and needs the step-invoker from `@intx/workflow-host` or an
// equivalent. `childWorkflow` and `onTrigger` are likewise unwired and
// fail loudly, per the env contract.

import { createDefaultDirectorRegistry } from "@intx/agent";
import {
  createEffectContext,
  createNoopDrainController,
  runtimeRun,
  type ActionInvoker,
  type LoopFnRegistry,
  type RunResult,
  type StepInvoker,
  type WorkflowAuthorizeFn,
  type WorkflowDefinition,
  type WorkflowEvent,
  type WorkflowRun,
  type WorkflowRuntimeEnv,
} from "@intx/workflow";
import { createLoopIteration, type ActionHandler } from "@intx/workflow/runlocal";

import { createFsBlobSubstrate } from "./blobs";
import { createFsEffectLedger, type FsEffectLedger } from "./effects";
import { startChainFlusher } from "./flush";
import { ensureDir, hostPaths, type HostPaths } from "./paths";
import { createFsRepoStore, type FsRepoStore } from "./repo-store";
import { createFsScheduler } from "./scheduler";
import { createFsSignalChannel, writeInboxSignal } from "./signal-channel";

export type { ActionHandler } from "@intx/workflow/runlocal";

export interface FsHostOptions {
  dataDir: string;
  /** Action handler registry: `action({ handler })` refs resolve here. */
  actions: Record<string, ActionHandler>;
  /** Model-backed `step` invoker (Phase 3). Absent -> steps fail loudly. */
  invokeStep?: StepInvoker;
  /** Loop `while`/`carry` registry. */
  loopFns?: LoopFnRegistry;
  /** Workflow-level authorize. Defaults to allow-all; Phase 1 wires @intx/authz. */
  authorize?: WorkflowAuthorizeFn;
  clock?: () => Date;
  newId?: (prefix: string) => string;
  /** Signal inbox poll interval. */
  pollMs?: number;
  /** Pending-commit-buffer flush interval for live runs (D-017). */
  flushMs?: number;
}

export interface RunOptions {
  runId: string;
  /** Only used when the run's log is empty (a fresh start). */
  triggerPayload?: unknown;
}

export interface FsHost {
  readonly paths: HostPaths;
  readonly repoStore: FsRepoStore;
  readonly effects: FsEffectLedger;
  /**
   * Start or resume `runId`. If the run has a durable log it is adopted
   * and driven from canonical state (the runtime's seedless recovery
   * path); otherwise a fresh run starts with `triggerPayload`.
   */
  run(definition: WorkflowDefinition, opts: RunOptions): WorkflowRun;
  /** Durably enqueue a signal for a run. Works with no run in flight. */
  deliver(runId: string, name: string, payload: unknown, signalId: string): string;
  readLog(runId: string): Promise<readonly WorkflowEvent[]>;
  listRuns(): string[];
}

const allowAll: WorkflowAuthorizeFn = async () => ({
  effect: "allow",
  matchingGrants: [],
  resolvedBy: null,
});

export function createFsHost(opts: FsHostOptions): FsHost {
  const paths = hostPaths(opts.dataDir);
  ensureDir(paths.runsDir);
  ensureDir(paths.blobsDir);
  ensureDir(paths.effectsDir);

  const clock = opts.clock ?? (() => new Date());
  const newId = opts.newId ?? defaultNewId;
  const authorize = opts.authorize ?? allowAll;

  const repoStore = createFsRepoStore(paths);
  const blobs = createFsBlobSubstrate(paths);
  const effects = createFsEffectLedger(paths, clock);
  const scheduler = createFsScheduler({ repoStore, clock });
  const directors = createDefaultDirectorRegistry();

  const invokeAction: ActionInvoker = async ({
    handler,
    input,
    requires,
    authzContext,
    signal,
  }) => {
    const fn = opts.actions[handler];
    if (fn === undefined) {
      throw new Error(`fs-host: no action handler registered for ref ${handler}`);
    }
    const ctx = createEffectContext({
      authorize,
      effects,
      requires,
      authzContext,
      input,
    });
    const output = await fn(input, ctx, signal);
    return { output };
  };

  return {
    paths,
    repoStore,
    effects,
    run(definition, runOpts) {
      const channel = createFsSignalChannel({
        paths,
        runId: runOpts.runId,
        repoStore,
        newId: () => newId("sig"),
        clock,
        ...(opts.pollMs !== undefined ? { pollMs: opts.pollMs } : {}),
      });
      const env: WorkflowRuntimeEnv = {
        repoStore,
        scheduler,
        signalChannel: channel,
        blobs,
        directors,
        authorize,
        invokeStep:
          opts.invokeStep ??
          (async ({ agent }) => {
            throw new Error(
              `fs-host: model-backed step ${agent.id} has no step invoker wired (pass FsHostOptions.invokeStep)`,
            );
          }),
        invokeAction,
        effects,
        spawnChild: async ({ definitionRef }) => {
          throw new Error(
            `fs-host: childWorkflow ${definitionRef} is not supported yet`,
          );
        },
        clock,
        newId,
        drain: createNoopDrainController(definition),
      };
      env.runLoopIteration = createLoopIteration(env);
      if (opts.loopFns !== undefined) env.loopFns = opts.loopFns;

      // The channel must be live (inbox replayed, poller running) before
      // the runtime re-parks, so a signal that arrived while this host
      // was down is already queued when `awaitNext` is called.
      const started = channel.start();
      const fresh = !repoStore.hasRun(runOpts.runId);

      let inner: WorkflowRun | undefined;
      const complete: Promise<RunResult> = started.then(async () => {
        // At the pinned framework version the runtime builds every step's
        // SelectorContext from `options.triggerPayload` and never
        // rehydrates it from the durable RunStarted -- so on an adopted
        // resume, any `{ from: "trigger.payload" }` selector would throw
        // and the step would fail. Re-supply the recorded payload from
        // the log (D-015). RunStarted is only emitted from `pending`, so
        // passing it for an adopted run affects nothing else.
        let triggerPayload = runOpts.triggerPayload;
        if (!fresh) {
          const log = await repoStore.read(runOpts.runId);
          const runStarted = log.find((e) => e.kind === "RunStarted") as
            | { trigger?: { payload?: unknown } }
            | undefined;
          triggerPayload = runStarted?.trigger?.payload ?? runOpts.triggerPayload;
        }
        inner = runtimeRun(definition, env, {
          runId: runOpts.runId,
          ...(triggerPayload !== undefined ? { triggerPayload } : {}),
        });
        // A long-lived run (the standing tax year) buffers step events
        // with no boundary to flush them; drain the buffer on an
        // interval so a shutdown while parked never leaves completed
        // work looking in-flight (D-017).
        startChainFlusher(repoStore, runOpts.runId, inner.complete, opts.flushMs ?? 500);
        return inner.complete;
      });
      void complete.finally(() => channel.stop());

      return {
        runId: runOpts.runId,
        complete,
        async cancel(origin, reason) {
          await started;
          if (inner === undefined) throw new Error("run not started");
          await inner.cancel(origin, reason);
        },
        async signal(name, payload, signalId) {
          await channel.deliver(name, payload, signalId);
        },
      };
    },
    deliver(runId, name, payload, signalId) {
      return writeInboxSignal(paths, runId, { name, payload, signalId });
    },
    readLog(runId) {
      return repoStore.read(runId);
    },
    listRuns() {
      return repoStore.listRuns();
    },
  };
}

let idCounter = 0;
function defaultNewId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${String(Date.now())}-${String(idCounter)}-${Math.random().toString(36).slice(2, 8)}`;
}
