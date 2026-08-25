// Live crypto-connector tests, skipped without credentials/addresses.
//
// Coinbase (create the CDP API key with View permission ONLY):
//   export COINBASE_API_KEY_NAME='organizations/.../apiKeys/...'
//   export COINBASE_PRIVATE_KEY_PATH=/path/to/key.pem
//   -> runs the adapter against the real API (read-only accounts fetch).
//
// Watch-only wallet (any public address; nothing secret involved):
//   export WALLET_BTC_ADDRESS=bc1q...     and/or
//   export WALLET_ETH_ADDRESS=0x...
//   -> queries mempool.space / a public ETH RPC and Coinbase spot prices.

import { describe, expect, test } from "bun:test";
import fs from "node:fs";

import { coinbaseAdapter, COINBASE_SERVICE, memorySecretStore, walletAdapter, type WalletHolding } from "../src";

const CB_KEY_NAME = process.env["COINBASE_API_KEY_NAME"] ?? "";
const CB_KEY_PATH = process.env["COINBASE_PRIVATE_KEY_PATH"] ?? "";
const BTC = process.env["WALLET_BTC_ADDRESS"] ?? "";
const ETH = process.env["WALLET_ETH_ADDRESS"] ?? "";

describe("coinbase live (needs COINBASE_API_KEY_NAME + COINBASE_PRIVATE_KEY_PATH)", () => {
  const have = CB_KEY_NAME !== "" && CB_KEY_PATH !== "" && fs.existsSync(CB_KEY_PATH);
  test.skipIf(!have)("the view-only key fetches priced holdings through the adapter", async () => {
    const secrets = memorySecretStore({
      [`${COINBASE_SERVICE}/api_key_name:inst.cblive`]: CB_KEY_NAME,
      [`${COINBASE_SERVICE}/private_key:inst.cblive`]: fs.readFileSync(CB_KEY_PATH, "utf8"),
    });
    const adapter = coinbaseAdapter({ institution_id: "inst.cblive", secrets });
    const out = await adapter.fetch({ now: new Date() });
    expect(out.snapshot.institution_id).toBe("inst.cblive");
    expect(out.snapshot.accounts).toHaveLength(1);
    expect(out.snapshot.accounts[0]?.type).toBe("crypto");
    expect(out.raw).toHaveLength(1);
  }, 60_000);
});

describe("watch-only wallet live (needs WALLET_BTC_ADDRESS and/or WALLET_ETH_ADDRESS)", () => {
  const holdings: WalletHolding[] = [
    ...(BTC !== "" ? [{ kind: "btc_address" as const, value: BTC }] : []),
    ...(ETH !== "" ? [{ kind: "eth_address" as const, value: ETH }] : []),
  ];
  test.skipIf(holdings.length === 0)("public chain data prices the wallet", async () => {
    const adapter = walletAdapter({ institution_id: "inst.walletlive", holdings });
    const out = await adapter.fetch({ now: new Date() });
    const acct = out.snapshot.accounts[0]!;
    expect(acct.account_id).toBe("acct.walletlive.wallet");
    // Every reported position carries an exact decimal quantity and a spot price.
    for (const p of acct.positions ?? []) {
      expect(p.quantity).toMatch(/^\d+(\.\d+)?$/);
      expect(p.price == null || /^\d+(\.\d+)?$/.test(p.price)).toBe(true);
    }
  }, 60_000);
});
