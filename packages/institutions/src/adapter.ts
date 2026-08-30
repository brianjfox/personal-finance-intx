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

/** One HTTP exchange during a fetch, as observed on the wire. */
export interface HttpLogEntry {
  at: string;
  method: string;
  url: string;
  request_headers: Record<string, string>;
  request_body: string | null;
  /** 0 = the request never reached a response (network error). */
  status: number;
  response_headers: Record<string, string>;
  response_body: string;
  ms: number;
}

export type HttpLogSink = (entry: HttpLogEntry) => void;

const BODY_CAP = 20_000;
const clip = (s: string): string => (s.length > BODY_CAP ? `${s.slice(0, BODY_CAP)}\n… (${String(s.length - BODY_CAP)} more bytes truncated)` : s);

function headersToRecord(h: RequestInit["headers"] | Headers | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (h === undefined || h === null) return out;
  if (h instanceof Headers) {
    h.forEach((v, k) => { out[k] = v; });
    return out;
  }
  const join = (v: unknown): string => (Array.isArray(v) ? v.join(", ") : String(v ?? ""));
  if (Array.isArray(h)) {
    for (const pair of h) {
      const k = pair[0];
      if (typeof k === "string") out[k] = join(pair[1]);
    }
    return out;
  }
  for (const [k, v] of Object.entries(h as Record<string, unknown>)) {
    if (v !== undefined) out[k] = join(v);
  }
  return out;
}

/**
 * Wrap a fetch impl so every exchange during an adapter fetch is reported
 * to the current sink (when one is armed). The response body is read from
 * a clone; callers keep the original stream untouched.
 */
export function loggingFetch(doFetch: typeof fetch, sink: () => HttpLogSink | null): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const s = sink();
    if (s === null) return doFetch(input, init);
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const at = new Date().toISOString();
    const started = Date.now();
    const base = {
      at,
      method,
      url,
      request_headers: headersToRecord(init?.headers),
      request_body: typeof init?.body === "string" ? clip(init.body) : init?.body != null ? "(non-text body)" : null,
    };
    let r: Response;
    try {
      r = await doFetch(input, init);
    } catch (e) {
      s({ ...base, status: 0, response_headers: {}, response_body: `network error: ${e instanceof Error ? e.message : String(e)}`, ms: Date.now() - started });
      throw e;
    }
    let bodyText = "(body not captured)";
    try {
      if (typeof r.clone === "function") bodyText = clip(await r.clone().text());
    } catch {
      /* opaque or already-consumed body */
    }
    s({ ...base, status: r.status, response_headers: headersToRecord(r.headers), response_body: bodyText, ms: Date.now() - started });
    return r;
  }) as typeof fetch;
}

const SENSITIVE_HEADER = /auth|secret|token|key|cookie|sign|password/i;
const SENSITIVE_FIELD = /^(secret|access_token|refresh_token|private_key|password|api_key|apikey|client_secret)$/i;

const maskValue = (v: string): string => (v.length > 12 ? `••••${v.slice(-4)}` : "••••");

function redactBody(body: string | null): string | null {
  if (body === null) return body;
  try {
    const redact = (x: unknown): unknown => {
      if (Array.isArray(x)) return x.map(redact);
      if (x !== null && typeof x === "object") {
        return Object.fromEntries(
          Object.entries(x as Record<string, unknown>).map(([k, v]) =>
            SENSITIVE_FIELD.test(k) && typeof v === "string" ? [k, maskValue(v)] : [k, redact(v)],
          ),
        );
      }
      return x;
    };
    return JSON.stringify(redact(JSON.parse(body)));
  } catch {
    // Not JSON (or truncated JSON): scrub the obvious key/value shapes.
    return body.replace(/"(secret|access_token|refresh_token|private_key|password|api_key|client_secret)"\s*:\s*"[^"]*"/gi, '"$1":"••••"');
  }
}

/** Credentials never reach a screen: mask secret-bearing headers and body fields before an entry is stored or shown. */
export function redactHttpEntry(e: HttpLogEntry): HttpLogEntry {
  return {
    ...e,
    request_headers: Object.fromEntries(Object.entries(e.request_headers).map(([k, v]) => [k, SENSITIVE_HEADER.test(k) ? maskValue(v) : v])),
    response_headers: Object.fromEntries(Object.entries(e.response_headers).map(([k, v]) => [k, SENSITIVE_HEADER.test(k) ? maskValue(v) : v])),
    request_body: redactBody(e.request_body),
    response_body: redactBody(e.response_body) ?? e.response_body,
  };
}

export interface FetchContext {
  now: Date;
  /**
   * Transaction window override, days back from now. The host widens it
   * (to a year) when the ledger holds under a month of history for the
   * institution, so the first fetches paint a real cash-flow picture.
   * An explicit registry `lookback_days` option still wins.
   */
  lookback_days?: number;
  /** When set, API adapters report every HTTP exchange here (the Assets page's fetch-log view). */
  http?: HttpLogSink;
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
