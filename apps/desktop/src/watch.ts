// Issue #120: the shell only refetched when a GUI action bumped its tick,
// so a nightly it did not start -- the scheduler's, the tray's Refresh
// Assets, `fin-host nightly` -- left the header's net worth at whatever
// it was when the app opened. This watches the ledger's event sequence
// and fires once per advance; the shell answers by bumping the tick that
// reloads every mounted page.

export interface LedgerWatchOptions {
  /** Poll spacing; 30 s keeps the host idle enough and the morning glance fresh. */
  intervalMs?: number;
  /** Where `focus` arrives (the window in the app; a stand-in in tests). */
  target?: EventTarget;
  /** Where `visibilitychange` arrives (the document in the app; a stand-in in tests). */
  doc?: EventTarget & { visibilityState?: string };
  /** Timer functions, injectable for tests. */
  timers?: { set: (fn: () => void, ms: number) => unknown; clear: (handle: unknown) => void };
}

/**
 * The cursor alone, timer-free: the first successful poll only records
 * where the sequence stands (the shell has just fetched everything), and
 * each later poll fires `onChange` once when the sequence has moved on.
 * A failed poll (host restarting, session gone) is ignored; the next one
 * tries again from the same cursor.
 */
export function ledgerCursor(head: () => Promise<{ seq: number }>, onChange: () => void): { poll: () => Promise<void> } {
  let seen: number | null = null;
  let inFlight: Promise<void> | null = null;
  const poll = (): Promise<void> => {
    if (inFlight !== null) return inFlight;
    inFlight = head()
      .then(({ seq }) => {
        if (seen === null) {
          seen = seq;
        } else if (seq !== seen) {
          seen = seq;
          onChange();
        }
      })
      .catch(() => {})
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };
  return { poll };
}

/**
 * Polls on an interval and immediately when the window comes back into
 * focus or view, so the day's first glance is current. Returns the stop
 * function for a React effect to return.
 */
export function watchLedger(head: () => Promise<{ seq: number }>, onChange: () => void, o: LedgerWatchOptions = {}): () => void {
  const intervalMs = o.intervalMs ?? 30_000;
  const target = o.target ?? window;
  const doc = o.doc ?? document;
  const timers = o.timers ?? { set: (fn, ms) => setInterval(fn, ms), clear: (h) => clearInterval(h as ReturnType<typeof setInterval>) };
  const cursor = ledgerCursor(head, onChange);
  void cursor.poll(); // the baseline
  const handle = timers.set(() => void cursor.poll(), intervalMs);
  const onFocus = () => void cursor.poll();
  const onVisible = () => {
    if (doc.visibilityState === undefined || doc.visibilityState === "visible") void cursor.poll();
  };
  target.addEventListener("focus", onFocus);
  doc.addEventListener("visibilitychange", onVisible);
  return () => {
    timers.clear(handle);
    target.removeEventListener("focus", onFocus);
    doc.removeEventListener("visibilitychange", onVisible);
  };
}
