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

import { COINBASE_SERVICE, ENABLEBANKING_SERVICE, memorySecretStore, PLAID_SERVICE } from "@fin/institutions";
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
      // The fetch log kept the wire record (request/response + headers),
      // with credentials masked before storage.
      const flog = app.getFetchLogs("inst.chase");
      expect(flog.length).toBeGreaterThan(0);
      expect(flog[0]!.ok).toBe(true);
      expect(flog[0]!.entries.some((e) => e.url.endsWith("/accounts/balance/get") && e.status === 200)).toBe(true);
      expect(JSON.stringify(flog)).not.toContain("access-1");
      const bal = flog[0]!.entries.find((e) => e.url.endsWith("/accounts/balance/get"))!;
      expect(bal.request_body).toContain('"access_token":"••••"');
      expect(bal.request_body).toContain('"client_id":"cid"');
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

describe("coinbase connect flow (mock API)", () => {
  const { privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const ecPem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;

  test("paste key -> stored, entry added, holdings priced into the ledger; key rotation reuses the entry", async () => {
    const base = serve((req) => {
      const url = new URL(req.url);
      if (url.pathname === "/v2/prices/BTC-USD/spot") return Response.json({ data: { amount: "50000" } });
      if (!(req.headers.get("authorization") ?? "").startsWith("Bearer ")) return new Response("no jwt", { status: 401 });
      if (url.pathname === "/api/v3/brokerage/accounts") {
        return Response.json({
          accounts: [{ uuid: "u1", name: "BTC Wallet", currency: "BTC", available_balance: { value: "0.1", currency: "BTC" }, hold: { value: "0", currency: "BTC" } }],
          has_next: false,
        });
      }
      return new Response("not found", { status: 404 });
    });
    const secrets = memorySecretStore();
    const app = createApp({ dataDir: tmp(), connectors: { coinbaseBaseUrl: base, secrets } });
    try {
      // A garbage key is refused before anything is stored.
      expect(app.connectCoinbase({ apiKeyName: "org/x/apiKeys/y", privateKey: "not a pem" })).rejects.toThrow(/unrecognized private key/);
      expect(app.institutionsOverview().institutions).toHaveLength(0);

      const done = await app.connectCoinbase({ name: "Coinbase", apiKeyName: "org/x/apiKeys/y", privateKey: ecPem });
      expect(done.institution_id).toBe("inst.coinbase");
      expect(done.status).toBe("completed");
      expect(secrets.dump()[`${COINBASE_SERVICE}/api_key_name:inst.coinbase`]).toBe("org/x/apiKeys/y");
      const nw = views.netWorth(app.ledger);
      expect(nw.lines.find((l) => l.account_id === "acct.coinbase.coinbase")?.value).toBe("5000");
      expect(views.positions(app.ledger).some((p) => p.symbol === "BTC" && p.quantity === "0.1")).toBe(true);

      // Rotation: same entry, new key stored -- this time the modern shape,
      // the whole downloaded CDP key file (Ed25519, base64) pasted as-is.
      const ed = crypto.generateKeyPairSync("ed25519");
      const seed = Buffer.from(ed.privateKey.export({ format: "jwk" }).d as string, "base64url");
      const pub = Buffer.from(ed.publicKey.export({ format: "jwk" }).x as string, "base64url");
      const keyFile = JSON.stringify({ name: "organizations/x/apiKeys/ed", privateKey: Buffer.concat([seed, pub]).toString("base64") });
      const again = await app.connectCoinbase({ institutionId: "inst.coinbase", apiKeyName: "", privateKey: keyFile });
      expect(again.institution_id).toBe("inst.coinbase");
      expect(again.status).toBe("completed");
      expect(secrets.dump()[`${COINBASE_SERVICE}/api_key_name:inst.coinbase`]).toBe("organizations/x/apiKeys/ed");
      expect(app.institutionsOverview().institutions).toHaveLength(1);
    } finally {
      app.close();
    }
  });
});

describe("watch-only wallet connect flow (mock chain APIs)", () => {
  const BTC = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";
  const LTC = "ltc1qhta4z5m9zzz9d2h6nruvhg50a0kcw6kj5wmydt";
  const ETH = "0x00000000219ab540356cBB839Cbe05303d7705Fa";
  const SOL = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

  test("pasted addresses are chain-detected, read on-chain, and priced into the ledger", async () => {
    const base = serve(async (req) => {
      const url = new URL(req.url);
      if (url.pathname === `/btc/address/${BTC}`) return Response.json({ chain_stats: { funded_txo_sum: 30000000, spent_txo_sum: 0 } }); // 0.3 BTC
      if (url.pathname === `/ltc/address/${LTC}`) return Response.json({ chain_stats: { funded_txo_sum: 500000000, spent_txo_sum: 0 } }); // 5 LTC
      if (url.pathname === "/rpc") return Response.json({ jsonrpc: "2.0", id: 1, result: "0xde0b6b3a7640000" }); // 1 ETH
      if (url.pathname === "/solrpc") return Response.json({ jsonrpc: "2.0", id: 1, result: { context: {}, value: 2500000000 } }); // 2.5 SOL
      if (url.pathname === "/v2/prices/BTC-USD/spot") return Response.json({ data: { amount: "50000" } });
      if (url.pathname === "/v2/prices/LTC-USD/spot") return Response.json({ data: { amount: "100" } });
      if (url.pathname === "/v2/prices/ETH-USD/spot") return Response.json({ data: { amount: "2000" } });
      if (url.pathname === "/v2/prices/SOL-USD/spot") return Response.json({ data: { amount: "200" } });
      return new Response(`not found: ${url.pathname}`, { status: 404 });
    });
    const app = createApp({
      dataDir: tmp(),
      connectors: {
        secrets: memorySecretStore(),
        walletApis: { btc_api: `${base}/btc`, ltc_api: `${base}/ltc`, eth_rpc: `${base}/rpc`, sol_rpc: `${base}/solrpc`, price_api: base },
      },
    });
    try {
      // A recognized-but-unsupported address refuses by name before anything is stored.
      expect(
        app.connectWallet({ name: "Ledger", holdings: [{ value: "DH5yaieqoZN36fDVciNyRueRGvGLR3mr7L" }] }),
      ).rejects.toThrow(/Dogecoin/);
      expect(app.institutionsOverview().institutions).toHaveLength(0);

      // No kinds anywhere: the chain comes from the address itself.
      const done = await app.connectWallet({
        name: "Ledger",
        holdings: [{ value: BTC, label: "Ledger BTC" }, { value: LTC }, { value: ETH }, { value: SOL }],
      });
      expect(done.institution_id).toBe("inst.ledger");
      expect(done.status).toBe("completed");
      const nw = views.netWorth(app.ledger);
      // 0.3*50000 + 5*100 + 1*2000 + 2.5*200 = 15000 + 500 + 2000 + 500
      expect(nw.lines.find((l) => l.account_id === "acct.ledger.wallet")?.value).toBe("18000");
      const symbols = views.positions(app.ledger).filter((x) => x.account_id === "acct.ledger.wallet").map((x) => x.symbol).sort();
      expect(symbols).toEqual(["BTC", "ETH", "LTC", "SOL"]);
      const ob = app.institutionsOverview();
      expect(ob.institutions[0]).toMatchObject({ institution_id: "inst.ledger", adapter: "wallet", enabled: true });
      // The chain responses are vault evidence like any statement.
      expect(app.ledger.listDocuments().some((d) => d.filename.startsWith("wallet-"))).toBe(true);
    } finally {
      app.close();
    }
  });
});

describe("kraken connect flow (mock API)", () => {
  test("paste key pair -> stored, entry added, balances priced; rotation reuses the entry; garbage refused", async () => {
    const { krakenSign, KRAKEN_SERVICE } = require("@fin/institutions") as typeof import("@fin/institutions");
    const SECRET = crypto.randomBytes(64).toString("base64");
    const base = serve(async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/v2/prices/BTC-USD/spot") return Response.json({ data: { amount: "50000" } });
      if (url.pathname === "/0/private/Balance") {
        const postData = await req.text();
        const nonce = new URLSearchParams(postData).get("nonce") ?? "";
        const ok = req.headers.get("API-Sign") === krakenSign("/0/private/Balance", nonce, postData, SECRET);
        return ok
          ? Response.json({ error: [], result: { XXBT: "0.2" } })
          : Response.json({ error: ["EAPI:Invalid signature"] });
      }
      return new Response("not found", { status: 404 });
    });
    const secrets = memorySecretStore();
    const app = createApp({ dataDir: tmp(), connectors: { krakenBaseUrl: base, secrets } });
    try {
      expect(app.connectKraken({ name: "Kraken", apiKey: "k", privateKey: "not base64!!" })).rejects.toThrow(/doesn't look like a Kraken key pair/);
      expect(app.institutionsOverview().institutions).toHaveLength(0);

      const done = await app.connectKraken({ name: "Kraken", apiKey: "key-1", privateKey: SECRET });
      expect(done.institution_id).toBe("inst.kraken");
      expect(done.status).toBe("completed");
      expect(secrets.dump()[`${KRAKEN_SERVICE}/api_key:inst.kraken`]).toBe("key-1");
      expect(views.netWorth(app.ledger).lines.find((l) => l.account_id === "acct.kraken.kraken")?.value).toBe("10000"); // 0.2 * 50000

      const again = await app.connectKraken({ institutionId: "inst.kraken", apiKey: "key-2", privateKey: SECRET });
      expect(again.institution_id).toBe("inst.kraken");
      expect(secrets.dump()[`${KRAKEN_SERVICE}/api_key:inst.kraken`]).toBe("key-2");
      expect(app.institutionsOverview().institutions).toHaveLength(1);
      // Its tokens show on the credentials page and vanish with the institution.
      expect(app.credentialsStatus().tokens).toEqual([{ institution_id: "inst.kraken", name: "Kraken", adapter: "kraken", set: true }]);
      expect(app.removeInstitution("inst.kraken")).toBe(true);
      expect(Object.keys(secrets.dump())).toHaveLength(0);
    } finally {
      app.close();
    }
  });
});

describe("plaid wizard test call", () => {
  test("translates Plaid's answers into plain words", async () => {
    let respond: (r: Response) => void = () => {};
    const fake = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        return new Promise<Response>((res) => {
          respond = res;
          res(nextResponse);
        });
      },
    });
    let nextResponse = Response.json({ link_token: "link-tok" });
    const { createConnectors } = await import("../src/connect");
    const secrets = memorySecretStore({ "fin-plaid/client_id": "cid", "fin-plaid/secret": "sec" });
    const c = createConnectors({ secrets, plaidBaseUrl: `http://127.0.0.1:${fake.port}` });
    try {
      expect((await c.plaidTest()).ok).toBe(true);
      nextResponse = Response.json({ error_code: "INVALID_API_KEYS", error_message: "invalid client_id or secret provided" }, { status: 400 });
      const bad = await c.plaidTest();
      expect(bad.ok).toBe(false);
      expect(bad.detail).toContain("Production secret");
      nextResponse = Response.json({ error_code: "INVALID_PRODUCT", error_message: "products not enabled" }, { status: 400 });
      expect((await c.plaidTest()).detail).toContain("Production access");
      // No keys stored at all: plain words, not a stack trace.
      const none = createConnectors({ secrets: memorySecretStore(), plaidBaseUrl: `http://127.0.0.1:${fake.port}` });
      expect((await none.plaidTest()).detail).toContain("Credentials page");
    } finally {
      void respond;
      fake.stop(true);
    }
  });
});

describe("plaid auto-finish", () => {
  test("the loopback return completes the exchange without a manual finish; unregistered redirect falls back", async () => {
    const { stopPlaidFinishListener, PLAID_FINISH_URI } = await import("../src/plaid-finish");
    let rejectRedirect = false;
    const fake = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const path = new URL(req.url).pathname;
        const body = (await req.json()) as Record<string, unknown>;
        switch (path) {
          case "/link/token/create": {
            const hosted = body["hosted_link"] as Record<string, unknown>;
            if (rejectRedirect && hosted["completion_redirect_uri"] !== undefined) {
              return Response.json({ error_code: "INVALID_FIELD", error_message: "completion_redirect_uri is not a registered redirect uri" }, { status: 400 });
            }
            return Response.json({ link_token: "link-af-1", hosted_link_url: "https://hosted.example/af" });
          }
          case "/link/token/get":
            return Response.json({ link_sessions: [{ results: { item_add_results: [{ public_token: "public-af" }] } }] });
          case "/item/public_token/exchange":
            return Response.json({ access_token: "access-af", item_id: "item-af" });
          case "/accounts/get":
            return Response.json({ accounts: [{ account_id: "a1", name: "Checking", type: "depository", subtype: "checking", balances: { current: 10, iso_currency_code: "USD" }, mask: "1111" }], item: { institution_id: "ins_1" } });
          case "/transactions/get":
            return Response.json({ transactions: [], total_transactions: 0 });
          default:
            return Response.json({ error_code: "NOT_FOUND" }, { status: 404 });
        }
      },
    });
    const secrets = memorySecretStore({ [`${PLAID_SERVICE}/client_id`]: "cid", [`${PLAID_SERVICE}/secret`]: "sec" });
    const app = createApp({ dataDir: tmp(), connectors: { plaidBaseUrl: `http://127.0.0.1:${fake.port}`, secrets } });
    try {
      const start = await app.connectPlaidStart({ name: "Auto Bank" });
      expect(start.auto_finish).toBe(true);
      expect(app.plaidPending().state).toBe("waiting");

      // The browser landing on /plaid/done is the whole trigger.
      const done = await fetch(PLAID_FINISH_URI);
      expect(done.status).toBe(200);
      expect(await done.text()).toContain("You're connected");
      for (let i = 0; i < 100 && app.plaidPending().state === "waiting"; i++) await Bun.sleep(50);
      expect(app.plaidPending().state).toBe("done");
      const inst = app.institutionsOverview().institutions.find((x) => x.name === "Auto Bank");
      expect(inst).toBeDefined();
      expect(secrets.get(PLAID_SERVICE, `access_token:${inst!.institution_id}`)).toBe("access-af");

      // Dashboard without the registered redirect: graceful fallback to manual.
      rejectRedirect = true;
      const fallback = await app.connectPlaidStart({ name: "Manual Bank" });
      expect(fallback.auto_finish).toBe(false);
      expect(app.plaidPending().state).toBe("none");
    } finally {
      stopPlaidFinishListener();
      fake.stop(true);
      app.close();
    }
  }, 60_000);
});
