// Fact: a dated observation with a source. Only ledger agents emit these.
//
// Invariants (BUILD_PLAN §5):
//   1. Append-only: corrections are new facts that `supersedes` old ones.
//   2. Bitemporal: `observed_at` (when we learned it) and `effective_at`
//      (when it was true) on every fact.
//   3. Provenance is mandatory.
//   4. One writer per fact kind -- `FACT_WRITERS`, enforced by the ledger
//      at write time and by the policy layer at the workflow step.

import { type } from "arktype";

import { Principal } from "./principals";
import { Currency, Decimal, Id, IsoDate, IsoDateTime, Subject } from "./scalars";

// --- kinds ------------------------------------------------------------

export const FACT_KINDS = [
  "account",
  "balance",
  "position",
  "lot",
  "transaction",
  "tax_document",
  "obligation",
  "entity",
] as const;
export type FactKind = (typeof FACT_KINDS)[number];
export const FactKind = type.enumerated(...FACT_KINDS);

/**
 * One writer per fact kind. Deck slide 6: "No second agent may correct the
 * ledger behind the owner's back." Assets Manager owns positions,
 * balances, cost basis and tax lots; Cash Flow owns classified flows;
 * Liabilities owns obligations; Document Vault owns extracted documents;
 * Registry owns entities.
 */
export const FACT_WRITERS = {
  account: "assets_manager",
  balance: "assets_manager",
  position: "assets_manager",
  lot: "assets_manager",
  transaction: "cash_flow",
  tax_document: "document_vault",
  obligation: "liabilities",
  entity: "registry",
} as const satisfies Record<FactKind, Principal>;

export function writerOf(kind: FactKind): Principal {
  return FACT_WRITERS[kind];
}

// --- payloads ---------------------------------------------------------

export const AccountType = type(
  "'checking' | 'savings' | 'money_market' | 'brokerage' | 'ira' | 'roth_ira' | '401k' | 'hsa' | '529' | 'crypto' | 'credit_card' | 'mortgage' | 'loan' | 'heloc' | 'other'",
);
export type AccountType = typeof AccountType.infer;

/** Account types whose balance is owed, not owned. */
export const LIABILITY_ACCOUNT_TYPES: ReadonlySet<AccountType> = new Set([
  "credit_card",
  "mortgage",
  "loan",
  "heloc",
]);
/** Account types whose holdings are positions rather than a single cash balance. */
export const POSITION_ACCOUNT_TYPES: ReadonlySet<AccountType> = new Set([
  "brokerage",
  "ira",
  "roth_ira",
  "401k",
  "hsa",
  "529",
  "crypto",
]);

export const AccountPayload = type({
  account_id: Subject,
  institution_id: Subject,
  name: "string",
  type: AccountType,
  currency: Currency,
  /** Last four (or similar) only. Full account numbers never enter the ledger. */
  "masked_number?": "string | null",
  "opened_at?": IsoDate.or("null"),
  "closed_at?": IsoDate.or("null"),
});
export type AccountPayload = typeof AccountPayload.infer;

export const BalanceType = type("'total' | 'available' | 'cash' | 'owed' | 'credit_limit'");
export type BalanceType = typeof BalanceType.infer;

export const BalancePayload = type({
  account_id: Subject,
  balance_type: BalanceType,
  amount: Decimal,
  currency: Currency,
  /** The institution's own stated as-of for this figure, when it reports one. */
  "stated_as_of?": IsoDateTime.or("null"),
});
export type BalancePayload = typeof BalancePayload.infer;

export const AssetClass = type(
  "'equity' | 'etf' | 'mutual_fund' | 'bond' | 'cash' | 'crypto' | 'option' | 'other'",
);
export type AssetClass = typeof AssetClass.infer;

export const Instrument = type({
  symbol: "string",
  "cusip?": "string | null",
  "name?": "string | null",
  asset_class: AssetClass,
});
export type Instrument = typeof Instrument.infer;

export const PositionPayload = type({
  account_id: Subject,
  instrument: Instrument,
  quantity: Decimal,
  "price?": Decimal.or("null"),
  "market_value?": Decimal.or("null"),
  currency: Currency,
  /** Total cost basis of the position; `null` means unknown, NEVER zero-by-default. */
  cost_basis: Decimal.or("null"),
  /** True when the institution flagged the basis as reported/known. */
  basis_known: "boolean",
});
export type PositionPayload = typeof PositionPayload.infer;

export const LotPayload = type({
  account_id: Subject,
  lot_id: "string",
  instrument: Instrument,
  quantity: Decimal,
  acquired_at: IsoDate,
  /** `null` means unknown. A transferred lot with a missing basis is a break, not a zero. */
  cost_basis: Decimal.or("null"),
  basis_known: "boolean",
  transferred_in: "boolean",
  currency: Currency,
});
export type LotPayload = typeof LotPayload.infer;

export const TransactionType = type(
  "'debit' | 'credit' | 'buy' | 'sell' | 'dividend' | 'interest' | 'fee' | 'tax' | 'transfer_in' | 'transfer_out' | 'income' | 'swap' | 'other'",
);
export type TransactionType = typeof TransactionType.infer;

export const TransactionPayload = type({
  account_id: Subject,
  /** Institution's own reference for the transaction. */
  txn_id: "string",
  posted_at: IsoDateTime,
  /** Signed: positive = into the account, negative = out of it. */
  amount: Decimal,
  currency: Currency,
  type: TransactionType,
  description: "string",
  "instrument?": Instrument.or("null"),
  "quantity?": Decimal.or("null"),
  /** Set by normalisation when this is one leg of a transfer between household accounts. */
  "transfer_group?": "string | null",
  "counterparty_account_id?": Subject.or("null"),
  /** The institution's own category string, kept verbatim. */
  "raw_category?": "string | null",
  /** For swaps: the instrument given up. */
  "swap_from?": type({ instrument: Instrument, quantity: Decimal }).or("null"),
});
export type TransactionPayload = typeof TransactionPayload.infer;

export const TaxForm = type(
  "'1099-B' | '1099-DIV' | '1099-INT' | '1099-MISC' | '1099-R' | '1099-NEC' | 'K-1' | 'W-2' | '1098' | 'other'",
);
export type TaxForm = typeof TaxForm.infer;

export const TaxDocumentPayload = type({
  account_id: Subject,
  tax_year: "number.integer >= 1990",
  form: TaxForm,
  corrected: "boolean",
  /** Institution's version/revision number when given; 1 for the original. */
  version: "number.integer >= 1",
  issued_at: IsoDate,
  /** Box totals, keyed by the form's own box labels. */
  totals: "Record<string, string>",
});
export type TaxDocumentPayload = typeof TaxDocumentPayload.infer;

export const ObligationPayload = type({
  account_id: Subject,
  obligation_id: "string",
  kind: "'mortgage' | 'loan' | 'credit_line' | 'premium' | 'subscription' | 'tax_estimate' | 'other'",
  description: "string",
  "principal_outstanding?": Decimal.or("null"),
  "payment_amount?": Decimal.or("null"),
  "payment_due?": IsoDate.or("null"),
  "rate?": Decimal.or("null"),
  currency: Currency,
});
export type ObligationPayload = typeof ObligationPayload.infer;

export const EntityPayload = type({
  entity_id: Subject,
  kind: "'person' | 'trust' | 'llc' | 'estate' | 'joint' | 'other'",
  name: "string",
  "detail?": "Record<string, unknown>",
});
export type EntityPayload = typeof EntityPayload.infer;

export const FACT_PAYLOADS = {
  account: AccountPayload,
  balance: BalancePayload,
  position: PositionPayload,
  lot: LotPayload,
  transaction: TransactionPayload,
  tax_document: TaxDocumentPayload,
  obligation: ObligationPayload,
  entity: EntityPayload,
} as const;

export type FactPayloadOf<K extends FactKind> = (typeof FACT_PAYLOADS)[K]["infer"];

// --- envelope ---------------------------------------------------------

export const Fact = type({
  id: Id,
  kind: FactKind,
  /** What the fact is about: an account, an institution, the household. */
  subject: Subject,
  /**
   * Identity of the thing within (kind, subject) -- `VTI` for a position,
   * `total` for a balance, the txn id for a transaction. Two facts with the
   * same (kind, subject, key) describe the same thing at different times
   * or from different observations. Chosen by the writer, deterministic.
   */
  key: "string",
  payload: "object",
  observed_at: IsoDateTime,
  effective_at: IsoDateTime,
  source_id: Subject,
  source_doc_id: Id.or("null"),
  "page?": type("number.integer >= 1").or("null"),
  supersedes: Id.or("null"),
  writer: Principal,
  provisional: "boolean",
});
export type Fact = typeof Fact.infer;

/** What a writer hands the ledger; the ledger assigns `id`. */
export const FactInput = Fact.omit("id");
export type FactInput = typeof FactInput.infer;

/** Validate a fact's payload against the schema for its kind. */
export function validateFactPayload(kind: FactKind, payload: unknown) {
  return FACT_PAYLOADS[kind](payload);
}
