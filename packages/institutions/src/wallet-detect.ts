// Which chain does a pasted string belong to? The major chains are
// distinguishable from syntax alone: base58 version prefixes (Bitcoin
// '1'/'3', Litecoin 'L'/'M', Dogecoin 'D', XRP 'r', Tron 'T'), bech32
// human-readable parts (bc1..., ltc1..., addr1...), 0x + 40 hex (EVM),
// and the xpub-family prefixes for extended keys. So the operator just
// pastes an address and the app names it -- no "what kind is this?"
// dropdown. Detection is conservative: a recognized-but-unsupported
// chain gets a named refusal, and genuinely ambiguous input is an
// error, never a guess that silently reads the wrong chain.
//
// Dependency-free on purpose: the same function runs in the host and
// answers the GUI's per-row feedback endpoint.

export type WalletKind = "btc_address" | "btc_xpub" | "eth_address" | "ltc_address" | "sol_address";

export type WalletDetection =
  | { ok: true; kind: WalletKind; chain: string; note?: string }
  | { ok: false; reason: string };

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/;
const BECH32 = /^([a-z]+)1[02-9ac-hj-np-z]{6,}$/;

export function detectWalletHolding(raw: string): WalletDetection {
  const value = raw.trim();
  if (value === "") return { ok: false, reason: "paste an address first" };

  if (value.toLowerCase().startsWith("bitcoincash:") || (BASE58.test(value) && value.startsWith("q") && value.length > 40)) {
    return { ok: false, reason: "that looks like a Bitcoin Cash address -- not supported yet" };
  }

  // EVM: 0x + 40 hex. Every EVM chain shares this shape; we read Ethereum mainnet.
  if (/^0x[0-9a-fA-F]{40}$/.test(value)) {
    return { ok: true, kind: "eth_address", chain: "Ethereum", note: "EVM addresses look alike across chains; balances are read from Ethereum mainnet" };
  }
  if (/^0x[0-9a-fA-F]+$/.test(value)) {
    return { ok: false, reason: "that starts like an Ethereum address but isn't 40 hex characters -- check for a missing or extra character" };
  }

  // Extended keys: legacy xpub works with the lookup API; segwit variants do not.
  if (/^xpub[1-9A-HJ-NP-Za-km-z]{20,}$/.test(value)) {
    return { ok: true, kind: "btc_xpub", chain: "Bitcoin (legacy extended key)" };
  }
  const xpubish = /^([yzuv]pub)[1-9A-HJ-NP-Za-km-z]{20,}$/.exec(value);
  if (xpubish !== null) {
    return { ok: false, reason: `a ${xpubish[1]} is a segwit extended key; the lookup API only reads legacy xpubs -- paste the wallet's individual receive addresses instead` };
  }

  // Bech32: the human-readable part names the chain.
  const bech = BECH32.exec(value.toLowerCase());
  if (bech !== null && value === value.toLowerCase()) {
    const hrp = bech[1] as string;
    if (hrp === "bc") return { ok: true, kind: "btc_address", chain: "Bitcoin" };
    if (hrp === "ltc") return { ok: true, kind: "ltc_address", chain: "Litecoin" };
    if (hrp === "tb" || hrp === "tltc") return { ok: false, reason: "that's a testnet address -- testnet coins aren't money" };
    if (hrp === "addr") return { ok: false, reason: "that looks like a Cardano address -- not supported yet" };
    const named: Record<string, string> = { cosmos: "Cosmos", osmo: "Osmosis", juno: "Juno", akash: "Akash", celestia: "Celestia" };
    if (named[hrp] !== undefined) return { ok: false, reason: `that looks like a ${named[hrp]} address -- not supported yet` };
  }

  if (BASE58.test(value)) {
    const first = value[0] as string;
    if ((first === "1" || first === "3") && value.length >= 25 && value.length <= 35) {
      return { ok: true, kind: "btc_address", chain: "Bitcoin" };
    }
    if ((first === "L" || first === "M") && value.length >= 26 && value.length <= 35) {
      return { ok: true, kind: "ltc_address", chain: "Litecoin" };
    }
    if (first === "D" && value.length >= 32 && value.length <= 35) {
      return { ok: false, reason: "that looks like a Dogecoin address -- not supported yet" };
    }
    if (first === "r" && value.length >= 25 && value.length <= 36) {
      return { ok: false, reason: "that looks like an XRP address -- not supported yet" };
    }
    if (first === "T" && value.length === 34) {
      return { ok: false, reason: "that looks like a Tron address -- not supported yet" };
    }
    // Solana public keys are 32 bytes of base58: 43-44 characters, no
    // version prefix. Everything with a strong prefix was caught above.
    if (value.length >= 43 && value.length <= 44) {
      return { ok: true, kind: "sol_address", chain: "Solana" };
    }
  }

  return { ok: false, reason: "couldn't recognize this as a crypto address -- supported today: Bitcoin, Litecoin, Ethereum, Solana, and legacy Bitcoin xpubs" };
}

/** GUI labels per kind (the detection's chain string, for stored rows). */
export const WALLET_KIND_LABELS: Record<WalletKind, string> = {
  btc_address: "Bitcoin",
  btc_xpub: "Bitcoin (legacy extended key)",
  eth_address: "Ethereum",
  ltc_address: "Litecoin",
  sol_address: "Solana",
};
