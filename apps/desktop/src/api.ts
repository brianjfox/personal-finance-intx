// Thin client over fin-host's localhost IPC.

export interface NetWorthLine {
  account_id: string; name: string; type: string; value: string; currency: string;
  basis: string; fact_ids: string[]; observed_at: string | null; provisional: boolean;
}
export interface NetWorth {
  assets: string; liabilities: string; net_worth: string; currency: string; lines: NetWorthLine[]; provisional: boolean;
  as_of: { effective_at: string | null; observed_at: string | null };
}
export interface Position {
  account_id: string; symbol: string; name: string | null; asset_class: string; quantity: string; price: string | null;
  market_value: string | null; cost_basis: string | null; basis_known: boolean; currency: string; fact_id: string;
  observed_at: string; effective_at: string; source_doc_id: string | null; provisional: boolean;
}
export interface Fact {
  id: string; kind: string; subject: string; key: string; payload: Record<string, unknown>; observed_at: string; effective_at: string;
  source_id: string; source_doc_id: string | null; page?: number | null; supersedes: string | null; writer: string; provisional: boolean; batch_id: string;
}
export interface Doc {
  id: string; sha256: string; mime: string; bytes: number; filename: string; kind: string; pages: number | null; source_id: string;
  institution_id?: string | null; ingested_at: string; ingested_by: string;
}
export interface Finding {
  id: string; kind: string; code: string; severity: string; subject: string; summary: string; detail: Record<string, unknown>;
  evidence: string[]; before: string[]; after: string[]; requires_human: boolean; emitted_by: string; as_of: string;
  resolved: boolean; resolutions: Array<{ decision: string; note: string; decided_by: string; decided_at: string }>;
  run_id: string | null;
}
export interface RunSummary {
  runId: string; workflow: string; status: string; startedAt: string | null; endedAt: string | null;
  steps: Record<string, { status: string; gateId?: string; branch?: string; message?: string }>;
}

async function get<T>(path: string): Promise<T> {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return (await r.json()) as T;
}
async function post<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
  return (await r.json()) as T;
}

export const api = {
  netWorth: () => get<NetWorth>("/api/net-worth"),
  positions: () => get<Position[]>("/api/positions"),
  queue: () => get<Finding[]>("/api/queue"),
  findings: () => get<Finding[]>("/api/findings"),
  fact: (id: string) => get<{ fact: Fact; history: Fact[]; document: Doc | null }>(`/api/fact/${id}`),
  finding: (id: string) => get<{ finding: Finding; before: Fact[]; after: Fact[] }>(`/api/finding/${id}`),
  resolve: (id: string, decision: string, note: string) => post<{ resolutionId: string; resultingFacts: string[] }>(`/api/finding/${id}/resolve`, { decision, note }),
  runs: () => get<RunSummary[]>("/api/runs"),
  nightly: () => post<{ runId: string; status: string }>("/api/nightly?wait=1"),
  documents: () => get<Doc[]>("/api/documents"),
  journal: () => get<Array<{ id: string; at: string; kind: string; summary: string; author: string; refs: string[] }>>("/api/journal"),
};

export function money(v: string | null | undefined, currency = "USD"): string {
  if (v === null || v === undefined) return "—";
  const n = Number(v);
  if (!Number.isFinite(n)) return v;
  return new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: 2 }).format(n);
}
export function when(iso: string | null | undefined): string {
  if (!iso) return "—";
  return iso.replace("T", " ").replace(/\.\d{3}Z$/, "Z");
}
