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
  test("accounts come back with chain, address, name, and a readable cached balance", () => {
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
    const r = readLedgerLiveAccounts(file);
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

  test("a password-locked Ledger Live is explained, not crashed on", () => {
    const r = readLedgerLiveAccounts(write({ data: "AES256-encrypted-blob-here" }));
    expect(r.found).toBe(true);
    expect(r.accounts).toHaveLength(0);
    expect(r.error).toMatch(/password-locked/);
  });

  test("no Ledger Live at all says so", () => {
    const r = readLedgerLiveAccounts(path.join(os.tmpdir(), "definitely-missing", "app.json"));
    expect(r.found).toBe(false);
    expect(r.error).toMatch(/doesn't appear to be installed/);
  });
});
