// Issue #120: the shell must notice a nightly it did not start. The
// watcher polls the ledger's event head and fires once per advance --
// never on the baseline poll, never on a failed one, and again right
// away when the window comes back into focus or view.

import { describe, expect, test } from "bun:test";

import { ledgerCursor, watchLedger } from "../src/watch";

class FakeDoc extends EventTarget {
  visibilityState = "visible";
}

describe("ledgerCursor", () => {
  test("baseline is silent; fires once per advance; a failed poll is skipped, not a change", async () => {
    let seq = 41;
    let fail = false;
    let fired = 0;
    const c = ledgerCursor(() => (fail ? Promise.reject(new Error("host gone")) : Promise.resolve({ seq })), () => fired++);
    await c.poll(); // the baseline: the shell has just fetched everything
    expect(fired).toBe(0);
    await c.poll(); // nothing happened
    expect(fired).toBe(0);
    seq = 42; // the nightly landed
    await c.poll();
    expect(fired).toBe(1);
    await c.poll(); // still 42: no second reload
    expect(fired).toBe(1);
    fail = true; // host restarting
    await c.poll();
    expect(fired).toBe(1);
    fail = false;
    await c.poll(); // back, unchanged since the last good poll
    expect(fired).toBe(1);
    seq = 50;
    await c.poll();
    expect(fired).toBe(2);
  });

  test("overlapping polls share one request", async () => {
    let calls = 0;
    let release: (v: { seq: number }) => void = () => {};
    const c = ledgerCursor(() => {
      calls++;
      return new Promise((r) => {
        release = r;
      });
    }, () => {});
    const a = c.poll();
    const b = c.poll();
    release({ seq: 1 });
    await Promise.all([a, b]);
    expect(calls).toBe(1);
  });
});

describe("watchLedger", () => {
  test("polls on the interval and on focus/visibility; stop tears everything down", async () => {
    let seq = 1;
    let fired = 0;
    const target = new EventTarget();
    const doc = new FakeDoc();
    let tick: (() => void) | null = null;
    let cleared: unknown = null;
    const timers = {
      set: (fn: () => void, ms: number) => {
        expect(ms).toBe(30_000);
        tick = fn;
        return "handle";
      },
      clear: (h: unknown) => {
        cleared = h;
      },
    };
    const settle = () => new Promise((r) => setTimeout(r, 0));
    const stop = watchLedger(() => Promise.resolve({ seq }), () => fired++, { target, doc, timers });
    await settle(); // baseline
    expect(fired).toBe(0);
    seq = 2;
    tick!();
    await settle();
    expect(fired).toBe(1);
    seq = 3;
    target.dispatchEvent(new Event("focus"));
    await settle();
    expect(fired).toBe(2);
    seq = 4;
    doc.visibilityState = "hidden";
    doc.dispatchEvent(new Event("visibilitychange")); // going away: no poll
    await settle();
    expect(fired).toBe(2);
    doc.visibilityState = "visible";
    doc.dispatchEvent(new Event("visibilitychange")); // back: poll now
    await settle();
    expect(fired).toBe(3);
    stop();
    expect(cleared).toBe("handle");
    seq = 5;
    target.dispatchEvent(new Event("focus"));
    doc.dispatchEvent(new Event("visibilitychange"));
    await settle();
    expect(fired).toBe(3);
  });
});
