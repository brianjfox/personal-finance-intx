// Fixed-point decimal arithmetic over bigint for ledger math.
//
// Every figure the product shows is produced by code that the Auditor can
// re-run and reproduce exactly (deck slide 7). That rules out IEEE-754 for
// money. Values are `Decimal` strings at rest; this module parses them to
// a bigint scaled by 10^SCALE, operates, and formats back. SCALE = 10
// covers crypto quantities (satoshi = 1e-8) with headroom.

import type { Decimal } from "./scalars";

export const SCALE = 10;
const ONE = 10n ** BigInt(SCALE);

export function parseDecimal(s: string): bigint {
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(s);
  if (m === null) throw new Error(`not a decimal string: ${s}`);
  const neg = m[1] === "-";
  const whole = BigInt(m[2] ?? "0");
  const fracRaw = (m[3] ?? "").slice(0, SCALE).padEnd(SCALE, "0");
  const frac = BigInt(fracRaw);
  const v = whole * ONE + frac;
  return neg ? -v : v;
}

export function formatDecimal(v: bigint, places?: number): Decimal {
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const whole = abs / ONE;
  let frac = (abs % ONE).toString().padStart(SCALE, "0");
  if (places === undefined) {
    frac = frac.replace(/0+$/, "");
  } else {
    frac = frac.slice(0, places);
  }
  const body = frac.length > 0 ? `${whole}.${frac}` : `${whole}`;
  return `${neg && body !== "0" ? "-" : ""}${body}`;
}

export function add(a: string, b: string): Decimal {
  return formatDecimal(parseDecimal(a) + parseDecimal(b));
}
export function sub(a: string, b: string): Decimal {
  return formatDecimal(parseDecimal(a) - parseDecimal(b));
}
export function mul(a: string, b: string): Decimal {
  return formatDecimal((parseDecimal(a) * parseDecimal(b)) / ONE);
}
/** Divide, truncating toward zero at SCALE places. Throws on a zero divisor. */
export function div(a: string, b: string): Decimal {
  const y = parseDecimal(b);
  if (y === 0n) throw new Error(`decimal division by zero: ${a} / ${b}`);
  return formatDecimal((parseDecimal(a) * ONE) / y);
}
export function neg(a: string): Decimal {
  return formatDecimal(-parseDecimal(a));
}
export function abs(a: string): Decimal {
  const v = parseDecimal(a);
  return formatDecimal(v < 0n ? -v : v);
}
export function cmp(a: string, b: string): -1 | 0 | 1 {
  const x = parseDecimal(a);
  const y = parseDecimal(b);
  return x < y ? -1 : x > y ? 1 : 0;
}
export function isZero(a: string): boolean {
  return parseDecimal(a) === 0n;
}
export function sum(values: Iterable<string>): Decimal {
  let acc = 0n;
  for (const v of values) acc += parseDecimal(v);
  return formatDecimal(acc);
}
/** Round half away from zero to `places` decimal places. */
export function round(a: string, places: number): Decimal {
  const v = parseDecimal(a);
  const unit = 10n ** BigInt(SCALE - places);
  const half = unit / 2n;
  const q = v >= 0n ? (v + half) / unit : -((-v + half) / unit);
  return formatDecimal(q * unit, places);
}
