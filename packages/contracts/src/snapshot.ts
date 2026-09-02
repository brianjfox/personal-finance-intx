// InstitutionSnapshot: the canonical output of a fetch, before it becomes
// facts. Every institution adapter -- file drop, CSV, a future HTTP API --
// produces exactly this shape, so normalise/reconcile never see a
// provider format. The raw bytes the snapshot was built from go to the
// vault as a `Document`; `raw_document_ids` is the provenance link.

import { type } from "arktype";

import {
  AccountType,
  AssetClass,
  BalanceType,
  TaxForm,
  TransactionType,
} from "./fact";
import { Currency, Decimal, Id, IsoDate, IsoDateTime, Subject } from "./scalars";

export const SnapshotInstrument = type({
  symbol: "string",
  "cusip?": "string | null",
  "name?": "string | null",
  asset_class: AssetClass,
});

export const SnapshotLot = type({
  "lot_id?": "string | null",
  quantity: Decimal,
  acquired_at: IsoDate,
  /** `null` = the institution did not report a basis. Adapters must not coerce to "0". */
  cost_basis: Decimal.or("null"),
  "transferred_in?": "boolean",
  /** Fair value of the lot on arrival, when the institution reports one (issue #57). */
  "value_at_transfer?": Decimal.or("null"),
});

export const SnapshotPosition = type({
  instrument: SnapshotInstrument,
  quantity: Decimal,
  "price?": Decimal.or("null"),
  "market_value?": Decimal.or("null"),
  cost_basis: Decimal.or("null"),
  "lots?": SnapshotLot.array(),
});

export const SnapshotTransaction = type({
  txn_id: "string",
  posted_at: IsoDateTime,
  amount: Decimal,
  type: TransactionType,
  description: "string",
  "instrument?": SnapshotInstrument.or("null"),
  "quantity?": Decimal.or("null"),
  "raw_category?": "string | null",
  /** For `swap`: what was given up. */
  "swap_from?": type({ instrument: SnapshotInstrument, quantity: Decimal }).or("null"),
  /** Institution-supplied hint that this is a transfer and where to/from. */
  "counterparty?": "string | null",
});

export const SnapshotTaxDocument = type({
  tax_year: "number.integer >= 1990",
  form: TaxForm,
  corrected: "boolean",
  "version?": "number.integer >= 1",
  issued_at: IsoDate,
  totals: "Record<string, string>",
  "document_id?": Id.or("null"),
});

export const SnapshotAccount = type({
  account_id: Subject,
  name: "string",
  type: AccountType,
  currency: Currency,
  "masked_number?": "string | null",
  /** The institution's own stated as-of for this account's figures. */
  as_of: IsoDateTime,
  balances: type({ balance_type: BalanceType, amount: Decimal }).array(),
  "positions?": SnapshotPosition.array(),
  "transactions?": SnapshotTransaction.array(),
  "tax_documents?": SnapshotTaxDocument.array(),
});
export type SnapshotAccount = typeof SnapshotAccount.infer;

export const InstitutionSnapshot = type({
  institution_id: Subject,
  /** When the fetch happened = `observed_at` for every fact derived from it. */
  fetched_at: IsoDateTime,
  /** Adapter name and version, e.g. `adapter.jsondrop@1`. */
  via: "string",
  raw_document_ids: Id.array(),
  accounts: SnapshotAccount.array(),
  /**
   * True when `accounts` is the institution's COMPLETE current account
   * list (an API adapter enumerating the connection), so an open ledger
   * account missing from it has genuinely stopped existing there. File
   * drops leave this unset: a partial drop must never close accounts.
   */
  "complete?": "boolean",
});
export type InstitutionSnapshot = typeof InstitutionSnapshot.infer;

/** A fetch that did not produce a snapshot. Kept as data so the run records it as a finding, not a crash. */
export const FetchFailure = type({
  institution_id: Subject,
  fetched_at: IsoDateTime,
  via: "string",
  error: "string",
});
export type FetchFailure = typeof FetchFailure.infer;

export const FetchResult = type({
  snapshots: InstitutionSnapshot.array(),
  failures: FetchFailure.array(),
});
export type FetchResult = typeof FetchResult.infer;
