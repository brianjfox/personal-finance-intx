// Reading money the way people write it: "$1,250,000.50",
// "€1.250.000,50", "£12,000", "CHF 5'000", "1 250 000,50 kr",
// "(1,200)" for negative. The currency symbol or ISO code travels WITH
// the value -- the ledger always stores the native currency; conversion
// happens only at display time.

export interface ParsedMoney {
  /** Canonical decimal string (the ledger's Decimal pattern). */
  amount: string;
  /** ISO code when the text names one; null when absent or ambiguous (e.g. bare "kr"). */
  currency: string | null;
}

/** Unambiguous symbols/prefixes -> ISO. Longest match wins ("CA$" before "$"). */
const SYMBOLS: ReadonlyArray<readonly [string, string]> = [
  ["US$", "USD"], ["CA$", "CAD"], ["C$", "CAD"], ["AU$", "AUD"], ["A$", "AUD"], ["NZ$", "NZD"],
  ["MX$", "MXN"], ["R$", "BRL"], ["CN¥", "CNY"], ["JP¥", "JPY"],
  ["$", "USD"], ["€", "EUR"], ["£", "GBP"], ["¥", "JPY"], ["￥", "JPY"],
  ["₹", "INR"], ["₩", "KRW"], ["₺", "TRY"], ["₪", "ILS"], ["₱", "PHP"], ["₫", "VND"], ["฿", "THB"],
  ["zł", "PLN"], ["Fr.", "CHF"],
];

/** Suffix/prefix words that mark a currency but ambiguously ("kr" is SEK/NOK/DKK/ISK). */
const AMBIGUOUS = ["kr", "kr.", "Kr"];

/**
 * Parse a human-typed money string. Returns null when no number can be
 * found. Never guesses a currency: an ambiguous marker yields
 * `currency: null` and the caller applies its default.
 */
export function parseMoneyInput(raw: string): ParsedMoney | null {
  let s = raw.trim();
  if (s === "") return null;
  let currency: string | null = null;

  // ISO code anywhere ("USD 1200", "1200 eur").
  const iso = /(?:^|[\s(])([A-Za-z]{3})(?:$|[\s)\d])/.exec(s);
  if (iso !== null && /^[A-Za-z]{3}$/.test(iso[1] as string)) {
    const code = (iso[1] as string).toUpperCase();
    // Avoid eating number-adjacent words that aren't codes ("two", "per").
    if (KNOWN_CODES.has(code)) {
      currency = code;
      s = s.replace(iso[1] as string, " ");
    }
  }
  // Symbols (longest first).
  for (const [sym, code] of SYMBOLS) {
    if (s.includes(sym)) {
      currency ??= code;
      s = s.split(sym).join(" ");
      break;
    }
  }
  for (const marker of AMBIGUOUS) {
    const re = new RegExp(`(?:^|\\s)${marker.replace(".", "\\.")}(?:$|\\s)`);
    if (re.test(s)) s = s.replace(re, " ");
  }

  // Parentheses accounting-negative; explicit sign.
  let negative = false;
  const paren = /^\s*\(([^)]+)\)\s*$/.exec(s);
  if (paren !== null) {
    negative = true;
    s = paren[1] as string;
  }
  s = s.trim();
  if (s.startsWith("-")) {
    negative = true;
    s = s.slice(1);
  } else if (s.startsWith("+")) {
    s = s.slice(1);
  }

  // Thousands junk: spaces, NBSP, thin space, apostrophes (Swiss).
  s = s.replace(/[\s  '’]/g, "");
  if (!/^[0-9.,]+$/.test(s) || !/[0-9]/.test(s)) return null;

  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  let normalized: string;
  if (lastComma !== -1 && lastDot !== -1) {
    // Both present: whichever comes last is the decimal separator.
    const dec = lastComma > lastDot ? "," : ".";
    const thou = dec === "," ? "." : ",";
    normalized = s.split(thou).join("").replace(dec, ".");
  } else if (lastComma !== -1 || lastDot !== -1) {
    const sep = lastComma !== -1 ? "," : ".";
    // A single separator kind: it's a thousands separator only when the
    // grouping is exact (1,250 / 1.250.000); otherwise it's the decimal.
    const grouped = new RegExp(`^\\d{1,3}(\\${sep}\\d{3})+$`).test(s);
    if (grouped) normalized = s.split(sep).join("");
    else if (s.split(sep).length === 2) normalized = s.replace(sep, ".");
    else return null; // e.g. "1,23,45" -- neither a grouping nor a single decimal
  } else {
    normalized = s;
  }
  if (!/^\d+(\.\d+)?$/.test(normalized)) return null;
  // Canonical: strip leading zeros (keep one before the point).
  normalized = normalized.replace(/^0+(?=\d)/, "");
  return { amount: `${negative ? "-" : ""}${normalized}`, currency };
}

/** ISO codes the parser recognizes as currency words. */
const KNOWN_CODES = new Set([
  "USD", "EUR", "GBP", "JPY", "CHF", "CAD", "AUD", "NZD", "SEK", "NOK", "DKK", "ISK",
  "PLN", "CZK", "HUF", "RON", "BGN", "TRY", "ILS", "INR", "KRW", "CNY", "HKD", "SGD",
  "MXN", "BRL", "ZAR", "PHP", "THB", "VND", "IDR", "MYR",
]);

/** Currencies the display layer offers as preferred (all covered by ECB reference rates). */
export const DISPLAY_CURRENCIES = [
  "USD", "EUR", "GBP", "JPY", "CHF", "CAD", "AUD", "NZD", "SEK", "NOK", "DKK",
  "PLN", "CZK", "HUF", "RON", "TRY", "ILS", "INR", "KRW", "CNY", "HKD", "SGD", "MXN", "BRL", "ZAR",
] as const;
