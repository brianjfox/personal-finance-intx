// Import the account list from the Ledger app's own local data
// (branded Ledger Wallet these days, Ledger Live before). A Ledger
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

/**
 * The Ledger app rebranded (Ledger Live -> Ledger Wallet) but, at least
 * through the current build, keeps its data in the old folder. Check
 * both, preferring whichever actually holds an app.json.
 */
export function defaultLedgerLivePath(): string {
  const base = path.join(os.homedir(), "Library", "Application Support");
  for (const dir of ["Ledger Wallet", "Ledger Live"]) {
    const f = path.join(base, dir, "app.json");
    if (fs.existsSync(f)) return f;
  }
  return path.join(base, "Ledger Live", "app.json");
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

export async function readLedgerLiveAccounts(file = defaultLedgerLivePath()): Promise<LedgerLiveImport> {
  if (!fs.existsSync(file)) {
    return { found: false, file, accounts: [], error: "the Ledger app (Ledger Wallet / Ledger Live) doesn't appear to be installed on this Mac" };
  }
  // The Ledger app rewrites app.json frequently and not atomically, so a
  // single read can catch it mid-write. Retry briefly before giving up.
  let parsed: { data?: unknown } | null = null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { data?: unknown };
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  if (parsed === null) {
    return {
      found: true,
      file,
      accounts: [],
      error: "the Ledger app's data file wouldn't read cleanly (it may have been mid-save) -- let Ledger Wallet finish syncing, or quit it, then retry",
    };
  }
  const data = parsed.data;
  if (typeof data === "string") {
    return { found: true, file, accounts: [], error: "the Ledger app is password-locked, so its account list is encrypted -- paste the addresses instead" };
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
