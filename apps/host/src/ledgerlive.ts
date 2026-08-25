// Import the account list from Ledger Live's own local data. A Ledger
// device stores no account list -- it derives keys on demand; the list
// the operator sees lives in Ledger Live's app.json on this machine.
// Reading it is local-only (nothing is sent anywhere) and yields exactly
// what the wallet form needs: each account's chain, address/xpub, and
// name, which flow through the same detector a hand-pasted account
// object uses. Cached balances are shown for recognition only -- the
// watch-only adapter reads live chain balances after import.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { detectWalletHolding, scaleDown, type WalletKind } from "@fin/institutions";

export function defaultLedgerLivePath(): string {
  return path.join(os.homedir(), "Library", "Application Support", "Ledger Live", "app.json");
}

/** Display decimals/symbols for the balances Ledger Live caches (recognition only). */
const CURRENCIES: Record<string, { symbol: string; decimals: number }> = {
  bitcoin: { symbol: "BTC", decimals: 8 },
  ethereum: { symbol: "ETH", decimals: 18 },
  litecoin: { symbol: "LTC", decimals: 8 },
  solana: { symbol: "SOL", decimals: 9 },
  dogecoin: { symbol: "DOGE", decimals: 8 },
  ripple: { symbol: "XRP", decimals: 6 },
  cardano: { symbol: "ADA", decimals: 6 },
  tron: { symbol: "TRX", decimals: 6 },
  bitcoin_cash: { symbol: "BCH", decimals: 8 },
  polkadot: { symbol: "DOT", decimals: 10 },
};

export interface LedgerLiveAccountRow {
  /** Ledger Live's own account id. */
  id: string;
  name: string;
  chain: string;
  /** Cached balance at Ledger Live's last sync, for recognition (e.g. "12.6866 ETH"). */
  balance: string | null;
  /** Ready to watch live? */
  supported: boolean;
  /** Why not, in plain words. */
  reason?: string;
  /** What connectWallet needs, when supported. */
  holding?: { kind: WalletKind; value: string; label?: string };
}

export interface LedgerLiveImport {
  found: boolean;
  file: string;
  accounts: LedgerLiveAccountRow[];
  /** A found-but-unreadable file, in plain words (e.g. password-locked). */
  error?: string;
}

export function readLedgerLiveAccounts(file = defaultLedgerLivePath()): LedgerLiveImport {
  if (!fs.existsSync(file)) {
    return { found: false, file, accounts: [], error: "Ledger Live doesn't appear to be installed on this Mac (no app.json)" };
  }
  let parsed: { data?: unknown };
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { data?: unknown };
  } catch {
    return { found: true, file, accounts: [], error: "Ledger Live's data file doesn't parse -- try opening Ledger Live once, then retry" };
  }
  const data = parsed.data;
  if (typeof data === "string") {
    return { found: true, file, accounts: [], error: "Ledger Live is password-locked, so its account list is encrypted -- paste the addresses instead" };
  }
  const rawAccounts = (data as { accounts?: Array<{ data?: Record<string, unknown> }> } | undefined)?.accounts ?? [];
  const seen = new Set<string>();
  const accounts: LedgerLiveAccountRow[] = [];
  for (const wrapper of rawAccounts) {
    const a = wrapper.data;
    if (a === undefined || typeof a !== "object") continue;
    const id = typeof a["id"] === "string" ? a["id"] : "";
    const name = typeof a["name"] === "string" && a["name"] !== "" ? (a["name"] as string) : id;
    const currencyId = typeof a["currencyId"] === "string" ? (a["currencyId"] as string) : "";
    const cur = CURRENCIES[currencyId];
    const balRaw = a["balance"];
    let balance: string | null = null;
    if (cur !== undefined && (typeof balRaw === "string" || typeof balRaw === "number")) {
      try {
        balance = `${scaleDown(BigInt(typeof balRaw === "number" ? Math.trunc(balRaw) : balRaw), cur.decimals)} ${cur.symbol}`;
      } catch {
        balance = null;
      }
    }
    // The same detector a hand-pasted account object goes through.
    const d = detectWalletHolding(JSON.stringify(a));
    if (d.ok) {
      if (seen.has(`${d.kind}|${d.value}`)) continue; // the same address listed twice
      seen.add(`${d.kind}|${d.value}`);
      accounts.push({
        id,
        name,
        chain: d.chain,
        balance,
        supported: true,
        holding: { kind: d.kind, value: d.value, label: name },
      });
    } else {
      accounts.push({ id, name, chain: cur?.symbol ?? currencyId, balance, supported: false, reason: d.reason });
    }
  }
  return { found: true, file, accounts };
}
