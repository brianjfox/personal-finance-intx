// Importing the account list from Ledger Live's local app.json: chains
// named, addresses extracted, cached balances shown for recognition,
// duplicates collapsed, unsupported chains refused by name, and a
// password-locked file explained in plain words.

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { readLedgerLiveAccounts } from "../src/ledgerlive";

const write = (contents: unknown): string => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fin-ll-")), "app.json");
  fs.writeFileSync(f, JSON.stringify(contents));
  return f;
};

const ETH = "0x1dBAD5E4a7e29D122a9Ec7a3728688b1C953fe28";
const SOL = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

describe("ledger live import", () => {
  test("accounts come back with chain, address, name, and a readable cached balance", async () => {
    const file = write({
      data: {
        accounts: [
          { data: { id: `js:2:ethereum:${ETH}:`, name: "Ethereum 1", currencyId: "ethereum", xpub: ETH, balance: "12686556496632506996" } },
          { data: { id: `js:2:solana:${SOL}:`, name: "Solana 1", currencyId: "solana", freshAddress: SOL, balance: "14834108301969" } },
          // The same ETH address again under a different Ledger Live id: collapsed.
          { data: { id: `js:2:ethereum:${ETH}:x`, name: "Ethereum 1 again", currencyId: "ethereum", xpub: ETH, balance: "0" } },
          // A chain we can't watch live yet: named, not guessed.
          { data: { id: "js:2:dogecoin:DH5yaieqoZN36fDVciNyRueRGvGLR3mr7L:", name: "Doge", currencyId: "dogecoin", xpub: "DH5yaieqoZN36fDVciNyRueRGvGLR3mr7L", balance: "250000000000" } },
        ],
      },
    });
    const r = await readLedgerLiveAccounts(file);
    expect(r.found).toBe(true);
    expect(r.error).toBeUndefined();
    expect(r.accounts).toHaveLength(3); // duplicate collapsed
    const eth = r.accounts.find((a) => a.name === "Ethereum 1")!;
    expect(eth).toMatchObject({ chain: "Ethereum", supported: true, balance: "12.686556496632506996 ETH" });
    expect(eth.holding).toEqual({ kind: "eth_address", value: ETH, label: "Ethereum 1" });
    const sol = r.accounts.find((a) => a.name === "Solana 1")!;
    expect(sol).toMatchObject({ chain: "Solana", supported: true, balance: "14834.108301969 SOL" });
    const doge = r.accounts.find((a) => a.name === "Doge")!;
    expect(doge.supported).toBe(false);
    expect(doge.reason).toMatch(/dogecoin|Dogecoin/);
    expect(doge.balance).toBe("2500 DOGE");
  });

  test("a password-locked Ledger app is explained, not crashed on", async () => {
    const r = await readLedgerLiveAccounts(write({ data: "AES256-encrypted-blob-here" }));
    expect(r.found).toBe(true);
    expect(r.accounts).toHaveLength(0);
    expect(r.error).toMatch(/password-locked/);
  });

  test("no Ledger app at all says so", async () => {
    const r = await readLedgerLiveAccounts(path.join(os.tmpdir(), "definitely-missing", "app.json"));
    expect(r.found).toBe(false);
    expect(r.error).toMatch(/doesn't appear to be installed/);
  });

  test("a torn read (the app saving mid-import) is retried, not failed", async () => {
    // Start with truncated JSON -- what a non-atomic write looks like
    // mid-save -- and complete the file shortly after.
    const file = write({ data: { accounts: [] } });
    const good = fs.readFileSync(file, "utf8");
    fs.writeFileSync(file, good.slice(0, 20));
    setTimeout(() => fs.writeFileSync(file, good), 300);
    const r = await readLedgerLiveAccounts(file);
    expect(r.error).toBeUndefined();
    expect(r.found).toBe(true);
  });

  test("a file that never parses gives the mid-save explanation", async () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fin-ll-")), "app.json");
    fs.writeFileSync(f, "{never valid");
    const r = await readLedgerLiveAccounts(f);
    expect(r.error).toMatch(/wouldn't read cleanly/);
    expect(r.error).toMatch(/JSON|Unexpected/); // the true parse error is named
  }, 10_000);
});

describe("permission refusals", () => {
  test("an unreadable file is reported as macOS's doing, machine-readably", async () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fin-ll-")), "app.json");
    fs.writeFileSync(f, "{}");
    fs.chmodSync(f, 0o000);
    try {
      const r = await readLedgerLiveAccounts(f);
      expect(r.permission_denied).toBe(true);
      expect(r.error).toMatch(/macOS refused/);
      expect(r.accounts).toHaveLength(0);
    } finally {
      fs.chmodSync(f, 0o600);
    }
  }, 15_000);
});
