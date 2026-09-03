// Issue #72: the desktop tray's loopback-only surface -- the net-worth
// figure the operator chose to show in the menu bar, and refresh-all.
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { SnapshotAccount } from "@fin/contracts";
import { fixtureAdapter } from "@fin/institutions";
import type { InferenceSource } from "@intx/types/runtime";

import { createApp } from "../src/app";
import { startIpc } from "../src/ipc";

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "fin-tray-"));
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

describe("tray endpoints", () => {
  test("summary serves the net worth without a session; refresh kicks the nightly; unknown paths 404", async () => {
    const dataDir = tmp();
    const app = createApp({ dataDir, adapters: [fixtureAdapter("inst.bank", { accounts: [checking(new Date())] })], pollMs: 20, inferenceSource: stubSource, historicSpot: async () => null });
    const server = startIpc({ app, port: 0 });
    try {
      expect((await app.runNightly({ runId: "n1" })).terminalStatus).toBe("completed");
      const base = `http://127.0.0.1:${server.port}`;
      const summary = (await (await fetch(`${base}/api/tray/summary`)).json()) as { available: boolean; net_worth?: string; currency?: string };
      expect(summary.available).toBe(true);
      expect(summary.net_worth).toBe("12345.67");
      expect(summary.currency).toBe("USD");
      const refresh = (await (await fetch(`${base}/api/tray/refresh`, { method: "POST" }))!.json()) as { started: boolean; already_running?: boolean };
      expect(refresh.started === true || refresh.already_running === true).toBe(true);
      expect((await fetch(`${base}/api/tray/nothing`)).status).toBe(404);
      // The authenticated surface is untouched: single-user /api/net-worth still answers.
      expect((await fetch(`${base}/api/net-worth`)).status).toBe(200);
    } finally {
      server.stop(true);
      app.close();
    }
  });
});
