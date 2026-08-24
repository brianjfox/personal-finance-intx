// Scheduler for fin-host.
//
// Delegates to `createInMemoryScheduler` from `@intx/workflow/runlocal`
// pointed at the DURABLE repo store. That scheduler commits `TimerFired`
// through the runtime's module-scoped per-runId commit chain, so its
// writes serialize with the run body's own commits in this process and
// the single-writer-on-TimerFired invariant holds.
//
// Long delays are CHUNKED before delegating (D-014): `setTimeout` clamps
// any delay over 2^31-1 ms (~24.8 days) to ~1 ms, so a Sep 15 deadline
// armed in the spring would fire immediately. A timer further out than
// CHUNK_MS re-arms every CHUNK_MS, recomputing the remaining delay from
// the clock each wake (which also absorbs laptop sleep and clock
// adjustments), and hands the final short leg to the inner scheduler,
// which alone commits `TimerFired`.
//
// There is deliberately NO start-time recovery walk here at this pin
// (see DECISIONS.md D-006):
//   - an `awaitSignal` timeout is re-armed by the runtime body itself
//     when the gate re-parks on resume (`runAwaitSignal` calls
//     `scheduleIn` again), so a host walk would double-arm it;
//   - a `sleep` left `awaiting-timer` is not resumable by the runtime
//     body at all (`RuntimeResumeUnsupportedError`), so re-arming its
//     timer would commit a `TimerFired` into a run nothing is driving.
// When the runtime grows a resume path for `awaiting-timer`, the walk
// belongs here.

import type { RepoStore, Scheduler } from "@intx/workflow";
import { createInMemoryScheduler } from "@intx/workflow/runlocal";

/** Re-arm interval for far-out timers. Far below the 2^31-1 ms clamp. */
export const CHUNK_MS = 6 * 60 * 60 * 1000;
/** Spacing between firings of timers that are ALREADY overdue at arm time. */
export const OVERDUE_STAGGER_MS = 1500;

export function createFsScheduler(opts: {
  repoStore: RepoStore;
  clock: () => Date;
  /** Test seam; defaults to CHUNK_MS. */
  chunkMs?: number;
  /** Test seam; defaults to OVERDUE_STAGGER_MS. */
  overdueStaggerMs?: number;
}): Scheduler {
  const inner = createInMemoryScheduler(opts);
  const chunk = opts.chunkMs ?? CHUNK_MS;
  const stagger = opts.overdueStaggerMs ?? OVERDUE_STAGGER_MS;
  // Overdue timers (deadlines that passed while the host was down) fire
  // one at a time, `stagger` apart, so their chains do not all complete
  // in one scheduler tick and race dependents' selector contexts
  // (D-011/D-015). `nextOverdueSlot` is an absolute timestamp; an idle
  // scheduler naturally resets to "fire now".
  let nextOverdueSlot = 0;
  return {
    scheduleIn(runId, timerId, fireAt) {
      let cancelled = false;
      let cancelInner: (() => void) | null = null;
      let handle: ReturnType<typeof setTimeout> | null = null;
      const arm = (): void => {
        if (cancelled) return;
        const now = opts.clock().getTime();
        const remaining = fireAt.getTime() - now;
        if (remaining <= 0) {
          const slot = Math.max(nextOverdueSlot, now);
          nextOverdueSlot = slot + stagger;
          handle = setTimeout(() => {
            if (cancelled) return;
            cancelInner = inner.scheduleIn(runId, timerId, fireAt);
          }, slot - now);
          return;
        }
        if (remaining <= chunk) {
          cancelInner = inner.scheduleIn(runId, timerId, fireAt);
          return;
        }
        handle = setTimeout(arm, chunk);
      };
      arm();
      return () => {
        cancelled = true;
        if (handle !== null) clearTimeout(handle);
        if (cancelInner !== null) cancelInner();
      };
    },
  };
}
