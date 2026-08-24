// Scalar vocabulary shared by every contract.
//
// Every message in the interchange carries an id, an as-of timestamp and
// provenance (deck slide 12). These are the primitive shapes those fields
// are built from. Amounts are decimal *strings*, never JS numbers: a
// balance is a fact, and a fact must round-trip the ledger byte-for-byte.
// Arithmetic happens in `decimal.ts` (fixed point over bigint), never in
// floating point and never in a language model (deck slide 7).

import { type } from "arktype";

/** ISO 8601 UTC timestamp, e.g. `2026-08-23T22:04:00.000Z`. */
export const IsoDateTime = type("string.date.iso");
export type IsoDateTime = typeof IsoDateTime.infer;

/** Calendar date, `YYYY-MM-DD`. Used for effective dates and tax years' deadlines. */
export const IsoDate = type(/^\d{4}-\d{2}-\d{2}$/);
export type IsoDate = typeof IsoDate.infer;

/** Decimal string: optional sign, digits, optional fraction. No exponent, no thousands separators. */
export const Decimal = type(/^-?\d+(\.\d+)?$/);
export type Decimal = typeof Decimal.infer;

/** ISO 4217 code or a crypto ticker in upper case (`USD`, `EUR`, `BTC`). */
export const Currency = type(/^[A-Z0-9]{2,10}$/);
export type Currency = typeof Currency.infer;

/** `<prefix>_<body>`: `fact_01J...`, `fnd_...`, `rec_...`. Prefix is lower-case alpha. */
export const Id = type(/^[a-z]+_[A-Za-z0-9._:-]+$/);
export type Id = typeof Id.infer;

/** Dotted subject path, e.g. `acct.schwab.brokerage-1234`, `inst.schwab`, `household`. */
export const Subject = type(/^[a-z][a-z0-9]*(\.[A-Za-z0-9_-]+)*$/);
export type Subject = typeof Subject.infer;

/** Decimal with a currency, as one value. */
export const Money = type({ amount: Decimal, currency: Currency });
export type Money = typeof Money.infer;

export const Severity = type("'info' | 'low' | 'medium' | 'high' | 'critical'");
export type Severity = typeof Severity.infer;

// --- ids ---------------------------------------------------------------

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
let lastTime = 0;
let lastRandom: number[] = [];

/**
 * Monotonic ULID-style id generator: `<prefix>_<10 time chars><16 random chars>`.
 * Monotonic within a process so ids sort by creation order, which keeps
 * the append-only tables readable in insertion order without a sequence.
 */
export function newId(prefix: string, now: number = Date.now()): string {
  if (!/^[a-z]+$/.test(prefix)) {
    throw new Error(`id prefix must be lower-case alpha, got ${prefix}`);
  }
  if (now === lastTime) {
    // increment the random part (base 32, little-endian carry)
    let i = lastRandom.length - 1;
    while (i >= 0) {
      const v = (lastRandom[i] ?? 0) + 1;
      if (v < 32) {
        lastRandom[i] = v;
        break;
      }
      lastRandom[i] = 0;
      i -= 1;
    }
  } else {
    lastTime = now;
    lastRandom = Array.from({ length: 16 }, () => Math.floor(Math.random() * 32));
  }
  let t = "";
  let rem = now;
  for (let i = 0; i < 10; i += 1) {
    t = CROCKFORD[rem % 32] + t;
    rem = Math.floor(rem / 32);
  }
  const r = lastRandom.map((d) => CROCKFORD[d]).join("");
  return `${prefix}_${t}${r}`;
}

/** Validate a value against a schema and return it typed, or throw with the ArkType summary. */
export function assertType<T>(
  schema: { (data: unknown): T | type.errors },
  data: unknown,
  what: string,
): T {
  const out = schema(data);
  if (out instanceof type.errors) {
    throw new ContractViolation(what, out.summary);
  }
  return out;
}

export class ContractViolation extends Error {
  override readonly name = "ContractViolation";
  constructor(
    readonly what: string,
    readonly detail: string,
  ) {
    super(`${what} violates its contract: ${detail}`);
  }
}
