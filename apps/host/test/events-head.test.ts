// Issue #120: the GUI polls the ledger's event head to notice a nightly
// it did not start. One number, cheap enough for a 30-second poll.
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { SnapshotAccount } from "@fin/contracts";
import { fixtureAdapter } from "@fin/institutions";
import type { InferenceSource } from "@intx/types/runtime";

import { createApp } from "../src/app";
import { startIpc } from "../src/ipc";

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "fin-events-head-"));
const stubSource = (): InferenceSource => ({ id: "stub", provider: "anthropic", baseURL: "http://localhost:1", apiKey: "stub", model: "stub" });

function checking(now: Date): SnapshotAccount {
  return {
    account_id: "acct.bank.checking",
    name: "Checking",
    type: "checking",
    currency: "USD",
    as_of: now.toISOString(),
    balances: [{ balance_type: "total", amount: "12345.67" }],
    positions: [],
    transactions: [],
  };
}

describe("/api/events/head", () => {
  test("starts at 0 and advances when a nightly the GUI did not start lands", async () => {
    const dataDir = tmp();
    const app = createApp({ dataDir, adapters: [fixtureAdapter("inst.bank", { accounts: [checking(new Date())] })], pollMs: 20, inferenceSource: stubSource, historicSpot: async () => null });
    const server = startIpc({ app, port: 0 });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const head = async () => ((await (await fetch(`${base}/api/events/head`)).json()) as { seq: number }).seq;
      expect(await head()).toBe(0);
      // The tray's refresh, the scheduler, the CLI: all reach runNightly without the GUI.
      expect((await app.runNightly({ runId: "n1" })).terminalStatus).toBe("completed");
      const after = await head();
      expect(after).toBeGreaterThan(0);
      expect(after).toBe(app.ledger.lastSeq());
      expect(app.ledger.eventsSince(0).at(-1)?.seq).toBe(after);
    } finally {
      server.stop(true);
      app.close();
    }
  });
});
