// Periodic durable flush for long-lived runs (D-017).
//
// At the pinned framework version the runtime body buffers step events
// and flushes them durably only at a SUSPENSION or TERMINAL boundary.
// A standing run (the tax year) parks its gates early and then lives
// for months; a deadline chain that runs mid-life leaves its
// StepCompleted events in the in-memory buffer with no further boundary
// to flush them -- so ANY later host shutdown would resume with those
// steps `in-flight` and the at-most-once rule (D-012) would settle them
// as crashed, failing the whole standing run. fin-host therefore drains
// the run's pending buffer on a short interval: after ~flushMs of quiet,
// everything the run did is durable and a shutdown is safe.
//
// `flushChain` is not on `@intx/workflow`'s public surface at 0.3.0, so
// it is deep-imported from the package's dist next to the entry the
// exports map does expose. Serializing through the same per-runId chain
// the runtime body uses keeps the single-writer seq invariant intact.
// If an upgrade removes or moves it, this import fails loudly at first
// use and the Phase 2 host test catches it.

import type { RepoStore } from "@intx/workflow";

type FlushChainFn = (env: { repoStore: RepoStore }, runId: string) => Promise<void>;

let flushChainFn: FlushChainFn | null = null;

async function loadFlushChain(): Promise<FlushChainFn> {
  if (flushChainFn === null) {
    const entry = import.meta.resolve("@intx/workflow");
    const url = new URL("./runtime/commit-chain.js", entry).href;
    const mod = (await import(url)) as { flushChain?: FlushChainFn };
    if (typeof mod.flushChain !== "function") {
      throw new Error(`fs-host: ${url} no longer exports flushChain; re-verify D-017 against the pinned framework`);
    }
    flushChainFn = mod.flushChain;
  }
  return flushChainFn;
}

/** Drain `runId`'s pending commit buffer to durable storage. No-op when empty. */
export async function flushRunChain(repoStore: RepoStore, runId: string): Promise<void> {
  const flush = await loadFlushChain();
  await flush({ repoStore }, runId);
}

/**
 * Keep draining `runId`'s buffer every `intervalMs` until `until`
 * settles. Failures are surfaced once per streak, not swallowed.
 */
export function startChainFlusher(
  repoStore: RepoStore,
  runId: string,
  until: Promise<unknown>,
  intervalMs: number,
): void {
  let failed = false;
  const timer = setInterval(() => {
    flushRunChain(repoStore, runId).then(
      () => {
        failed = false;
      },
      (e: unknown) => {
        if (!failed) process.stderr.write(`fs-host: chain flush for ${runId} failed: ${String(e)}\n`);
        failed = true;
      },
    );
  }, intervalMs);
  void until.catch(() => undefined).finally(() => clearInterval(timer));
}
