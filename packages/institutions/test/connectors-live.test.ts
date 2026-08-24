// Live connector tests, skipped without credentials (the pattern of
// phase3-chat-live). Nothing here is required for CI; the hermetic
// equivalents live in connectors.test.ts.
//
// Plaid sandbox (https://sandbox.plaid.com, fake data only):
//   export PLAID_CLIENT_ID=... PLAID_SECRET=...
//   The test mints a sandbox item itself (/sandbox/public_token/create),
//   exchanges it, and runs the adapter against it.
//
// Enable Banking (real API; register an app + RSA key, then whitelist /
// use their Mock ASPSP):
//   export ENABLE_BANKING_APP_ID=... ENABLE_BANKING_PRIVATE_KEY_PATH=/path/key.pem
//   -> verifies the JWT auth by listing banks (Mock ASPSP included).
//   export ENABLE_BANKING_SESSION_ID=...   (from a completed consent)
//   -> additionally runs the full adapter fetch against that session.

import { describe, expect, test } from "bun:test";
import fs from "node:fs";

import { enableBankingAdapter, enableBankingJwt, ENABLEBANKING_SERVICE, memorySecretStore, plaidAdapter, PLAID_BASE_URLS, PLAID_SERVICE } from "../src";

const PLAID_ID = process.env["PLAID_CLIENT_ID"] ?? "";
const PLAID_SEC = process.env["PLAID_SECRET"] ?? "";
const EB_APP = process.env["ENABLE_BANKING_APP_ID"] ?? "";
const EB_KEY_PATH = process.env["ENABLE_BANKING_PRIVATE_KEY_PATH"] ?? "";
const EB_SESSION = process.env["ENABLE_BANKING_SESSION_ID"] ?? "";

describe("plaid live (sandbox; needs PLAID_CLIENT_ID + PLAID_SECRET)", () => {
  test.skipIf(PLAID_ID === "" || PLAID_SEC === "")(
    "a sandbox item round-trips: mint -> exchange -> adapter fetch -> snapshot",
    async () => {
      const base = PLAID_BASE_URLS.sandbox;
      const call = async (path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> => {
        const r = await fetch(`${base}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ client_id: PLAID_ID, secret: PLAID_SEC, ...body }),
        });
        const j = (await r.json()) as Record<string, unknown>;
        if (!r.ok) throw new Error(`${path}: ${JSON.stringify(j)}`);
        return j;
      };
      const minted = await call("/sandbox/public_token/create", {
        institution_id: "ins_109508", // First Platypus Bank, Plaid's canonical sandbox institution
        initial_products: ["transactions"],
      });
      const exchanged = await call("/item/public_token/exchange", { public_token: minted["public_token"] });

      const secrets = memorySecretStore({
        [`${PLAID_SERVICE}/client_id`]: PLAID_ID,
        [`${PLAID_SERVICE}/secret`]: PLAID_SEC,
        [`${PLAID_SERVICE}/access_token:inst.sandbox`]: exchanged["access_token"] as string,
      });
      const adapter = plaidAdapter({ institution_id: "inst.sandbox", environment: "sandbox", secrets });
      const out = await adapter.fetch({ now: new Date() });
      expect(out.snapshot.institution_id).toBe("inst.sandbox");
      expect(out.snapshot.accounts.length).toBeGreaterThan(0);
      for (const a of out.snapshot.accounts) {
        expect(a.account_id.startsWith("acct.sandbox.")).toBe(true);
        expect(a.balances.length).toBeGreaterThan(0);
      }
      expect(out.raw).toHaveLength(1);
    },
    30_000,
  );
});

describe("enable banking live (needs ENABLE_BANKING_APP_ID + ENABLE_BANKING_PRIVATE_KEY_PATH)", () => {
  const haveCreds = EB_APP !== "" && EB_KEY_PATH !== "" && fs.existsSync(EB_KEY_PATH);

  test.skipIf(!haveCreds)("the registered key signs JWTs the real API accepts (bank list includes the Mock ASPSP)", async () => {
    const pem = fs.readFileSync(EB_KEY_PATH, "utf8");
    const jwt = enableBankingJwt(EB_APP, pem, new Date());
    const r = await fetch("https://api.enablebanking.com/aspsps?country=FI", { headers: { Authorization: `Bearer ${jwt}` } });
    expect(r.ok).toBe(true);
    const { aspsps } = (await r.json()) as { aspsps: Array<{ name: string }> };
    expect(aspsps.length).toBeGreaterThan(0);
    expect(aspsps.some((a) => a.name.toLowerCase().includes("mock"))).toBe(true);
  }, 30_000);

  test.skipIf(!haveCreds || EB_SESSION === "")("a consented session fetches through the adapter", async () => {
    const secrets = memorySecretStore({
      [`${ENABLEBANKING_SERVICE}/app_id`]: EB_APP,
      [`${ENABLEBANKING_SERVICE}/private_key`]: fs.readFileSync(EB_KEY_PATH, "utf8"),
      [`${ENABLEBANKING_SERVICE}/session:inst.eblive`]: EB_SESSION,
    });
    const adapter = enableBankingAdapter({ institution_id: "inst.eblive", secrets });
    const out = await adapter.fetch({ now: new Date() });
    expect(out.snapshot.institution_id).toBe("inst.eblive");
    expect(out.snapshot.accounts.length).toBeGreaterThan(0);
  }, 60_000);
});
