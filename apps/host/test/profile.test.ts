// The household profile: saved from the GUI, redacted everywhere else.
// The tax id round-trips through storage but never appears in what the
// IPC surface or the agents' household_profile tool returns.

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { memorySecretStore } from "@fin/institutions";
import { householdProfileTool } from "@fin/tools";

import { createApp } from "../src/app";

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "fin-prof-"));

describe("household profile", () => {
  test("save -> redacted get; empty ssn keeps the stored one; clear_ssn removes it", () => {
    const app = createApp({ dataDir: tmp() });
    try {
      expect(app.getProfile()).toEqual({ configured: false });

      app.saveProfile({
        person: { legal_name: "Brian J. Fox", date_of_birth: "1959-12-21", ssn: "123-45-6789", citizenship: "US", country_of_residence: "US", state_or_province: "CA", marital_status: "married" },
        spouse: { legal_name: "Spouse Example" },
        children: [{ legal_name: "Child One", relationship: "daughter" }],
        others: [{ legal_name: "Old Friend", relationship: "friend" }],
      });
      const got = app.getProfile();
      expect(got.configured).toBe(true);
      if (!got.configured) throw new Error("unreachable");
      expect(got.person.ssn_last4).toBe("6789");
      expect(JSON.stringify(got)).not.toContain("123-45");
      expect((got.person as Record<string, unknown>)["ssn"]).toBeUndefined();
      expect(got.spouse?.legal_name).toBe("Spouse Example");
      expect(got.children).toHaveLength(1);

      // A save with no ssn typed keeps the stored one.
      app.saveProfile({ person: { legal_name: "Brian J. Fox" }, spouse: null, children: [], others: [] });
      const kept = app.getProfile();
      if (!kept.configured) throw new Error("unreachable");
      expect(kept.person.ssn_last4).toBe("6789");
      expect(kept.spouse ?? null).toBeNull();

      // clear_ssn actually removes it.
      app.saveProfile({ person: { legal_name: "Brian J. Fox" }, children: [], others: [], clear_ssn: true });
      const cleared = app.getProfile();
      if (!cleared.configured) throw new Error("unreachable");
      expect(cleared.person.ssn_last4).toBeNull();
    } finally {
      app.close();
    }
  });

  test("the household_profile tool redacts the tax id and says when nothing is collected", async () => {
    const evidence: unknown[] = [];
    const fin = {
      profile: () => ({
        person: { legal_name: "Brian J. Fox", ssn: "123-45-6789", marital_status: "married" as const },
        spouse: { legal_name: "Spouse Example" },
        children: [],
        others: [],
      }),
      clock: () => new Date(),
      evidence: (e: unknown) => evidence.push(e),
    } as never;
    const r = await householdProfileTool.handler({}, fin);
    const text = JSON.stringify(r.result);
    expect(r.result["configured"]).toBe(true);
    expect(text).not.toContain("123-45");
    expect(text).toContain("6789"); // last four only
    expect(text).toContain("Spouse Example");

    const empty = await householdProfileTool.handler({}, { profile: () => null } as never);
    expect(empty.result["configured"]).toBe(false);
    expect(JSON.stringify(empty.result)).toContain("People page");
  });
});

describe("free-text profile intake", () => {
  test("the model's tool reply becomes a validated patch; garbage fields are scrubbed", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/v1/messages") {
          const body = (await req.json()) as { tool_choice?: { name?: string }; system?: string };
          expect(body.tool_choice?.name).toBe("fill_profile");
          expect(body.system).toContain("Today is");
          expect(body.system).toContain("Never guess");
          return Response.json({
            content: [{
              type: "tool_use",
              name: "fill_profile",
              input: {
                person: { legal_name: "Brian J. Fox", state_or_province: "CA", marital_status: "married", date_of_birth: "not-a-date" },
                spouse: { legal_name: "Alex Example" },
                children: [
                  { legal_name: "Sam Example", date_of_birth: "2004-03-02" },
                  { legal_name: "Riley Example", note: "age 15 as of now" },
                  { legal_name: "" },
                ],
                others: [{ legal_name: "Ted Fox", relationship: "brother" }],
                note: "Riley's exact birth date wasn't given.",
              },
            }],
          });
        }
        return new Response("not found", { status: 404 });
      },
    });
    try {
      const app = createApp({
        dataDir: tmp(),
        inferenceSource: () => ({ id: "stub", provider: "anthropic", baseURL: `http://127.0.0.1:${server.port}`, apiKey: "k", model: "m" }),
      });
      try {
        const patch = await app.extractProfile("I'm Brian, married to Alex, kids Sam (2004-03-02) and Riley who's 15; brother Ted should be in the will.");
        expect(patch.person?.legal_name).toBe("Brian J. Fox");
        expect(patch.person?.date_of_birth).toBeUndefined(); // malformed date scrubbed
        expect(patch.spouse?.legal_name).toBe("Alex Example");
        expect(patch.children).toHaveLength(2); // empty-name row scrubbed
        expect(patch.children?.[1]).toMatchObject({ legal_name: "Riley Example", note: "age 15 as of now" });
        expect(patch.others?.[0]).toMatchObject({ legal_name: "Ted Fox", relationship: "brother" });
        expect(patch.note).toContain("Riley");
      } finally {
        app.close();
      }
    } finally {
      server.stop();
    }
  });

  test("no AI key means the Credentials-page message, not a crash", async () => {
    const saved = process.env["ANTHROPIC_API_KEY"];
    delete process.env["ANTHROPIC_API_KEY"];
    // A memory store isolates the test from the developer's real Keychain.
    const app = createApp({ dataDir: tmp(), connectors: { secrets: memorySecretStore() } });
    try {
      expect(app.extractProfile("hello")).rejects.toThrow(/Credentials page/);
    } finally {
      app.close();
      if (saved !== undefined) process.env["ANTHROPIC_API_KEY"] = saved;
    }
  });
});

describe("freeform dates in profile saves", () => {
  test("'Jul 30 1959' style dates normalize to ISO everywhere; garbage refuses by name", () => {
    const app = createApp({ dataDir: tmp() });
    try {
      app.saveProfile({
        person: { legal_name: "Brian J. Fox", date_of_birth: "Dec 11, 1959" },
        spouse: { legal_name: "Spouse Example", date_of_birth: "Jul 30 1959" },
        children: [{ legal_name: "Koa", date_of_birth: "November 25, 2025" }],
        others: [{ legal_name: "Ted", date_of_birth: "3/4/1990" }],
      });
      const got = app.getProfile();
      if (!got.configured) throw new Error("unreachable");
      expect(got.person.date_of_birth).toBe("1959-12-11");
      expect(got.spouse?.date_of_birth).toBe("1959-07-30");
      expect(got.children?.[0]?.date_of_birth).toBe("2025-11-25");
      expect(got.others?.[0]?.date_of_birth).toBe("1990-03-04"); // US month-first
      expect(() =>
        app.saveProfile({ person: { legal_name: "B" }, children: [{ legal_name: "Kid", date_of_birth: "sometime" }], others: [] }),
      ).toThrow(/couldn't read "sometime" as Kid's date/);
    } finally {
      app.close();
    }
  });

  // Regression: the GUI talks HTTP, and the request-body schema used to
  // demand strict ISO dates -- "nov 3 1977" bounced with a 400 before
  // the freeform parser ever ran.
  test("freeform dates survive the HTTP boundary; an unreadable one refuses without touching the stored profile", async () => {
    const { startIpc } = await import("../src/ipc");
    const app = createApp({ dataDir: tmp() });
    const server = startIpc({ app, port: 0 });
    const post = (body: unknown): Promise<Response> =>
      fetch(`http://127.0.0.1:${server.port}/api/profile`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    try {
      const ok = await post({
        person: { legal_name: "Brian J. Fox" },
        children: [],
        others: [
          { legal_name: "Sib One", relationship: "sibling", date_of_birth: "nov 3 1977" },
          { legal_name: "Sib Two", relationship: "sibling", date_of_birth: "mar 9, 1981" },
        ],
      });
      expect(ok.status).toBe(200);
      const saved = (await ok.json()) as { others: Array<{ date_of_birth?: string }> };
      expect(saved.others.map((o) => o.date_of_birth)).toEqual(["1977-11-03", "1981-03-09"]);

      const bad = await post({
        person: { legal_name: "Brian J. Fox" },
        children: [],
        others: [{ legal_name: "Sib One", relationship: "sibling", date_of_birth: "nov 3 77" }],
      });
      expect(bad.status).toBeGreaterThanOrEqual(400);
      expect(((await bad.json()) as { error: string }).error).toMatch(/couldn't read "nov 3 77" as Sib One's date/);
      // The refused save changed nothing.
      const got = app.getProfile();
      if (!got.configured) throw new Error("unreachable");
      expect(got.others?.[0]?.date_of_birth).toBe("1977-11-03");
    } finally {
      server.stop(true);
      app.close();
    }
  });
});

describe("tax profile from the GUI", () => {
  test("friendly rates and amounts normalize; the reserve must be a real account; garbage refuses by name", async () => {
    const app = createApp({ dataDir: tmp() });
    try {
      // No accounts yet: the reserve check fails in plain words.
      expect(() =>
        app.saveTaxProfile({ tax_year: 2026, ordinary_rate: "24%", ltcg_rate: "15", prior_year_tax: "$18,500", prior_year_agi_over_150k: true, withholding_annual: "12000", reserve_account: "acct.x.y" }),
      ).toThrow(/isn't a known account/);

      const inst = app.addInstitution({ name: "Bank", mode: "managed" });
      const saved = await app.saveManagedAccount(inst.institution_id, { name: "Savings", type: "savings", value: "$25,000" });
      const p = app.saveTaxProfile({
        tax_year: 2026,
        ordinary_rate: "24%",
        ltcg_rate: "0.15",
        prior_year_tax: "$18,500",
        prior_year_agi_over_150k: true,
        withholding_annual: "12,000",
        reserve_account: saved.account.account_id,
      });
      expect(p).toMatchObject({ ordinary_rate: "0.24", ltcg_rate: "0.15", prior_year_tax: "18500", withholding_annual: "12000", prestage_lead_days: 30 });
      expect(app.taxProfile()?.reserve_account).toBe(saved.account.account_id);

      expect(() =>
        app.saveTaxProfile({ tax_year: 2026, ordinary_rate: "240%", ltcg_rate: "15", prior_year_tax: "1", prior_year_agi_over_150k: false, withholding_annual: "1", reserve_account: saved.account.account_id }),
      ).toThrow(/doesn't look like a tax rate/);
      expect(() =>
        app.saveTaxProfile({ tax_year: 2026, ordinary_rate: "24", ltcg_rate: "15", prior_year_tax: "a lot", prior_year_agi_over_150k: false, withholding_annual: "1", reserve_account: saved.account.account_id }),
      ).toThrow(/couldn't read "a lot"/);
    } finally {
      app.close();
    }
  });
});
