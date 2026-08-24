// The connect flows end to end through the App: Plaid Hosted Link ->
// token exchange -> registry entry -> nightly -> ledger, and Enable
// Banking consent -> session -> nightly -> ledger, against local mocks
// of both APIs. Also the reconnect path (expired consent) updating the
// same institution instead of creating a second one.

import { afterAll, describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ENABLEBANKING_SERVICE, memorySecretStore, PLAID_SERVICE } from "@fin/institutions";
import { views } from "@fin/ledger";

import { createApp } from "../src/app";

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "fin-conn-"));
const servers: Array<{ stop: () => void }> = [];
afterAll(() => servers.forEach((s) => s.stop()));

function serve(handler: (req: Request) => Response | Promise<Response>): string {
  const s = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  servers.push(s);
  return `http://127.0.0.1:${s.port}`;
}

describe("plaid connect flow (mock API)", () => {
  test("start -> hosted link -> complete -> the ledger holds the bank's numbers", async () => {
    let linkFinished = false;
    const base = serve(async (req) => {
      const url = new URL(req.url);
      const body = (await req.json()) as Record<string, unknown>;
      if (body["client_id"] !== "cid" || body["secret"] !== "sec") {
        return Response.json({ error_code: "INVALID_API_KEYS" }, { status: 400 });
      }
      switch (url.pathname) {
        case "/link/token/create":
          return Response.json({ link_token: "link-1", hosted_link_url: "https://hosted.example/link-1" });
        case "/link/token/get":
          return Response.json(
            linkFinished
              ? { link_sessions: [{ results: { item_add_results: [{ public_token: "public-1" }] } }] }
              : { link_sessions: [] },
          );
        case "/item/public_token/exchange":
          return body["public_token"] === "public-1"
            ? Response.json({ access_token: "access-1", item_id: "item-1" })
            : Response.json({ error_code: "INVALID_PUBLIC_TOKEN" }, { status: 400 });
        case "/accounts/balance/get":
          return body["access_token"] === "access-1"
            ? Response.json({
                accounts: [{
                  account_id: "chk1", name: "Total Checking", mask: "1234", type: "depository", subtype: "checking",
                  balances: { available: 900, current: 1000, iso_currency_code: "USD" },
                }],
                item: { item_id: "item-1" },
              })
            : Response.json({ error_code: "INVALID_ACCESS_TOKEN" }, { status: 400 });
        case "/transactions/get":
          return Response.json({ transactions: [], total_transactions: 0 });
        case "/investments/holdings/get":
          return Response.json({ error_code: "NO_INVESTMENT_ACCOUNTS" }, { status: 400 });
        default:
          return Response.json({ error_code: "NOT_FOUND" }, { status: 404 });
      }
    });

    const secrets = memorySecretStore({ [`${PLAID_SERVICE}/client_id`]: "cid", [`${PLAID_SERVICE}/secret`]: "sec" });
    const app = createApp({ dataDir: tmp(), connectors: { plaidBaseUrl: base, secrets } });
    try {
      const start = await app.connectPlaidStart();
      expect(start.hosted_link_url).toBe("https://hosted.example/link-1");

      // Finishing too early says so in plain words.
      expect(app.connectPlaidComplete({ name: "Chase", linkToken: start.link_token })).rejects.toThrow(/hasn't finished yet/);

      linkFinished = true; // the operator completed Link in the browser
      const done = await app.connectPlaidComplete({ name: "Chase", linkToken: start.link_token });
      expect(done.institution_id).toBe("inst.chase");
      expect(done.status).toBe("completed");
      expect(secrets.dump()[`${PLAID_SERVICE}/access_token:inst.chase`]).toBe("access-1");

      const nw = views.netWorth(app.ledger);
      expect(nw.lines.find((l) => l.account_id === "acct.chase.chk1")?.value).toBe("1000");
      const ob = app.institutionsOverview();
      expect(ob.institutions[0]).toMatchObject({ institution_id: "inst.chase", adapter: "plaid", enabled: true, managed: false });
      // The raw API responses are in the vault as evidence.
      expect(app.ledger.listDocuments().some((d) => d.filename.startsWith("plaid-"))).toBe(true);
    } finally {
      app.close();
    }
  });
});

describe("enable banking connect flow (mock API)", () => {
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;

  function ebMock(): { base: string; state: { consentValidUntil: string; sessions: number } } {
    const state = { consentValidUntil: "2027-02-01T00:00:00.000Z", sessions: 0 };
    const base = serve(async (req) => {
      if (!(req.headers.get("authorization") ?? "").startsWith("Bearer ")) return new Response("no jwt", { status: 401 });
      const url = new URL(req.url);
      const p = url.pathname;
      if (p === "/aspsps") return Response.json({ aspsps: [{ name: "Mock ASPSP", country: "FI" }, { name: "Nordea", country: "FI" }] });
      if (p === "/auth" && req.method === "POST") {
        const b = (await req.json()) as { state: string; redirect_url: string };
        return Response.json({ url: `https://bank.example/consent?state=${b.state}&redirect=${encodeURIComponent(b.redirect_url)}` });
      }
      if (p === "/sessions" && req.method === "POST") {
        const b = (await req.json()) as { code: string };
        if (b.code !== "auth-code-1") return new Response("bad code", { status: 400 });
        state.sessions += 1;
        return Response.json({
          session_id: `sess-${state.sessions}`,
          accounts: ["uid-1"],
          aspsp: { name: "Mock ASPSP", country: "FI" },
          access: { valid_until: state.consentValidUntil },
        });
      }
      if (/^\/sessions\/sess-\d+$/.test(p)) {
        return Response.json({ status: "AUTHORIZED", accounts: ["uid-1"], access: { valid_until: state.consentValidUntil } });
      }
      if (p === "/accounts/uid-1/details") {
        return Response.json({ account_id: { iban: "FI2112345600000785" }, identification_hash: "hash-1", name: "Käyttötili", currency: "EUR", cash_account_type: "CACC" });
      }
      if (p === "/accounts/uid-1/balances") {
        return Response.json({ balances: [{ balance_amount: { currency: "EUR", amount: "1500.00" }, balance_type: "CLBD" }] });
      }
      if (p === "/accounts/uid-1/transactions") {
        return Response.json({ transactions: [], continuation_key: null });
      }
      return new Response("not found", { status: 404 });
    });
    return { base, state };
  }

  test("banks -> consent -> code -> session -> the ledger holds the EUR account; reconnect reuses the institution", async () => {
    const { base, state } = ebMock();
    const secrets = memorySecretStore({
      [`${ENABLEBANKING_SERVICE}/app_id`]: "app-1",
      [`${ENABLEBANKING_SERVICE}/private_key`]: pem,
    });
    const app = createApp({ dataDir: tmp(), connectors: { ebBaseUrl: base, ebRedirectUrl: "https://redirect.example/cb", secrets } });
    try {
      const banks = await app.ebListBanks("FI");
      expect(banks.map((b) => b.name)).toContain("Mock ASPSP");

      const start = await app.connectEbStart({ name: "Nordbank", country: "FI", bank: "Mock ASPSP" });
      expect(start.url).toContain("https://bank.example/consent?state=");

      const done = await app.connectEbComplete({ state: start.state, code: "auth-code-1" });
      expect(done.institution_id).toBe("inst.nordbank");
      expect(done.status).toBe("completed");
      expect(done.consent_until).toBe("2027-02-01T00:00:00.000Z");
      expect(secrets.dump()[`${ENABLEBANKING_SERVICE}/session:inst.nordbank`]).toBe("sess-1");

      const nw = views.netWorth(app.ledger);
      expect(nw.lines.find((l) => l.account_id === "acct.nordbank.hash-1")?.value).toBe("1500.00");
      expect(app.institutionsOverview().institutions[0]?.consent_until).toBe("2027-02-01T00:00:00.000Z");

      // Reconnect (as after an expiry): same institution, new session, new expiry -- no duplicate entry.
      state.consentValidUntil = "2027-08-01T00:00:00.000Z";
      const re = await app.connectEbStart({ name: "Nordbank", institutionId: "inst.nordbank", country: "FI", bank: "Mock ASPSP" });
      const redone = await app.connectEbComplete({ state: re.state, code: "auth-code-1" });
      expect(redone.institution_id).toBe("inst.nordbank");
      expect(secrets.dump()[`${ENABLEBANKING_SERVICE}/session:inst.nordbank`]).toBe("sess-2");
      const ob = app.institutionsOverview();
      expect(ob.institutions).toHaveLength(1);
      expect(ob.institutions[0]?.consent_until).toBe("2027-08-01T00:00:00.000Z");

      // An unknown state fails in plain words.
      expect(app.connectEbComplete({ state: "nope", code: "auth-code-1" })).rejects.toThrow(/start the bank connection again/);
    } finally {
      app.close();
    }
  });
});
