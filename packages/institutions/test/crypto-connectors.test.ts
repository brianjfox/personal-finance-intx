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
    expect(jwts.length).toBe(2); // one per page, each signature verified by the mock
    const acct = out.snapshot.accounts[0]!;
    expect(acct.account_id).toBe("acct.coinbase.coinbase");
    expect(acct.type).toBe("crypto");
    const pos = new Map((acct.positions ?? []).map((p) => [p.instrument.symbol, p]));
    expect([...pos.keys()].sort()).toEqual(["BTC", "USDC"]); // DOGE zero dropped, USD is cash
    expect(pos.get("BTC")).toMatchObject({ quantity: "0.75", price: "60000.10", market_value: "45000.08", cost_basis: null });
    expect(pos.get("BTC")?.instrument.asset_class).toBe("crypto");
    expect(pos.get("USDC")?.instrument.asset_class).toBe("crypto");
    const bal = new Map(acct.balances.map((b) => [b.balance_type, b.amount]));
    expect(bal.get("cash")).toBe("1200.5");
    expect(bal.get("total")).toBe("46500.58"); // 45000.08 + 300 + 1200.50
    expect(out.raw[0]?.filename).toBe("coinbase-2026-08-25.json");
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
      if (url.pathname === "/multiaddr") {
        expect(url.searchParams.get("active")).toBe("xpub6TESTLEGACY");
        return Response.json({ wallet: { final_balance: 25000000 } }); // 0.25 BTC
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
    const pos = new Map((acct.positions ?? []).map((p) => [p.instrument.symbol, p]));
    expect(pos.get("BTC")).toMatchObject({ quantity: "1.75", price: "60000", market_value: "105000.00" });
    expect(pos.get("ETH")).toMatchObject({ quantity: "2", price: "2500.50", market_value: "5001.00" });
    expect(acct.balances).toEqual([{ balance_type: "total", amount: "110001" }]);
    expect(out.raw[0]?.filename).toBe("wallet-2026-08-25.json");
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
