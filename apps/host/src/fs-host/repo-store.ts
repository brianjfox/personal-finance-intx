// File-backed `RepoStore`: one append-only JSONL log per run.
//
// Durability model. The runtime's commit chain flushes a whole segment in
// ONE `appendBatch` at every suspension or completion. This store makes
// that batch all-or-nothing by rewriting the log file atomically
// (temp + fsync + rename) rather than appending in place, so a SIGKILL
// mid-write can never leave a torn tail that would make the run look
// parked when it was not (or vice versa). Logs are small -- one run's
// events -- so the O(n) rewrite is acceptable for Phase 0; see
// DECISIONS.md D-007 for the Phase 1 revisit.
//
// Concurrency model. One process owns a run's log at a time. Subscribers
// are in-process (the runtime body's `waitForTimer` / signal tails). A
// second process must not append to a live run's log; cross-process
// delivery goes through the signal inbox, never this file.
//
// Validation mirrors `@intx/workflow/runlocal`'s in-memory store: seqs
// must be strictly monotonic; a same-seq append is an idempotent no-op
// only when the payload is structurally identical (the resume seam's
// re-seed relies on it) and is rejected otherwise.

import fs from "node:fs";

import type { RepoStore, WorkflowEvent } from "@intx/workflow";

type SubscribeOpts = Parameters<RepoStore["subscribe"]>[1];

import { canonicalJson, fileExists, writeFileAtomic, type HostPaths } from "./paths";

export interface FsRepoStore extends RepoStore {
  /** Every runId with a log on disk. */
  listRuns(): string[];
  /** Whether a log exists on disk for `runId` (without loading it). */
  hasRun(runId: string): boolean;
}

const DEFAULT_BUFFER_LIMIT = 1024;

type Entry = { seq: number; event: WorkflowEvent };

type Subscriber = {
  bufferLimit: number;
  buffer: Entry[];
  closed: boolean;
  error: Error | null;
  waiter: ((value: IteratorResult<Entry>) => void) | null;
};

export function createFsRepoStore(paths: HostPaths): FsRepoStore {
  const logs = new Map<string, WorkflowEvent[]>();
  const subscribers = new Map<string, Set<Subscriber>>();

  function load(runId: string): WorkflowEvent[] {
    const cached = logs.get(runId);
    if (cached) return cached;
    const file = paths.eventsFile(runId);
    const events: WorkflowEvent[] = [];
    if (fileExists(file)) {
      const text = fs.readFileSync(file, "utf8");
      for (const line of text.split("\n")) {
        if (line.trim() === "") continue;
        events.push(JSON.parse(line) as WorkflowEvent);
      }
    }
    logs.set(runId, events);
    return events;
  }

  function persist(runId: string, events: readonly WorkflowEvent[]): void {
    const body = events.map((e) => JSON.stringify(e)).join("\n");
    writeFileAtomic(paths.eventsFile(runId), body.length > 0 ? `${body}\n` : "");
  }

  function notify(runId: string, entry: Entry): void {
    const set = subscribers.get(runId);
    if (set === undefined) return;
    for (const sub of set) {
      if (sub.closed) continue;
      if (sub.buffer.length >= sub.bufferLimit) {
        sub.error = new Error(
          `repo_store_subscribe_buffer_overrun: runId=${runId} limit=${String(sub.bufferLimit)}`,
        );
        sub.closed = true;
        if (sub.waiter !== null) {
          const w = sub.waiter;
          sub.waiter = null;
          w({ value: undefined, done: true });
        }
        continue;
      }
      sub.buffer.push(entry);
      if (sub.waiter !== null) {
        const w = sub.waiter;
        sub.waiter = null;
        const head = sub.buffer.shift();
        if (head === undefined) w({ value: undefined, done: true });
        else w({ value: head, done: false });
      }
    }
  }

  /**
   * Validate `events` against the current log tip. Returns the events
   * that actually extend the log (same-seq identical re-seeds are
   * dropped); throws on any conflict.
   */
  function validate(
    runId: string,
    log: readonly WorkflowEvent[],
    events: readonly WorkflowEvent[],
  ): WorkflowEvent[] {
    const accepted: WorkflowEvent[] = [];
    let last = log[log.length - 1];
    for (const event of events) {
      if (last && last.seq >= event.seq) {
        if (last.seq === event.seq) {
          if (canonicalJson(last) !== canonicalJson(event)) {
            throw new Error(
              `same-seq conflict at ${runId} seq ${String(event.seq)}: store holds ${last.kind}, append carries ${event.kind}; payloads do not match`,
            );
          }
          continue;
        }
        throw new Error(
          `non-monotonic append to ${runId}: last seq ${String(last.seq)}, event seq ${String(event.seq)}`,
        );
      }
      accepted.push(event);
      last = event;
    }
    return accepted;
  }

  function appendAll(runId: string, events: readonly WorkflowEvent[]): void {
    const log = load(runId);
    const accepted = validate(runId, log, events);
    if (accepted.length === 0) return;
    const next = [...log, ...accepted];
    // Durable first, then visible: subscribers (and therefore the
    // runtime's "parked" observation) only ever see events that are on
    // disk.
    persist(runId, next);
    logs.set(runId, next);
    for (const event of accepted) notify(runId, { seq: event.seq, event });
  }

  return {
    async read(runId) {
      return [...load(runId)];
    },
    async append(runId, event) {
      appendAll(runId, [event]);
    },
    async appendBatch(runId, events) {
      appendAll(runId, events);
    },
    subscribe(runId, opts) {
      return createSubscription(runId, opts, load(runId), subscribers);
    },
    listRuns() {
      if (!fileExists(paths.runsDir)) return [];
      return fs
        .readdirSync(paths.runsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && fileExists(paths.eventsFile(d.name)))
        .map((d) => d.name)
        .sort();
    },
    hasRun(runId) {
      return fileExists(paths.eventsFile(runId));
    },
  };
}

function createSubscription(
  runId: string,
  opts: SubscribeOpts,
  log: readonly WorkflowEvent[],
  subscribers: Map<string, Set<Subscriber>>,
): AsyncIterableIterator<Entry> {
  const bufferLimit = opts.bufferLimit ?? DEFAULT_BUFFER_LIMIT;
  if (!Number.isInteger(bufferLimit) || bufferLimit <= 0) {
    throw new Error(
      `repo_store_subscribe_buffer_limit_invalid: ${String(opts.bufferLimit)}`,
    );
  }
  const sub: Subscriber = {
    bufferLimit,
    buffer: [],
    closed: false,
    error: null,
    waiter: null,
  };
  let set = subscribers.get(runId);
  if (set === undefined) {
    set = new Set();
    subscribers.set(runId, set);
  }
  set.add(sub);

  const remove = (): void => {
    const current = subscribers.get(runId);
    if (current === undefined) return;
    current.delete(sub);
    if (current.size === 0) subscribers.delete(runId);
  };
  const closeNow = (): void => {
    sub.closed = true;
    remove();
    if (sub.waiter !== null) {
      const w = sub.waiter;
      sub.waiter = null;
      w({ value: undefined, done: true });
    }
  };
  if (opts.signal.aborted) closeNow();
  else opts.signal.addEventListener("abort", closeNow, { once: true });

  if (opts.from !== "head") {
    const fromSeq = opts.from.seq;
    for (const event of log) {
      if (event.seq < fromSeq) continue;
      if (sub.buffer.length >= sub.bufferLimit) {
        sub.error = new Error(
          `repo_store_subscribe_buffer_overrun: runId=${runId} limit=${String(sub.bufferLimit)} during replay`,
        );
        sub.closed = true;
        break;
      }
      sub.buffer.push({ seq: event.seq, event });
    }
  }

  const iterator: AsyncIterableIterator<Entry> = {
    [Symbol.asyncIterator]() {
      return iterator;
    },
    async next() {
      if (sub.error !== null) {
        const err = sub.error;
        sub.error = null;
        closeNow();
        throw err;
      }
      if (sub.buffer.length > 0) {
        const head = sub.buffer.shift();
        if (head === undefined) return { value: undefined, done: true };
        return { value: head, done: false };
      }
      if (sub.closed) return { value: undefined, done: true };
      return new Promise<IteratorResult<Entry>>((resolve) => {
        sub.waiter = resolve;
      });
    },
    async return() {
      closeNow();
      return { value: undefined, done: true };
    },
  };
  return iterator;
}
