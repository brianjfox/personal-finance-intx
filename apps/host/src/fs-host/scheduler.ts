// Scheduler for fin-host.
//
// Delegates to `createInMemoryScheduler` from `@intx/workflow/runlocal`
// pointed at the DURABLE repo store. That scheduler commits `TimerFired`
// through the runtime's module-scoped per-runId commit chain, so its
// writes serialize with the run body's own commits in this process and
// the single-writer-on-TimerFired invariant holds.
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

export function createFsScheduler(opts: {
  repoStore: RepoStore;
  clock: () => Date;
}): Scheduler {
  return createInMemoryScheduler(opts);
}
