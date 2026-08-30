// The adapter seam.
//
// An institution adapter is the only code that knows a provider's format.
// It returns raw documents (evidence for the vault) and a snapshot in the
// canonical shape. It never touches the ledger. Credentials, when an API
// adapter arrives, are resolved by the host at the moment of use and
// handed in through `FetchContext.secret`; the adapter never stores them.

import { type } from "arktype";

import { InstitutionSnapshot, type DocumentKind, type InstitutionSnapshot as Snapshot } from "@fin/contracts";

export interface RawDocument {
  bytes: Uint8Array;
  filename: string;
  mime?: string;
  kind: DocumentKind;
  account_id?: string | null;
  tax_year?: number | null;
}

/** A snapshot before the vault has assigned document ids. */
export type DraftSnapshot = Omit<Snapshot, "raw_document_ids">;

export interface FetchContext {
  now: Date;
  /**
   * Transaction window override, days back from now. The host widens it
   * (to a year) when the ledger holds under a month of history for the
   * institution, so the first fetches paint a real cash-flow picture.
   * An explicit registry `lookback_days` option still wins.
   */
  lookback_days?: number;
  /** Read-only secret for API adapters (Phase 2+). File adapters ignore it. */
  secret?: (name: string) => Promise<string>;
}

export interface FetchOutput {
  raw: RawDocument[];
  snapshot: DraftSnapshot;
}

export interface InstitutionAdapter {
  readonly institution_id: string;
  /** `adapter.<name>@<version>`; lands in provenance `via`. */
  readonly via: string;
  fetch(ctx: FetchContext): Promise<FetchOutput>;
}

/** Validate a draft snapshot (everything but raw_document_ids) and normalise its account ordering. */
export function validateDraftSnapshot(draft: unknown, where: string): DraftSnapshot {
  const out = InstitutionSnapshot.omit("raw_document_ids")(draft);
  if (out instanceof type.errors) {
    throw new Error(`${where}: snapshot violates contract: ${out.summary}`);
  }
  return { ...out, accounts: [...out.accounts].sort((a, b) => a.account_id.localeCompare(b.account_id)) };
}
