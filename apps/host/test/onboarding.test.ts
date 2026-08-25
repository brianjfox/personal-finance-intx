// The non-programmer path: everything the Institutions page does --
// connect, type values in, upload exports, pause, delete, and the
// one-click made-up household -- exercised through the same App methods
// the IPC endpoints call. No hand-written institutions.json anywhere.

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { views } from "@fin/ledger";

import { createApp, type App } from "../src/app";

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "fin-onb-"));

describe("GUI onboarding (managed institutions)", () => {
  test("empty household -> add -> type values -> update -> remove: all through forms, history kept", async () => {
    const dataDir = tmp();
    const app: App = createApp({ dataDir });
    try {
      // Absolutely no data: the welcome screen's condition.
      let ob = app.institutionsOverview();
      expect(ob.institutions).toHaveLength(0);
      expect(ob.hasFacts).toBe(false);

      // Connect a managed institution from the form.
      const entry = app.addInstitution({ name: "Our House", mode: "managed" });
      expect(entry.institution_id).toBe("inst.our_house");
      // The registry file exists but the operator never touched it.
      expect(fs.existsSync(path.join(dataDir, "institutions.json"))).toBe(true);

      // A managed institution with no accounts yet must not poison the nightly.
      const clean = await app.runNightly({ runId: "nightly_onb0" });
      expect(clean.terminalStatus).toBe("completed");
      expect(app.ledger.openFindings({ subject: entry.institution_id })).toHaveLength(0);

      // Type in the first account; the save reconciles immediately.
      const saved = await app.saveManagedAccount(entry.institution_id, {
        name: "The house",
        type: "other",
        value: "480000",
      });
      expect(saved.status).toBe("completed");
      expect(saved.account.account_id).toBe("acct.our_house.the_house");
      let nw = views.netWorth(app.ledger);
      expect(nw.lines.find((l) => l.account_id === saved.account.account_id)?.value).toBe("480000");

      // Update the value: a new observation, not an edit.
      const beforeUpdate = new Date().toISOString();
      await new Promise((r) => setTimeout(r, 5));
      await app.saveManagedAccount(entry.institution_id, {
        account_id: saved.account.account_id,
        name: "The house",
        type: "other",
        value: "495000",
      });
      nw = views.netWorth(app.ledger);
      expect(nw.lines.find((l) => l.account_id === saved.account.account_id)?.value).toBe("495000");
      // The prior observation is still there, dated: ask the ledger as of before the update.
      const asBefore = views.balances(app.ledger, { subject: saved.account.account_id, observedAt: beforeUpdate });
      expect(asBefore.find((b) => b.balance_type === "total")?.amount).toBe("480000");

      // A liability type lands on the owed side.
      await app.saveManagedAccount(entry.institution_id, { name: "Rewards card", type: "credit_card", value: "1200" });
      nw = views.netWorth(app.ledger);
      expect(Number(nw.liabilities)).toBe(1200);

      // Remove = observed at 0; the account's history stays.
      const removed = await app.removeManagedAccount(entry.institution_id, saved.account.account_id);
      expect(removed.status).toBe("completed");
      nw = views.netWorth(app.ledger);
      expect(nw.lines.find((l) => l.account_id === saved.account.account_id)?.value).toBe("0");
      ob = app.institutionsOverview();
      const inst = ob.institutions.find((i) => i.institution_id === entry.institution_id);
      expect(inst?.accounts.find((a) => a.account_id === saved.account.account_id)?.closed).toBe(true);
      expect(ob.hasFacts).toBe(true);
    } finally {
      app.close();
    }
  });

  test("pause and resume: a paused connection builds no adapter and is skipped by the nightly", async () => {
    const dataDir = tmp();
    const app = createApp({ dataDir });
    try {
      const entry = app.addInstitution({ name: "Paused Bank", mode: "files" });
      // Empty inbox: an enabled files institution fails loudly...
      let r = await app.runNightly({ runId: "nightly_onb1" });
      expect(r.terminalStatus).toBe("completed");
      expect(app.institutionsOverview().institutions[0]?.problems.length).toBeGreaterThan(0);
      // ...but pausing it silences future runs.
      const findingsBefore = app.ledger.allFindings(100).length;
      expect(app.setInstitutionEnabled(entry.institution_id, false)).toBe(true);
      expect(app.institutions().adapters).toHaveLength(0);
      expect(app.institutionsOverview().institutions[0]?.enabled).toBe(false);
      r = await app.runNightly({ runId: "nightly_onb2" });
      expect(r.terminalStatus).toBe("completed");
      // No new finding was emitted for the paused institution.
      expect(app.ledger.allFindings(100).length).toBe(findingsBefore);
      expect(app.setInstitutionEnabled(entry.institution_id, true)).toBe(true);
      expect(app.institutions().adapters).toHaveLength(1);
    } finally {
      app.close();
    }
  });

  test("file uploads: a good export lands in the ledger; a bad one becomes a plain-words problem", async () => {
    const dataDir = tmp();
    const app = createApp({ dataDir });
    try {
      const entry = app.addInstitution({ name: "Export Bank", mode: "files" });
      const snapshot = {
        institution_id: entry.institution_id,
        accounts: [
          {
            account_id: "acct.export_bank.checking",
            name: "Checking",
            type: "checking",
            currency: "USD",
            as_of: new Date().toISOString(),
            balances: [{ balance_type: "total", amount: "2500.00" }],
          },
        ],
      };
      const stored = app.storeInstitutionFile(entry.institution_id, "statement.json", new TextEncoder().encode(JSON.stringify(snapshot)));
      expect(stored.filename.endsWith("statement.json")).toBe(true);
      const run = await app.refreshInstitution(entry.institution_id);
      expect(run.status).toBe("completed");
      expect(views.netWorth(app.ledger).lines.find((l) => l.account_id === "acct.export_bank.checking")?.value).toBe("2500.00");

      // Garbage upload: the nightly completes, the problem shows on the card.
      app.storeInstitutionFile(entry.institution_id, "zz-not-a-statement.json", new TextEncoder().encode("this is not json"));
      const bad = await app.refreshInstitution(entry.institution_id);
      expect(bad.status).toBe("completed");
      const inst = app.institutionsOverview().institutions.find((i) => i.institution_id === entry.institution_id);
      expect(inst?.problems.length).toBeGreaterThan(0);
    } finally {
      app.close();
    }
  });

  test("delete keeps history: the connection goes away, the recorded facts do not", async () => {
    const dataDir = tmp();
    const app = createApp({ dataDir });
    try {
      const entry = app.addInstitution({ name: "Short Lived", mode: "managed" });
      await app.saveManagedAccount(entry.institution_id, { name: "Cash", type: "checking", value: "100" });
      expect(app.removeInstitution(entry.institution_id)).toBe(true);
      const ob = app.institutionsOverview();
      expect(ob.institutions).toHaveLength(0);
      expect(ob.hasFacts).toBe(true);
      expect(views.netWorth(app.ledger).lines).toHaveLength(1);
    } finally {
      app.close();
    }
  });

  test("the made-up data button: one call seeds the fictional household and reconciles it", async () => {
    const dataDir = tmp();
    const app = createApp({ dataDir });
    try {
      expect(app.institutionsOverview().institutions).toHaveLength(0);
      const r = await app.seedDemoData();
      expect(r.institutions).toBe(3);
      expect(r.status).toBe("completed");
      const ob = app.institutionsOverview();
      expect(ob.hasFacts).toBe(true);
      expect(ob.institutions.map((i) => i.institution_id).sort()).toEqual(["inst.demobank", "inst.demobroker", "inst.demoproperty"]);
    } finally {
      app.close();
    }
  });
});

describe("holdings categories", () => {
  test("a property is a managed real_estate institution; the category and type survive the round trip", async () => {
    const app = createApp({ dataDir: tmp() });
    try {
      const inst = app.addInstitution({ name: "12 Main St", mode: "managed", category: "real_estate" });
      const saved = await app.saveManagedAccount(inst.institution_id, { name: "12 Main St", type: "real_estate", value: "1250000" });
      expect(saved.status).toBe("completed");
      const ob = app.institutionsOverview();
      const row = ob.institutions.find((i) => i.institution_id === inst.institution_id)!;
      expect(row.category).toBe("real_estate");
      expect(row.accounts[0]).toMatchObject({ type: "real_estate", value: "1250000" });
      expect(views.netWorth(app.ledger).assets).toBe("1250000");
    } finally {
      app.close();
    }
  });
});
