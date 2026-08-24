// Durable, per-run `SignalChannel` for fin-host.
//
// Two halves:
//   1. An in-process FIFO single-consumer queue with the same semantics
//      as `@intx/workflow/runlocal`'s channel (pre-await deliveries queue
//      under the name; an awaiter consumes the next one).
//   2. A durable INBOX under `<dataDir>/runs/<runId>/inbox/`. Every
//      `deliver` is written there (atomically) BEFORE it is dispatched,
//      and any process -- the GUI, a CLI, a test -- can write an inbox
//      entry with `writeInboxSignal` while no host process is running.
//
// Resume rehydration (the open question in env.ts, resolved here the
// same way `@intx/workflow-host` resolves it, but from the inbox rather
// than from run state): on `start()` the channel replays every inbox
// entry whose `signalId` does not already appear as a `SignalReceived`
// in the run's durable log, then polls the inbox for entries written by
// other processes. The state machine's run-lifetime dedup by `signalId`
// makes a redundant replay a no-op, so the filter is an optimisation,
// not a correctness requirement.

import fs from "node:fs";
import path from "node:path";

import type { RepoStore, SignalChannel } from "@intx/workflow";

import { ensureDir, fileExists, writeFileAtomic, type HostPaths } from "./paths";

export interface InboxSignal {
  name: string;
  payload: unknown;
  signalId: string;
  at: string;
}

export interface FsSignalChannel extends SignalChannel {
  /** Replay the inbox against the durable log, then start polling it. */
  start(): Promise<void>;
  /** Stop polling. Pending awaiters are left parked (the run owns them). */
  stop(): void;
}

export interface FsSignalChannelOptions {
  paths: HostPaths;
  runId: string;
  repoStore: RepoStore;
  newId: () => string;
  clock: () => Date;
  /** Inbox poll interval in ms. Default 100. */
  pollMs?: number;
}

let inboxCounter = 0;

/**
 * Durably enqueue a signal for `runId` from ANY process. Returns the
 * inbox file path. Safe to call while no host is running; the next host
 * to `start()` a channel for the run replays it.
 */
export function writeInboxSignal(
  paths: HostPaths,
  runId: string,
  signal: Omit<InboxSignal, "at"> & { at?: string },
): string {
  const dir = paths.inboxDir(runId);
  ensureDir(dir);
  inboxCounter += 1;
  const at = signal.at ?? new Date().toISOString();
  const stamp = `${String(Date.now()).padStart(15, "0")}-${String(process.pid)}-${String(inboxCounter).padStart(6, "0")}`;
  const safeId = signal.signalId.replace(/[^a-zA-Z0-9_.-]/g, "_");
  const file = path.join(dir, `${stamp}-${safeId}.json`);
  const entry: InboxSignal = {
    name: signal.name,
    payload: signal.payload,
    signalId: signal.signalId,
    at,
  };
  writeFileAtomic(file, JSON.stringify(entry));
  return file;
}

export function readInbox(paths: HostPaths, runId: string): { file: string; signal: InboxSignal }[] {
  const dir = paths.inboxDir(runId);
  if (!fileExists(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json") && !f.startsWith("."))
    .sort()
    .map((f) => {
      const file = path.join(dir, f);
      return { file, signal: JSON.parse(fs.readFileSync(file, "utf8")) as InboxSignal };
    });
}

type Awaiter = {
  resolve: (value: { payload: unknown; signalId: string }) => void;
  reject: (cause: unknown) => void;
  onAbort?: () => void;
  signal?: AbortSignal;
};

export function createFsSignalChannel(opts: FsSignalChannelOptions): FsSignalChannel {
  const { paths, runId, repoStore, newId, clock } = opts;
  const pollMs = opts.pollMs ?? 100;
  const awaiters = new Map<string, Awaiter[]>();
  const queued = new Map<string, { payload: unknown; signalId: string }[]>();
  /** Inbox files already dispatched into the in-process queue. */
  const dispatched = new Set<string>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let stopped = false;

  function dispatch(name: string, payload: unknown, signalId: string): void {
    const list = awaiters.get(name);
    if (list && list.length > 0) {
      const next = list.shift();
      if (list.length === 0) awaiters.delete(name);
      if (next) {
        if (next.signal && next.onAbort) {
          next.signal.removeEventListener("abort", next.onAbort);
        }
        next.resolve({ payload, signalId });
        return;
      }
    }
    let q = queued.get(name);
    if (!q) {
      q = [];
      queued.set(name, q);
    }
    q.push({ payload, signalId });
  }

  async function receivedIds(): Promise<Set<string>> {
    const ids = new Set<string>();
    for (const e of await repoStore.read(runId)) {
      if (e.kind === "SignalReceived") ids.add(e.signalId);
    }
    return ids;
  }

  async function sweep(): Promise<void> {
    const entries = readInbox(paths, runId);
    const fresh = entries.filter((e) => !dispatched.has(e.file));
    if (fresh.length === 0) return;
    const seen = await receivedIds();
    for (const { file, signal } of fresh) {
      dispatched.add(file);
      if (seen.has(signal.signalId)) continue;
      dispatch(signal.name, signal.payload, signal.signalId);
    }
  }

  return {
    async deliver(name, payload, signalId) {
      const id = signalId ?? newId();
      const file = writeInboxSignal(paths, runId, {
        name,
        payload,
        signalId: id,
        at: clock().toISOString(),
      });
      // Mark before dispatch so the poller does not double-dispatch the
      // entry this process just wrote.
      dispatched.add(file);
      dispatch(name, payload, id);
    },
    async awaitNext(name, signal) {
      const q = queued.get(name);
      if (q && q.length > 0) {
        const next = q.shift();
        if (q.length === 0) queued.delete(name);
        if (next) return next;
      }
      return new Promise((resolve, reject) => {
        const awaiter: Awaiter = { resolve, reject };
        if (signal !== undefined) {
          if (signal.aborted) {
            reject(new Error("aborted"));
            return;
          }
          awaiter.signal = signal;
          const onAbort = (): void => {
            const list = awaiters.get(name);
            if (list) {
              const idx = list.indexOf(awaiter);
              if (idx >= 0) list.splice(idx, 1);
              if (list.length === 0) awaiters.delete(name);
            }
            reject(new Error("aborted"));
          };
          awaiter.onAbort = onAbort;
          signal.addEventListener("abort", onAbort, { once: true });
        }
        let list = awaiters.get(name);
        if (!list) {
          list = [];
          awaiters.set(name, list);
        }
        list.push(awaiter);
      });
    },
    async start() {
      if (stopped) throw new Error("signal channel already stopped");
      await sweep();
      timer = setInterval(() => {
        void sweep().catch((cause) => {
          // A corrupt inbox file is a host bug, not something to hide.
          process.stderr.write(
            `fs-host signal inbox sweep failed for ${runId}: ${String(cause)}\n`,
          );
        });
      }, pollMs);
    },
    stop() {
      stopped = true;
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    },
  };
}
