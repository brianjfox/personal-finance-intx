// Plaid + Enable Banking adapters against faithful local mocks of the
// documented APIs: response shapes, sign conventions, ISO balance codes,
// pagination, tolerated product errors, and credential errors in plain
// words. Live environments are covered by the env-gated tests in
// connectors-live.test.ts.

import { afterAll, describe, expect, test } from "bun:test";
import crypto from "node:crypto";

import {
  enableBankingAdapter,
  enableBankingJwt,
  ENABLEBANKING_SERVICE,
  memorySecretStore,
  plaidAdapter,
  PLAID_SERVICE,
} from "../src";

const NOW = new Date("2026-08-24T12:00:00.000Z");
const servers: Array<{ stop: () => void }> = [];
afterAll(() => servers.forEach((s) => s.stop()));

function serve(handler: (req: Request) => Response | Promise<Response>): string {
  const s = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  servers.push(s);
  return `http://127.0.0.1:${s.port}`;
}

// --- Plaid ------------------------------------------------------------

const PLAID_ACCOUNTS = [
  {
    account_id: "3gE5gnRzNyfXpxK5ap", name: "Plaid Checking", official_name: "Plaid Gold Standard Checking",
    mask: "0000", type: "depository", subtype: "checking",
    balances: { available: 100.5, current: 110.25, limit: null, iso_currency_code: "USD" },
  },
  {
    account_id: "creditAcct1", name: "Plaid Credit Card", official_name: null, mask: "3333",
    type: "credit", subtype: "credit card",
    balances: { available: null, current: 410.75, limit: 2000, iso_currency_code: "USD" },
  },
  {
    account_id: "investAcct1", name: "Plaid IRA", official_name: null, mask: "5555",
    type: "investment", subtype: "ira",
    balances: { available: null, current: 23631.98, limit: null, iso_currency_code: "USD" },
  },
];
const PLAID_TXNS = [
  { transaction_id: "tx-groceries", account_id: "3gE5gnRzNyfXpxK5ap", amount: 89.4, date: "2026-08-20", name: "GROCERY MART", merchant_name: "Grocery Mart", pending: false, iso_currency_code: "USD", personal_finance_category: { primary: "FOOD_AND_DRINK" } },
  { transaction_id: "tx-payroll", account_id: "3gE5gnRzNyfXpxK5ap", amount: -2500, date: "2026-08-15", name: "ACME PAYROLL", merchant_name: null, pending: false, iso_currency_code: "USD", personal_finance_category: { primary: "INCOME" } },
  { transaction_id: "tx-pending", account_id: "3gE5gnRzNyfXpxK5ap", amount: 12, date: "2026-08-23", name: "COFFEE", merchant_name: null, pending: true, iso_currency_code: "USD", personal_finance_category: null },
];
const PLAID_HOLDINGS = {
  holdings: [
    { account_id: "investAcct1", security_id: "sec-vti", quantity: 90.5, institution_price: 250.1, institution_value: 22634.05, cost_basis: 18000 },
    { account_id: "investAcct1", security_id: "sec-cash", quantity: 997.93, institution_price: 1, institution_value: 997.93, cost_basis: null },
  ],
  securities: [
    { security_id: "sec-vti", ticker_symbol: "VTI", name: "Total Stock Market ETF", type: "etf", is_cash_equivalent: false },
    { security_id: "sec-cash", ticker_symbol: "CUR:USD", name: "US Dollar", type: "cash", is_cash_equivalent: true },
  ],
};

function plaidMock(opts: { transactionsError?: string } = {}): string {
  return serve(async (req) => {
    const url = new URL(req.url);
    const body = (await req.json()) as Record<string, unknown>;
    if (body["client_id"] !== "cid" || body["secret"] !== "sec") {
      return Response.json({ error_code: "INVALID_API_KEYS", error_message: "bad keys" }, { status: 400 });
    }
    if (body["access_token"] !== "access-token-1") {
      return Response.json({ error_code: "INVALID_ACCESS_TOKEN", error_message: "bad token" }, { status: 400 });
    }
    switch (url.pathname) {
      case "/accounts/balance/get":
        return Response.json({ accounts: PLAID_ACCOUNTS, item: { item_id: "item-1", institution_id: "ins_56" } });
      case "/transactions/get":
        if (opts.transactionsError !== undefined) {
          return Response.json({ error_code: opts.transactionsError, error_message: "not ready" }, { status: 400 });
        }
        return Response.json({ transactions: PLAID_TXNS, total_transactions: PLAID_TXNS.length });
      case "/investments/holdings/get":
        return Response.json(PLAID_HOLDINGS);
      default:
        return Response.json({ error_code: "NOT_FOUND", error_message: url.pathname }, { status: 404 });
    }
  });
}

const plaidSecrets = () =>
  memorySecretStore({
    [`${PLAID_SERVICE}/client_id`]: "cid",
    [`${PLAID_SERVICE}/secret`]: "sec",
    [`${PLAID_SERVICE}/access_token:inst.chase`]: "access-token-1",
  });

describe("plaid adapter (mock API)", () => {
  test("maps accounts, flips transaction signs, skips pending and cash holdings", async () => {
    const adapter = plaidAdapter({ institution_id: "inst.chase", base_url: plaidMock(), secrets: plaidSecrets() });
    const out = await adapter.fetch({ now: NOW });
    const byId = new Map(out.snapshot.accounts.map((a) => [a.account_id, a]));

    const checking = byId.get("acct.chase.3gE5gnRzNyfXpxK5ap")!;
    expect(checking.type).toBe("checking");
    expect(checking.masked_number).toBe("••••0000");
    expect(checking.balances).toEqual([
      { balance_type: "total", amount: "110.25" },
      { balance_type: "available", amount: "100.5" },
    ]);
    // Plaid positive = outflow -> ledger negative; pending excluded.
    const tx = checking.transactions ?? [];
    expect(tx.map((t) => t.txn_id).sort()).toEqual(["tx-groceries", "tx-payroll"]);
    expect(tx.find((t) => t.txn_id === "tx-groceries")).toMatchObject({ amount: "-89.4", type: "debit", description: "Grocery Mart" });
    expect(tx.find((t) => t.txn_id === "tx-payroll")).toMatchObject({ amount: "2500", type: "credit" });

    const card = byId.get("acct.chase.creditAcct1")!;
    expect(card.type).toBe("credit_card");
    expect(card.balances).toEqual([
      { balance_type: "owed", amount: "410.75" },
      { balance_type: "credit_limit", amount: "2000" },
    ]);

    const ira = byId.get("acct.chase.investAcct1")!;
    expect(ira.type).toBe("ira");
    expect(ira.positions).toHaveLength(1); // the cash-equivalent holding is not a position
    expect(ira.positions?.[0]).toMatchObject({
      instrument: { symbol: "VTI", asset_class: "etf" },
      quantity: "90.5",
      market_value: "22634.05",
      cost_basis: "18000",
    });

    expect(out.raw[0]?.filename).toBe("plaid-2026-08-24.json");
    const raw = JSON.parse(new TextDecoder().decode(out.raw[0]!.bytes)) as { transactions: unknown[] };
    expect(raw.transactions).toHaveLength(3); // evidence keeps everything, pending included
  });

  test("a fresh item's PRODUCT_NOT_READY on transactions does not lose the balances", async () => {
    const adapter = plaidAdapter({
      institution_id: "inst.chase",
      base_url: plaidMock({ transactionsError: "PRODUCT_NOT_READY" }),
      secrets: plaidSecrets(),
    });
    const out = await adapter.fetch({ now: NOW });
    expect(out.snapshot.accounts).toHaveLength(3);
    expect(out.snapshot.accounts.every((a) => (a.transactions ?? []).length === 0)).toBe(true);
  });

  test("missing credentials and missing connection fail in plain words", async () => {
    const noCreds = plaidAdapter({ institution_id: "inst.chase", base_url: "http://127.0.0.1:9", secrets: memorySecretStore() });
    expect(noCreds.fetch({ now: NOW })).rejects.toThrow(/not connected|connect from the Institutions page/);
    const noToken = plaidAdapter({
      institution_id: "inst.other",
      base_url: "http://127.0.0.1:9",
      secrets: memorySecretStore({ [`${PLAID_SERVICE}/client_id`]: "cid", [`${PLAID_SERVICE}/secret`]: "sec" }),
    });
    expect(noToken.fetch({ now: NOW })).rejects.toThrow(/not connected/);
  });
});

// --- Enable Banking ---------------------------------------------------

const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const PRIVATE_PEM = privateKey.export({ type: "pkcs8", format: "pem" }) as string;

const EB_SESSION = {
  status: "AUTHORIZED",
  accounts: ["uid-checking", "uid-card"],
  aspsp: { name: "Mock ASPSP", country: "FI" },
  access: { valid_until: "2026-12-01T00:00:00.000Z" },
};
const EB_DETAILS: Record<string, unknown> = {
  "uid-checking": {
    account_id: { iban: "FI2112345600000785" }, identification_hash: "hash-checking-1",
    name: "Main account", currency: "EUR", cash_account_type: "CACC",
  },
  "uid-card": {
    account_id: { iban: null }, identification_hash: "hash-card-1",
    name: "Credit card", currency: "EUR", cash_account_type: "CARD",
  },
};
const EB_BALANCES: Record<string, unknown> = {
  "uid-checking": { balances: [
    { name: "Available", balance_amount: { currency: "EUR", amount: "1250.50" }, balance_type: "ITAV" },
    { name: "Booked", balance_amount: { currency: "EUR", amount: "+1300.00" }, balance_type: "CLBD" },
  ] },
  "uid-card": { balances: [
    { name: "Booked", balance_amount: { currency: "EUR", amount: "-321.10" }, balance_type: "CLBD" },
  ] },
};
const EB_TXN_PAGES: Record<string, Array<Record<string, unknown>>> = {
  "uid-checking-page1": [
    { entry_reference: "ref-1", transaction_amount: { currency: "EUR", amount: "45.00" }, credit_debit_indicator: "DBIT", status: "BOOK", booking_date: "2026-08-20", remittance_information: ["CARD PURCHASE", "SUPERMARKET"] },
  ],
  "uid-checking-page2": [
    { entry_reference: "ref-2", transaction_amount: { currency: "EUR", amount: "2100.00" }, credit_debit_indicator: "CRDT", status: "BOOK", booking_date: "2026-08-15", remittance_information: [], debtor: { name: "EMPLOYER OY" } },
    { entry_reference: "ref-pending", transaction_amount: { currency: "EUR", amount: "9.90" }, credit_debit_indicator: "DBIT", status: "PDNG", booking_date: "2026-08-23", remittance_information: ["COFFEE"] },
    { entry_reference: null, transaction_amount: { currency: "EUR", amount: "3.20" }, credit_debit_indicator: "DBIT", status: "BOOK", booking_date: "2026-08-21", value_date: "2026-08-21", remittance_information: ["BANK FEE"] },
  ],
  "uid-card": [],
};

function ebMock(session: typeof EB_SESSION = EB_SESSION): { base: string; seenJwts: string[] } {
  const seenJwts: string[] = [];
  const base = serve((req) => {
    const auth = req.headers.get("authorization") ?? "";
    if (!auth.startsWith("Bearer ")) return new Response("no jwt", { status: 401 });
    seenJwts.push(auth.slice(7));
    const url = new URL(req.url);
    const p = url.pathname;
    if (p === "/sessions/sess-1") return Response.json(session);
    const m = /^\/accounts\/([^/]+)\/(details|balances|transactions)$/.exec(p);
    if (m !== null) {
      const [, uid, what] = m as unknown as [string, string, "details" | "balances" | "transactions"];
      if (what === "details") return Response.json(EB_DETAILS[uid]);
      if (what === "balances") return Response.json(EB_BALANCES[uid]);
      if (uid === "uid-checking") {
        const key = url.searchParams.get("continuation_key");
        if (key === null) return Response.json({ transactions: EB_TXN_PAGES["uid-checking-page1"], continuation_key: "next-1" });
        return Response.json({ transactions: EB_TXN_PAGES["uid-checking-page2"], continuation_key: null });
      }
      return Response.json({ transactions: EB_TXN_PAGES[uid] ?? [], continuation_key: null });
    }
    return new Response("not found", { status: 404 });
  });
  return { base, seenJwts };
}

const ebSecrets = () =>
  memorySecretStore({
    [`${ENABLEBANKING_SERVICE}/app_id`]: "app-123",
    [`${ENABLEBANKING_SERVICE}/private_key`]: PRIVATE_PEM,
    [`${ENABLEBANKING_SERVICE}/session:inst.nordbank`]: "sess-1",
  });

describe("enable banking adapter (mock API)", () => {
  test("signs RS256 JWTs the API can verify, with kid = app id", () => {
    const jwt = enableBankingJwt("app-123", PRIVATE_PEM, NOW);
    const [h, p, sig] = jwt.split(".") as [string, string, string];
    const header = JSON.parse(Buffer.from(h, "base64url").toString()) as { alg: string; kid: string };
    expect(header).toMatchObject({ alg: "RS256", kid: "app-123" });
    const payload = JSON.parse(Buffer.from(p, "base64url").toString()) as { iss: string; aud: string; iat: number; exp: number };
    expect(payload.iss).toBe("enablebanking.com");
    expect(payload.aud).toBe("api.enablebanking.com");
    expect(payload.exp - payload.iat).toBe(3600);
    const ok = crypto.createVerify("RSA-SHA256").update(`${h}.${p}`).verify(publicKey, Buffer.from(sig, "base64url"));
    expect(ok).toBe(true);
  });

  test("maps ISO shapes: balance codes, DBIT/CRDT signs, booked-only, paginated, stable ids", async () => {
    const { base } = ebMock();
    const adapter = enableBankingAdapter({ institution_id: "inst.nordbank", base_url: base, secrets: ebSecrets() });
    const out = await adapter.fetch({ now: NOW });
    const byId = new Map(out.snapshot.accounts.map((a) => [a.account_id, a]));

    const checking = byId.get("acct.nordbank.hash-checking-1")!;
    expect(checking.type).toBe("checking");
    expect(checking.currency).toBe("EUR");
    expect(checking.masked_number).toBe("••••0785");
    expect(checking.balances).toEqual([
      { balance_type: "total", amount: "1300.00" },
      { balance_type: "available", amount: "1250.50" },
    ]);
    const tx = checking.transactions ?? [];
    expect(tx).toHaveLength(3); // both pages, pending excluded, missing-reference txn kept with a stable hash id
    expect(tx.find((t) => t.txn_id === "ref-1")).toMatchObject({ amount: "-45.00", type: "debit", description: "CARD PURCHASE SUPERMARKET" });
    expect(tx.find((t) => t.txn_id === "ref-2")).toMatchObject({ amount: "2100.00", type: "credit", description: "EMPLOYER OY" });
    expect(tx.some((t) => t.txn_id.startsWith("eb-") && t.amount === "-3.20")).toBe(true);

    const card = byId.get("acct.nordbank.hash-card-1")!;
    expect(card.type).toBe("credit_card");
    expect(card.balances).toEqual([{ balance_type: "owed", amount: "321.10" }]);

    expect(out.raw[0]?.filename).toBe("enablebanking-2026-08-24.json");
  });

  test("an expired or revoked consent says so in plain words", async () => {
    const { base } = ebMock({ ...EB_SESSION, access: { valid_until: "2026-08-01T00:00:00.000Z" } });
    const adapter = enableBankingAdapter({ institution_id: "inst.nordbank", base_url: base, secrets: ebSecrets() });
    expect(adapter.fetch({ now: NOW })).rejects.toThrow(/consent has expired.*reconnect from the Institutions page/);
  });

  test("missing credentials fail before any network call", async () => {
    const adapter = enableBankingAdapter({ institution_id: "inst.nordbank", base_url: "http://127.0.0.1:9", secrets: memorySecretStore() });
    expect(adapter.fetch({ now: NOW })).rejects.toThrow(/not connected|connect from the Institutions page/);
  });
});
