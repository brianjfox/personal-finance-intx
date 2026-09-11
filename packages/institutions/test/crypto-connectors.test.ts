// Coinbase + watch-only wallet adapters against local mocks: the CDP
// ES256 JWT (verified with the real public key), pagination, fiat vs
// crypto classification, BigInt sat/wei conversion, and the price
// plumbing. Live behaviour is covered by crypto-connectors-live.test.ts.

import { afterAll, describe, expect, test } from "bun:test";
import crypto from "node:crypto";

import { coinbaseAdapter, coinbaseJwt, COINBASE_SERVICE, memorySecretStore, parseCoinbaseCredential, parseCoinbaseKey, scaleDown, walletAdapter } from "../src";

const NOW = new Date("2026-08-25T12:00:00.000Z");
const servers: Array<{ stop: () => void }> = [];
afterAll(() => servers.forEach((s) => s.stop()));

function serve(handler: (req: Request) => Response | Promise<Response>): string {
  const s = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  servers.push(s);
  return `http://127.0.0.1:${s.port}`;
}

const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
const EC_PEM = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
const KEY_NAME = "organizations/org-1/apiKeys/key-1";

describe("coinbase jwt", () => {
  test("ES256 with kid, iss cdp, a bound uri, and a verifiable raw signature", () => {
    const jwt = coinbaseJwt(KEY_NAME, EC_PEM, "GET", "api.coinbase.com", "/api/v3/brokerage/accounts", NOW);
    const [h, p, sig] = jwt.split(".") as [string, string, string];
    const header = JSON.parse(Buffer.from(h, "base64url").toString()) as { alg: string; kid: string; nonce?: string };
    expect(header.alg).toBe("ES256");
    expect(header.kid).toBe(KEY_NAME);
    expect(header.nonce !== undefined && header.nonce.length > 0).toBe(true);
    const payload = JSON.parse(Buffer.from(p, "base64url").toString()) as { iss: string; sub: string; uri: string; nbf: number; exp: number };
    expect(payload.iss).toBe("cdp");
    expect(payload.sub).toBe(KEY_NAME);
    expect(payload.uri).toBe("GET api.coinbase.com/api/v3/brokerage/accounts");
    expect(payload.exp - payload.nbf).toBe(120);
    const ok = crypto.verify("sha256", Buffer.from(`${h}.${p}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(sig, "base64url"));
    expect(ok).toBe(true);
  });

  test("an Ed25519 key -- the CDP portal's base64 format -- signs EdDSA JWTs the public key verifies", () => {
    const kp = crypto.generateKeyPairSync("ed25519");
    // The downloaded format: base64(seed || raw public key), 64 bytes.
    const seed = Buffer.from(kp.privateKey.export({ format: "jwk" }).d as string, "base64url");
    const pub = Buffer.from(kp.publicKey.export({ format: "jwk" }).x as string, "base64url");
    const portalKey = Buffer.concat([seed, pub]).toString("base64");

    expect(parseCoinbaseKey(portalKey).alg).toBe("EdDSA");
    expect(parseCoinbaseKey(seed.toString("base64")).alg).toBe("EdDSA"); // bare 32-byte seed too
    const jwt = coinbaseJwt(KEY_NAME, portalKey, "GET", "api.coinbase.com", "/api/v3/brokerage/accounts", NOW);
    const [h, p, sig] = jwt.split(".") as [string, string, string];
    const header = JSON.parse(Buffer.from(h, "base64url").toString()) as { alg: string; kid: string };
    expect(header).toMatchObject({ alg: "EdDSA", kid: KEY_NAME });
    expect(crypto.verify(null, Buffer.from(`${h}.${p}`), kp.publicKey, Buffer.from(sig, "base64url"))).toBe(true);

    // Ed25519 PEM (PKCS8) also works.
    const pem = kp.privateKey.export({ type: "pkcs8", format: "pem" }) as string;
    expect(parseCoinbaseKey(pem).alg).toBe("EdDSA");
    // Garbage is refused in plain words.
    expect(() => parseCoinbaseKey("not a key at all !!!")).toThrow(/unrecognized private key/);
  });

  test("the whole downloaded key file can be pasted; its own name wins", () => {
    const file = JSON.stringify({ name: "organizations/o/apiKeys/k", privateKey: "AAAA" });
    expect(parseCoinbaseCredential("typed-name", file)).toEqual({ apiKeyName: "organizations/o/apiKeys/k", privateKey: "AAAA" });
    expect(parseCoinbaseCredential("typed-name", "raw-key")).toEqual({ apiKeyName: "typed-name", privateKey: "raw-key" });
    expect(parseCoinbaseCredential("", file).apiKeyName).toBe("organizations/o/apiKeys/k");
  });
});

describe("coinbase adapter (mock API)", () => {
  const PAGE1 = {
    accounts: [
      { uuid: "u-btc", name: "BTC Wallet", currency: "BTC", available_balance: { value: "0.5", currency: "BTC" }, hold: { value: "0.25", currency: "BTC" } },
      { uuid: "u-usd", name: "Cash (USD)", currency: "USD", available_balance: { value: "1200.50", currency: "USD" }, hold: { value: "0", currency: "USD" } },
      { uuid: "u-zero", name: "Empty", currency: "DOGE", available_balance: { value: "0", currency: "DOGE" }, hold: { value: "0", currency: "DOGE" } },
    ],
    has_next: true,
    cursor: "c2",
  };
  const PAGE2 = {
    accounts: [{ uuid: "u-usdc", name: "USDC", currency: "USDC", available_balance: { value: "300", currency: "USDC" }, hold: { value: "0", currency: "USDC" } }],
    has_next: false,
    cursor: "",
  };
  const SPOT: Record<string, string> = { "BTC-USD": "60000.10", "USDC-USD": "1.00" };

  function mock(): { base: string; jwts: string[] } {
    const jwts: string[] = [];
    const base = serve((req) => {
      const url = new URL(req.url);
      if (url.pathname.startsWith("/v2/prices/")) {
        const pair = url.pathname.split("/")[3] as string;
        const amount = SPOT[decodeURIComponent(pair)];
        return amount !== undefined ? Response.json({ data: { amount, currency: "USD" } }) : new Response("not found", { status: 404 });
      }
      const auth = req.headers.get("authorization") ?? "";
      if (!auth.startsWith("Bearer ")) return new Response("unauthorized", { status: 401 });
      const jwt = auth.slice(7);
      jwts.push(jwt);
      const [h, p, sig] = jwt.split(".") as [string, string, string];
      const ok = crypto.verify("sha256", Buffer.from(`${h}.${p}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(sig, "base64url"));
      if (!ok) return new Response("bad signature", { status: 401 });
      if (url.pathname === "/api/v3/brokerage/accounts") {
        return Response.json(url.searchParams.get("cursor") === "c2" ? PAGE2 : PAGE1);
      }
      // v2 history (issue #53): BTC has two pages -- newest first, as Coinbase serves them.
      if (url.pathname === "/v2/accounts/u-btc/transactions") {
        if (url.searchParams.get("starting_after") === "s1") {
          return Response.json({
            pagination: { next_uri: null },
            data: [
              { id: "d1", type: "exchange_deposit", status: "completed", created_at: "2023-11-03T00:00:00Z", amount: { amount: "0.5", currency: "BTC" }, native_amount: { amount: "17000", currency: "USD" } },
            ],
          });
        }
        return Response.json({
          pagination: { next_uri: "/v2/accounts/u-btc/transactions?limit=100&starting_after=s1" },
          data: [
            { id: "s1", type: "advanced_trade_fill", status: "completed", created_at: "2025-06-01T00:00:00Z", amount: { amount: "-0.75", currency: "BTC" }, native_amount: { amount: "-75000", currency: "USD" }, advanced_trade_fill: { commission: "75", product_id: "BTC-USD", order_side: "sell" } },
            { id: "b1", type: "advanced_trade_fill", status: "completed", created_at: "2024-01-11T00:00:00Z", amount: { amount: "1", currency: "BTC" }, native_amount: { amount: "40000", currency: "USD" }, advanced_trade_fill: { commission: "40", product_id: "BTC-USD", order_side: "buy" } },
          ],
        });
      }
      // Movements in the window (issue #95). The USD wallet's page has a
      // row older than the window and a next_uri: a 30-day walk must stop
      // at the window's edge and not follow it (the JWT count says so).
      if (url.pathname === "/v2/accounts/u-usd/transactions") {
        // Only a walk whose window reaches past January should ask for this page.
        if (url.searchParams.get("starting_after") === "old") return Response.json({ pagination: { next_uri: null }, data: [] });
        return Response.json({
          pagination: { next_uri: "/v2/accounts/u-usd/transactions?limit=100&starting_after=old" },
          data: [
            { id: "fd1", type: "fiat_deposit", status: "completed", created_at: "2026-08-10T09:00:00Z", amount: { amount: "1000.00", currency: "USD" }, native_amount: { amount: "1000.00", currency: "USD" }, details: { title: "Deposited USD", subtitle: "From Chase ••••1234" } },
            { id: "fw0", type: "fiat_withdrawal", status: "completed", created_at: "2026-01-01T00:00:00Z", amount: { amount: "-50.00", currency: "USD" }, native_amount: { amount: "-50.00", currency: "USD" } },
          ],
        });
      }
      // A sold-out wallet (zero balance now) still reports the window's movement.
      if (url.pathname === "/v2/accounts/u-zero/transactions") {
        return Response.json({
          pagination: { next_uri: null },
          data: [
            { id: "dg1", type: "send", status: "completed", created_at: "2026-08-15T12:00:00Z", amount: { amount: "-100", currency: "DOGE" }, native_amount: { amount: "-10.00", currency: "USD" }, details: { title: "Sent Dogecoin", subtitle: "To DOGE address" } },
            { id: "dg0", type: "send", status: "pending", created_at: "2026-08-16T12:00:00Z", amount: { amount: "-1", currency: "DOGE" }, native_amount: { amount: "-0.10", currency: "USD" } },
          ],
        });
      }
      if (url.pathname.startsWith("/v2/accounts/")) return Response.json({ pagination: { next_uri: null }, data: [] });
      return new Response("not found", { status: 404 });
    });
    return { base, jwts };
  }

  const secrets = () =>
    memorySecretStore({
      [`${COINBASE_SERVICE}/api_key_name:inst.coinbase`]: KEY_NAME,
      [`${COINBASE_SERVICE}/private_key:inst.coinbase`]: EC_PEM,
    });

  test("paginates, verifies signed JWTs, folds USD to cash, prices crypto, drops zero balances", async () => {
    const { base, jwts } = mock();
    const adapter = coinbaseAdapter({ institution_id: "inst.coinbase", base_url: base, secrets: secrets() });
    const out = await adapter.fetch({ now: NOW });
    // Two account pages + BTC's two lot-walk pages + one windowed page each
    // for USD, DOGE (sold out), and USDC (stablecoin: movements, no lots);
    // the USD wallet's next_uri past the window is NOT followed.
    expect(jwts.length).toBe(7);
    // Lots (issue #53): oldest first, the Pro-migration deposit (unknown basis) is consumed by the sell
    // before the bought lot; 0.75 of the bought lot remains at its unit cost (40,040) -> 30,030.
    const btc = out.snapshot.accounts[0]!.positions!.find((p) => p.instrument.symbol === "BTC")!;
    expect(btc.lots).toEqual([{ lot_id: "cb:b1", quantity: "0.75", acquired_at: "2024-01-11", cost_basis: "30030.00", transferred_in: false }]);
    expect(btc.cost_basis).toBe("30030");
    const rawNotes = (JSON.parse(new TextDecoder().decode(out.raw[0]!.bytes)) as { lots: Record<string, { pages: number; net: string; withheld?: string }> }).lots;
    expect(rawNotes["BTC"]).toMatchObject({ pages: 2, net: "0.75" });
    expect(rawNotes["BTC"]!.withheld).toBeUndefined();
    expect(rawNotes["USDC"]).toBeUndefined();
    const acct = out.snapshot.accounts[0]!;
    expect(acct.account_id).toBe("acct.coinbase.coinbase");
    expect(acct.type).toBe("crypto");
    expect(acct.txn_ids_authoritative).toBe(true); // issue #123
    const pos = new Map((acct.positions ?? []).map((p) => [p.instrument.symbol, p]));
    expect([...pos.keys()].sort()).toEqual(["BTC", "USDC"]); // DOGE zero dropped, USD is cash
    expect(pos.get("BTC")).toMatchObject({ quantity: "0.75", price: "60000.10", market_value: "45000.08", cost_basis: "30030" }); // the sum of the remaining lots' bases
    expect(pos.get("BTC")?.instrument.asset_class).toBe("crypto");
    expect(pos.get("USDC")?.instrument.asset_class).toBe("crypto");
    const bal = new Map(acct.balances.map((b) => [b.balance_type, b.amount]));
    expect(bal.get("cash")).toBe("1200.5");
    expect(bal.get("total")).toBe("46500.58"); // 45000.08 + 300 + 1200.50
    expect(out.raw[0]?.filename).toBe("coinbase-2026-08-25.json");

    // Transactions (issue #95): the window's rows only, completed only,
    // Coinbase's own USD value and wording, positive = into the account.
    expect(acct.transactions).toEqual([
      { txn_id: "fd1", posted_at: "2026-08-10T09:00:00.000Z", amount: "1000.00", type: "transfer_in", description: "Deposited USD — From Chase ••••1234", instrument: null, quantity: null, raw_category: "fiat_deposit" },
      { txn_id: "dg1", posted_at: "2026-08-15T12:00:00.000Z", amount: "-10", type: "transfer_out", description: "Sent Dogecoin — To DOGE address", instrument: { symbol: "DOGE", name: "DOGE", asset_class: "crypto" }, quantity: "-100", raw_category: "send" },
    ]);
    const txNotes = (JSON.parse(new TextDecoder().decode(out.raw[0]!.bytes)) as { transactions: { window_days: number; by_currency: Record<string, { rows: number; unvalued: number }> } }).transactions;
    expect(txNotes.window_days).toBe(30);
    expect(txNotes.by_currency["USD"]).toEqual({ rows: 1, unvalued: 0 });
    expect(txNotes.by_currency["DOGE"]).toEqual({ rows: 1, unvalued: 0 });
  });

  test("the host's widened window reaches further back; transactions can be switched off", async () => {
    const { base } = mock();
    const wide = await coinbaseAdapter({ institution_id: "inst.coinbase", base_url: base, secrets: secrets() }).fetch({ now: NOW, lookback_days: 365 });
    // Inside a year: the January withdrawal joins; BTC's 2024/2025 fills stay out (older than the window).
    expect(wide.snapshot.accounts[0]!.transactions!.map((t) => t.txn_id)).toEqual(["fw0", "fd1", "dg1"]);
    const off = await coinbaseAdapter({ institution_id: "inst.coinbase", base_url: base, secrets: secrets(), transactions: false }).fetch({ now: NOW });
    expect(off.snapshot.accounts[0]!.transactions).toBeUndefined();
  });

  test("missing key fails in plain words", async () => {
    const adapter = coinbaseAdapter({ institution_id: "inst.coinbase", base_url: "http://127.0.0.1:9", secrets: memorySecretStore() });
    expect(adapter.fetch({ now: NOW })).rejects.toThrow(/not connected.*Coinbase API key/);
  });
});

describe("watch-only wallet adapter (mock chain APIs)", () => {
  test("scaleDown is exact BigInt math", () => {
    expect(scaleDown(123456789n, 8)).toBe("1.23456789");
    expect(scaleDown(50000000n, 8)).toBe("0.5");
    expect(scaleDown(1000000000000000000n, 18)).toBe("1");
    expect(scaleDown(1234500000000000000n, 18)).toBe("1.2345");
    expect(scaleDown(1n, 18)).toBe("0.000000000000000001");
    expect(scaleDown(0n, 8)).toBe("0");
  });

  test("sums addresses + legacy xpub + eth, prices via spot, all decimal-exact", async () => {
    const base = serve(async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/btc/address/bc1qaddr1") {
        return Response.json({ chain_stats: { funded_txo_sum: 160000000, spent_txo_sum: 10000000 } }); // 1.5 BTC
      }
      // Confirmed history, newest first (issue #95): a receive, a send with
      // change back to us (net = spent - change, fee included), a pending row.
      if (url.pathname === "/btc/address/bc1qaddr1/txs") {
        return Response.json([
          { txid: "txC", status: { confirmed: false }, vin: [], vout: [{ scriptpubkey_address: "bc1qaddr1", value: 1 }] },
          { txid: "txA", status: { confirmed: true, block_time: Date.parse("2026-08-22T10:00:00Z") / 1000 }, vin: [{ prevout: { scriptpubkey_address: "bc1qother", value: 20000000 } }], vout: [{ scriptpubkey_address: "bc1qaddr1", value: 10000000 }, { scriptpubkey_address: "bc1qother", value: 9990000 }] },
          { txid: "txB", status: { confirmed: true, block_time: Date.parse("2026-08-20T10:00:00Z") / 1000 }, vin: [{ prevout: { scriptpubkey_address: "bc1qaddr1", value: 5000000 } }], vout: [{ scriptpubkey_address: "bc1qpayee", value: 2900000 }, { scriptpubkey_address: "bc1qaddr1", value: 2000000 }] },
        ]);
      }
      if (url.pathname === "/btc/address/bc1qaddr1/txs/chain/txB") return Response.json([]);
      if (url.pathname === "/multiaddr") {
        expect(url.searchParams.get("active")).toBe("xpub6TESTLEGACY");
        expect(url.searchParams.get("n")).toBe("50");
        return Response.json({
          wallet: { final_balance: 25000000 }, // 0.25 BTC
          txs: [
            { hash: "x1", time: Date.parse("2026-08-18T08:00:00Z") / 1000, result: 5000000, block_height: 900000 },
            { hash: "x0", time: Date.parse("2025-08-18T08:00:00Z") / 1000, result: 20000000, block_height: 850000 }, // outside the window
          ],
        });
      }
      if (url.pathname === "/rpc" && req.method === "POST") {
        const b = (await req.json()) as { method: string; params: [string, string] };
        expect(b.method).toBe("eth_getBalance");
        expect(b.params[0]).toBe("0xabc0000000000000000000000000000000000001");
        return Response.json({ jsonrpc: "2.0", id: 1, result: "0x1bc16d674ec80000" }); // 2 ETH
      }
      if (url.pathname === "/v2/prices/BTC-USD/spot") return Response.json({ data: { amount: "60000" } });
      if (url.pathname === "/v2/prices/ETH-USD/spot") return Response.json({ data: { amount: "2500.50" } });
      return new Response(`not found: ${url.pathname}`, { status: 404 });
    });
    const adapter = walletAdapter({
      institution_id: "inst.ledger",
      holdings: [
        { kind: "btc_address", value: "bc1qaddr1", label: "Ledger BTC" },
        { kind: "btc_xpub", value: "xpub6TESTLEGACY" },
        { kind: "eth_address", value: "0xabc0000000000000000000000000000000000001" },
      ],
      btc_api: `${base}/btc`,
      btc_xpub_api: base,
      eth_rpc: `${base}/rpc`,
      price_api: base,
    });
    const out = await adapter.fetch({ now: NOW });
    const acct = out.snapshot.accounts[0]!;
    expect(acct.account_id).toBe("acct.ledger.wallet");
    expect(acct.txn_ids_authoritative).toBe(true); // issue #123
    const pos = new Map((acct.positions ?? []).map((p) => [p.instrument.symbol, p]));
    expect(pos.get("BTC")).toMatchObject({ quantity: "1.75", price: "60000", market_value: "105000.00" });
    expect(pos.get("ETH")).toMatchObject({ quantity: "2", price: "2500.50", market_value: "5001.00" });
    expect(acct.balances).toEqual([{ balance_type: "total", amount: "110001" }]);
    expect(out.raw[0]?.filename).toBe("wallet-2026-08-25.json");

    // Movements (issue #95): confirmed on-chain rows in the window, valued
    // at the day's spot, oldest first; the pending row and last year's
    // xpub row are left out; ETH carries none and the raw notes say why.
    expect(acct.transactions).toEqual([
      { txn_id: "x1", posted_at: "2026-08-18T08:00:00.000Z", amount: "3000.00", type: "transfer_in", description: "Received 0.05 BTC on-chain · valued at the day's spot", instrument: { symbol: "BTC", name: "Bitcoin", asset_class: "crypto" }, quantity: "0.05", raw_category: "receive" },
      { txn_id: "txB", posted_at: "2026-08-20T10:00:00.000Z", amount: "-1800", type: "transfer_out", description: "Sent 0.03 BTC on-chain (fee included) · valued at the day's spot", instrument: { symbol: "BTC", name: "Bitcoin", asset_class: "crypto" }, quantity: "-0.03", raw_category: "send" },
      { txn_id: "txA", posted_at: "2026-08-22T10:00:00.000Z", amount: "6000.00", type: "transfer_in", description: "Received 0.1 BTC on-chain · valued at the day's spot", instrument: { symbol: "BTC", name: "Bitcoin", asset_class: "crypto" }, quantity: "0.1", raw_category: "receive" },
    ]);
    const notes = (JSON.parse(new TextDecoder().decode(out.raw[0]!.bytes)) as { transactions: { BTC: { rows: number; unvalued: number }; unsupported: string[] } }).transactions;
    expect(notes.BTC).toEqual({ rows: 3, unvalued: 0 });
    expect(notes.unsupported).toEqual(["eth_address: balances only -- history needs an indexer"]);
  });

  test("a dead chain API is a plain-words fetch failure, not a wrong zero", async () => {
    const adapter = walletAdapter({
      institution_id: "inst.ledger",
      holdings: [{ kind: "btc_address", value: "bc1qaddr1" }],
      btc_api: "http://127.0.0.1:9/btc",
      price_api: "http://127.0.0.1:9",
    });
    expect(adapter.fetch({ now: NOW })).rejects.toThrow();
  });
});

describe("wallet address detection", () => {
  const { detectWalletHolding } = require("../src/wallet-detect") as typeof import("../src/wallet-detect");
  const ok = (v: string) => {
    const d = detectWalletHolding(v);
    if (!d.ok) throw new Error(`expected ok for ${v}: ${d.reason}`);
    return d;
  };
  const bad = (v: string) => {
    const d = detectWalletHolding(v);
    if (d.ok) throw new Error(`expected refusal for ${v}, got ${d.kind}`);
    return d.reason;
  };

  test("the majors are recognized from syntax alone", () => {
    expect(ok("bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq")).toMatchObject({ kind: "btc_address", chain: "Bitcoin" });
    expect(ok("bc1p5d7rjq7g6rdk2yhzks9smlaqtedr4dekq08ge8ztwac72sfr9rusxg3297").kind).toBe("btc_address"); // taproot
    expect(ok("1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa")).toMatchObject({ kind: "btc_address", chain: "Bitcoin" }); // genesis
    expect(ok("3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy").kind).toBe("btc_address");
    expect(ok("xpub6CUGRUonZSQ4TWtTMmzXdrXDtypWKiKrhko4egpiMZbpiaQL2jkwSB1icqYh2cfDfVxdx4df189oLKnC5fSwqPfgyP3hooxujYzAu3fDVmz")).toMatchObject({ kind: "btc_xpub" });
    expect(ok("LhK2kQwiaAvhjWY799cZvMyYwnQAcxkarr")).toMatchObject({ kind: "ltc_address", chain: "Litecoin" });
    expect(ok("ltc1qhta4z5m9zzz9d2h6nruvhg50a0kcw6kj5wmydt").kind).toBe("ltc_address");
    expect(ok("0x00000000219ab540356cBB839Cbe05303d7705Fa")).toMatchObject({ kind: "eth_address", chain: "Ethereum" });
    expect(ok("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM")).toMatchObject({ kind: "sol_address", chain: "Solana" });
  });

  test("recognized-but-unsupported chains refuse by name; nothing is guessed", () => {
    expect(bad("zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs")).toMatch(/segwit extended key/);
    expect(bad("DH5yaieqoZN36fDVciNyRueRGvGLR3mr7L")).toMatch(/Dogecoin/);
    expect(bad("rN7n7otQDd6FczFgLdSqtcsAUxDkw6fzRH")).toMatch(/XRP/);
    expect(bad("TJRabPrwbZy45sbavfcjinPJC18kjpRTv8")).toMatch(/Tron/);
    expect(bad("cosmos1vlthgax23ca9syk7xgaz347xmf4nunefw3cnf8")).toMatch(/Cosmos/);
    expect(bad("addr1qxck8m5jkzqdlrt5xhaxcyjkxxlk28dsyz7wsjk3nxrxk4t7qxpks8m5jkzqdlrt5xhaxcyjkxxlk28dsy")).toMatch(/Cardano/);
    expect(bad("bitcoincash:qzm47qz5ue99y9yl4aca7jnz7dwgdenl85jkfx3znl")).toMatch(/Bitcoin Cash/);
    expect(bad("tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx")).toMatch(/testnet/);
    expect(bad("0x1234")).toMatch(/40 hex/);
    expect(bad("hello world")).toMatch(/couldn't recognize/);
  });
});

describe("ledger live account JSON detection", () => {
  const { detectWalletHolding } = require("../src/wallet-detect") as typeof import("../src/wallet-detect");

  test("an Ethereum account object collapses to its 0x address (the operator's exact shape)", () => {
    const pasted = JSON.stringify({
      xpub: "0x1dBAD5E4a7e29D122a9Ec7a3728688b1C953fe28",
      index: 0,
      freshAddressPath: "44'/60'/0'/0/0",
      id: "js:2:ethereum:0x1dBAD5E4a7e29D122a9Ec7a3728688b1C953fe28:",
      blockHeight: 25830921,
    });
    const d = detectWalletHolding(pasted);
    expect(d).toMatchObject({ ok: true, kind: "eth_address", chain: "Ethereum", value: "0x1dBAD5E4a7e29D122a9Ec7a3728688b1C953fe28" });
  });

  test("bitcoin legacy uses the xpub; segwit schemes refuse with the scheme named; other chains refuse by name", () => {
    const xpub = "xpub6CUGRUonZSQ4TWtTMmzXdrXDtypWKiKrhko4egpiMZbpiaQL2jkwSB1icqYh2cfDfVxdx4df189oLKnC5fSwqPfgyP3hooxujYzAu3fDVmz";
    const legacy = detectWalletHolding(JSON.stringify({ id: `js:2:bitcoin:${xpub}:`, xpub, name: "BTC vault" }));
    expect(legacy).toMatchObject({ ok: true, kind: "btc_xpub", value: xpub, label: "BTC vault" });

    const segwit = detectWalletHolding(JSON.stringify({ id: `js:2:bitcoin:${xpub}:native_segwit`, xpub }));
    expect(segwit.ok).toBe(false);
    if (!segwit.ok) expect(segwit.reason).toMatch(/native segwit/);

    const sol = detectWalletHolding(JSON.stringify({ id: "js:2:solana:9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM:", freshAddress: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM" }));
    expect(sol).toMatchObject({ ok: true, kind: "sol_address", value: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM" });

    const doge = detectWalletHolding(JSON.stringify({ id: "js:2:dogecoin:DH5yaieqoZN36fDVciNyRueRGvGLR3mr7L:", xpub: "DH5yaieqoZN36fDVciNyRueRGvGLR3mr7L" }));
    expect(doge.ok).toBe(false);
    if (!doge.ok) expect(doge.reason).toMatch(/dogecoin/);

    const fullExport = detectWalletHolding(JSON.stringify({ data: { accounts: [{}, {}] } }));
    expect(fullExport.ok).toBe(false);
    if (!fullExport.ok) expect(fullExport.reason).toMatch(/one account object/);

    const broken = detectWalletHolding("{not json");
    expect(broken.ok).toBe(false);
    if (!broken.ok) expect(broken.reason).toMatch(/doesn't parse/);
  });
});

describe("ledger live JSON shape variants (the id layout is not fixed)", () => {
  const { detectWalletHolding } = require("../src/wallet-detect") as typeof import("../src/wallet-detect");
  const ADDR = "0x616F941BE4bB19Ec11DdE7a12f120000000AbCd1";

  test("id without a trailing colon still names the chain", () => {
    const d = detectWalletHolding(JSON.stringify({ xpub: ADDR, id: `js:2:ethereum:${ADDR}`, freshAddressPath: "44'/60'/0'/1" }));
    expect(d).toMatchObject({ ok: true, kind: "eth_address", value: ADDR });
  });

  test("no id at all: the derivation path's SLIP-44 coin type is the chain", () => {
    const d = detectWalletHolding(JSON.stringify({ xpub: ADDR, freshAddressPath: "44'/60'/0'/0/0" }));
    expect(d).toMatchObject({ ok: true, kind: "eth_address", chain: "Ethereum", value: ADDR });
  });

  test("a bitcoin 84' path names the native segwit scheme even without an id", () => {
    const xpub = "xpub6CUGRUonZSQ4TWtTMmzXdrXDtypWKiKrhko4egpiMZbpiaQL2jkwSB1icqYh2cfDfVxdx4df189oLKnC5fSwqPfgyP3hooxujYzAu3fDVmz";
    const d = detectWalletHolding(JSON.stringify({ xpub, freshAddressPath: "84'/0'/0'/0/0" }));
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.reason).toMatch(/native segwit/);
  });

  test("neither id nor path: the error tells the truth about what was missing", () => {
    const d = detectWalletHolding(JSON.stringify({ xpub: ADDR, index: 0 }));
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.reason).toMatch(/neither a js:… "id" nor a derivation path/);
  });
});

describe("kraken adapter (mock API)", () => {
  const { krakenAdapter, krakenSign, normalizeKrakenAsset, KRAKEN_SERVICE } = require("../src/kraken") as typeof import("../src/kraken");
  const SECRET = crypto.randomBytes(64).toString("base64");

  test("legacy codes and earn suffixes normalize onto plain symbols", () => {
    expect(normalizeKrakenAsset("XXBT")).toBe("BTC");
    expect(normalizeKrakenAsset("XBT.M")).toBe("BTC");
    expect(normalizeKrakenAsset("SOL.S")).toBe("SOL");
    expect(normalizeKrakenAsset("ZUSD")).toBe("USD");
    expect(normalizeKrakenAsset("ETH2.S")).toBe("ETH");
    expect(normalizeKrakenAsset("ADA")).toBe("ADA");
  });

  test("signs requests the server can verify; aggregates variants; USD is cash; API errors are plain words", async () => {
    const seenNonces: string[] = [];
    const base = serve(async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/v2/prices/BTC-USD/spot") return Response.json({ data: { amount: "60000" } });
      if (url.pathname === "/v2/prices/SOL-USD/spot") return Response.json({ data: { amount: "200" } });
      if (url.pathname === "/v2/prices/EUR-USD/spot") return Response.json({ data: { amount: "1.10" } });
      if (url.pathname === "/0/private/Ledgers" && req.method === "POST") {
        const postData = await req.text();
        const nonce = new URLSearchParams(postData).get("nonce") ?? "";
        if (req.headers.get("API-Sign") !== krakenSign("/0/private/Ledgers", nonce, postData, SECRET)) return Response.json({ error: ["EAPI:Invalid signature"] });
        const t = (iso: string): number => Date.parse(iso) / 1000;
        // Sibling entries share a refid; fees are in the entry's own asset.
        const ledger = {
          L8: { refid: "D0", time: t("2025-01-01T00:00:00Z"), type: "deposit", subtype: "", asset: "ZUSD", amount: "100000.00", fee: "0" },
          L1: { refid: "T1", time: t("2026-08-01T09:00:00Z"), type: "trade", subtype: "", asset: "ZUSD", amount: "-30000.00", fee: "30.00" },
          L2: { refid: "T1", time: t("2026-08-01T09:00:00Z"), type: "trade", subtype: "", asset: "XXBT", amount: "0.5", fee: "0" },
          L3: { refid: "D1", time: t("2026-08-10T09:00:00Z"), type: "deposit", subtype: "", asset: "XXBT", amount: "0.25", fee: "0" },
          L4: { refid: "W1", time: t("2026-08-12T09:00:00Z"), type: "withdrawal", subtype: "", asset: "ZUSD", amount: "-500.00", fee: "0" },
          L5: { refid: "S1", time: t("2026-08-15T09:00:00Z"), type: "staking", subtype: "", asset: "SOL.S", amount: "0.1", fee: "0" },
          L6: { refid: "I1", time: t("2026-08-16T09:00:00Z"), type: "transfer", subtype: "spottostaking", asset: "SOL", amount: "-10", fee: "0" },
          L7: { refid: "I1", time: t("2026-08-16T09:00:00Z"), type: "transfer", subtype: "stakingfromspot", asset: "SOL.S", amount: "10", fee: "0" },
        };
        return Response.json({ error: [], result: { count: Object.keys(ledger).length, ledger } });
      }
      if (url.pathname === "/0/private/Balance" && req.method === "POST") {
        const postData = await req.text();
        const nonce = new URLSearchParams(postData).get("nonce") ?? "";
        seenNonces.push(nonce);
        const expected = krakenSign("/0/private/Balance", nonce, postData, SECRET);
        if (req.headers.get("API-Key") !== "key-1" || req.headers.get("API-Sign") !== expected) {
          return Response.json({ error: ["EAPI:Invalid signature"] });
        }
        return Response.json({
          error: [],
          result: { ZUSD: "1200.50", XXBT: "0.5", "XBT.M": "0.25", "SOL.S": "10", ZEUR: "100", DUST: "0" },
        });
      }
      return new Response("not found", { status: 404 });
    });
    const secrets = memorySecretStore({
      [`${KRAKEN_SERVICE}/api_key:inst.kraken`]: "key-1",
      [`${KRAKEN_SERVICE}/private_key:inst.kraken`]: SECRET,
    });
    const adapter = krakenAdapter({ institution_id: "inst.kraken", base_url: base, price_api: base, secrets, page_pause_ms: 0 });
    const out = await adapter.fetch({ now: NOW });
    expect(seenNonces).toHaveLength(1);
    const acct = out.snapshot.accounts[0]!;
    expect(acct.account_id).toBe("acct.kraken.kraken");
    expect(acct.txn_ids_authoritative).toBe(true); // issue #123
    const pos = new Map((acct.positions ?? []).map((p) => [p.instrument.symbol, p]));
    expect([...pos.keys()].sort()).toEqual(["BTC", "EUR", "SOL"]); // DUST zero dropped, USD is cash
    expect(pos.get("BTC")).toMatchObject({ quantity: "0.75", market_value: "45000.00" }); // spot + earn summed
    expect(pos.get("EUR")?.instrument.asset_class).toBe("cash");
    const bal = new Map(acct.balances.map((b) => [b.balance_type, b.amount]));
    expect(bal.get("cash")).toBe("1200.5");
    expect(bal.get("total")).toBe("48310.5"); // 45000 + 2000 + 110 + 1200.50
    expect(out.raw[0]?.filename).toBe("kraken-2026-08-25.json");

    // Lots (issue #64) from the same ledger: the fiat-funded trade (30,000 +
    // 30 fee) and the transferred-in deposit net to the 0.75 BTC held.
    expect(pos.get("BTC")?.lots).toEqual([
      { lot_id: "kr:L2", quantity: "0.5", acquired_at: "2026-08-01", cost_basis: "30030.00", transferred_in: false },
      { lot_id: "kr:L3", quantity: "0.25", acquired_at: "2026-08-10", cost_basis: null, transferred_in: true },
    ]);

    // Transactions (issue #95): one movement per refid inside the window;
    // last year's deposit and the internal spot<->staking shuffle are out;
    // crypto legs valued at the day's spot, the fiat leg by itself.
    expect(acct.transactions).toEqual([
      { txn_id: "T1", posted_at: "2026-08-01T09:00:00.000Z", amount: "30030", type: "buy", description: "Bought 0.5 BTC for USD", instrument: { symbol: "BTC", name: "BTC", asset_class: "crypto" }, quantity: "0.5", raw_category: "trade" },
      { txn_id: "T1:fiat", posted_at: "2026-08-01T09:00:00.000Z", amount: "-30030", type: "buy", description: "Paid for 0.5 BTC", instrument: null, quantity: null, raw_category: "trade" },
      { txn_id: "L3", posted_at: "2026-08-10T09:00:00.000Z", amount: "15000.00", type: "transfer_in", description: "Deposit 0.25 BTC · valued at the day's spot", instrument: { symbol: "BTC", name: "BTC", asset_class: "crypto" }, quantity: "0.25", raw_category: "deposit" },
      { txn_id: "L4", posted_at: "2026-08-12T09:00:00.000Z", amount: "-500", type: "transfer_out", description: "Withdrawal 500 USD", instrument: null, quantity: null, raw_category: "withdrawal" },
      { txn_id: "L5", posted_at: "2026-08-15T09:00:00.000Z", amount: "20.00", type: "income", description: "Staking reward 0.1 SOL · valued at the day's spot", instrument: { symbol: "SOL", name: "SOL", asset_class: "crypto" }, quantity: "0.1", raw_category: "staking" },
    ]);
    const notes = JSON.parse(new TextDecoder().decode(out.raw[0]!.bytes)) as { transactions: { window_days: number; rows: number; unvalued: number } };
    expect(notes.transactions).toMatchObject({ window_days: 30, rows: 5, unvalued: 0 });

    // A refused key surfaces Kraken's own error, in plain words.
    const badSecrets = memorySecretStore({
      [`${KRAKEN_SERVICE}/api_key:inst.kraken`]: "wrong",
      [`${KRAKEN_SERVICE}/private_key:inst.kraken`]: SECRET,
    });
    const bad = krakenAdapter({ institution_id: "inst.kraken", base_url: base, price_api: base, secrets: badSecrets });
    expect(bad.fetch({ now: NOW })).rejects.toThrow(/EAPI:Invalid signature/);
  });

  test("missing key fails in plain words", async () => {
    const adapter = krakenAdapter({ institution_id: "inst.kraken", base_url: "http://127.0.0.1:9", secrets: memorySecretStore() });
    expect(adapter.fetch({ now: NOW })).rejects.toThrow(/not connected.*Kraken API key/);
  });
});

describe("crypto flows mapping (issue #95)", () => {
  const { coinbaseTransactions, krakenTransactions } = require("../src/crypto-flows") as typeof import("../src/crypto-flows");
  const SINCE = "2026-07-26T12:00:00.000Z";

  test("coinbase: convert is a swap leg, payouts are income, an unvalued row is counted not guessed", () => {
    const f = coinbaseTransactions(
      [
        { id: "c1", type: "trade", status: "completed", created_at: "2026-08-01T00:00:00Z", amount: { amount: "1.5", currency: "ETH" }, native_amount: { amount: "4500", currency: "USD" } },
        { id: "c2", type: "staking_reward", status: "completed", created_at: "2026-08-02T00:00:00Z", amount: { amount: "0.01", currency: "ETH" }, native_amount: { amount: "30", currency: "USD" } },
        { id: "c3", type: "send", status: "completed", created_at: "2026-08-03T00:00:00Z", amount: { amount: "-0.5", currency: "ETH" }, native_amount: null },
        { id: "c4", type: "advanced_trade_fill", status: "completed", created_at: "2026-08-04T00:00:00Z", amount: { amount: "-1", currency: "ETH" }, native_amount: { amount: "-3000", currency: "USD" } },
      ],
      "ETH",
      SINCE,
    );
    expect(f.unvalued).toBe(1);
    expect(f.rows.map((r) => [r.txn_id, r.type, r.amount, r.quantity])).toEqual([
      ["c1", "swap", "4500", "1.5"],
      ["c2", "income", "30", "0.01"],
      ["c4", "sell", "-3000", "-1"],
    ]);
  });

  test("kraken: a crypto-to-crypto trade is one swap; a leg with no price is counted, not guessed", async () => {
    const t = Date.parse("2026-08-05T00:00:00Z") / 1000;
    const priceAt = async (sym: string) => (sym === "ETH" ? "3000" : null);
    const f = await krakenTransactions(
      [
        { id: "a", refid: "X1", time: t, type: "trade", asset: "DOT", amount: "-100", fee: "0" },
        { id: "b", refid: "X1", time: t, type: "trade", asset: "XETH", amount: "0.2", fee: "0.001" },
        { id: "c", refid: "D9", time: t + 60, type: "deposit", asset: "ADA", amount: "500", fee: "0" },
      ],
      (code) => (code === "XETH" ? "ETH" : code),
      SINCE,
      priceAt,
    );
    expect(f.unvalued).toBe(1); // ADA: no price
    expect(f.rows).toEqual([
      {
        txn_id: "X1",
        posted_at: "2026-08-05T00:00:00.000Z",
        amount: "597.00",
        type: "swap",
        description: "Swapped 100 DOT for 0.199 ETH · valued at the day's spot",
        instrument: { symbol: "ETH", name: "ETH", asset_class: "crypto" },
        quantity: "0.199",
        raw_category: "trade",
        swap_from: { instrument: { symbol: "DOT", name: "DOT", asset_class: "crypto" }, quantity: "100" },
      },
    ]);
  });
});
