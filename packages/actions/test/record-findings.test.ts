// Issue #15: an institution's open "did not answer tonight" finding is
// resolved by the run that hears from it again -- the card's warning
// banner must clear itself after a successful reconnect, not linger.

import { describe, expect, test } from "bun:test";
import type { EffectContext } from "@intx/workflow";

import { openLedger } from "@fin/ledger";

import { recordFindingsHandler } from "../src/index";
import type { ActionContext } from "../src/context";

const NOW = new Date("2026-08-31T06:00:00.000Z");

function openFetchFailure(ledger: ReturnType<typeof openLedger>, institution: string): string {
  return ledger.appendFinding({
    kind: "gap",
    code: "fetch_failed",
    severity: "high",
    subject: institution,
    summary: `${institution} did not answer tonight`,
    detail: { error: "not connected" },
    evidence: [],
    before: [],
    after: [],
    requires_human: true,
    emitted_by: "reconciliation",
    as_of: "2026-08-30T06:00:00.000Z",
    provenance: { source_id: "handler.reconcile", source_doc_id: null, observed_at: "2026-08-30T06:00:00.000Z", via: "reconcile@1" },
  });
}

const passThroughCtx = { perform: async (o: { run: () => Promise<unknown> }) => o.run() } as unknown as EffectContext;

describe("record_findings resolves answered institutions' fetch failures", () => {
  test("an answered institution's open fetch_failed closes; others stay open", async () => {
    const ledger = openLedger(":memory:");
    const resolvedId = openFetchFailure(ledger, "inst.chase");
    const stillOpenId = openFetchFailure(ledger, "inst.schwab");
    const handler = recordFindingsHandler({ ledger, clock: () => NOW } as unknown as ActionContext);
    const out = (await handler(
      { run_key: "n1", clean: true, findings: [], provisional_subjects: [], answered: ["inst.chase"] },
      passThroughCtx,
      new AbortController().signal,
    )) as { resolved_fetch_failures: number };
    expect(out.resolved_fetch_failures).toBe(1);
    expect(ledger.getFinding(resolvedId)?.resolved).toBe(true);
    expect(ledger.getFinding(resolvedId)?.resolutions[0]?.decided_by).toBe("reconciliation");
    expect(ledger.getFinding(stillOpenId)?.resolved).toBe(false);
    // A replay finds nothing left open: no duplicate resolutions.
    const again = (await handler(
      { run_key: "n2", clean: true, findings: [], provisional_subjects: [], answered: ["inst.chase"] },
      passThroughCtx,
      new AbortController().signal,
    )) as { resolved_fetch_failures: number };
    expect(again.resolved_fetch_failures).toBe(0);
    expect(ledger.getFinding(resolvedId)?.resolutions).toHaveLength(1);
  });

  test("only fetch_failed findings are touched", async () => {
    const ledger = openLedger(":memory:");
    const other = ledger.appendFinding({
      kind: "staleness",
      code: "stale_balance",
      severity: "medium",
      subject: "inst.chase",
      summary: "stale",
      detail: {},
      evidence: [],
      before: [],
      after: [],
      requires_human: true,
      emitted_by: "reconciliation",
      as_of: "2026-08-30T06:00:00.000Z",
      provenance: { source_id: "handler.reconcile", source_doc_id: null, observed_at: "2026-08-30T06:00:00.000Z", via: "reconcile@1" },
    });
    const handler = recordFindingsHandler({ ledger, clock: () => NOW } as unknown as ActionContext);
    await handler(
      { run_key: "n1", clean: true, findings: [], provisional_subjects: [], answered: ["inst.chase"] },
      passThroughCtx,
      new AbortController().signal,
    );
    expect(ledger.getFinding(other)?.resolved).toBe(false);
  });
});
