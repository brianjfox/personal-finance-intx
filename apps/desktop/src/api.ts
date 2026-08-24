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
export interface TaxStageStatus { state: "pending" | "armed" | "ran" | "skipped" | "failed"; fire_at: string | null; covered: boolean | null }
export interface TaxEstimatePayload {
  quarter: number; stage: string; as_of: string; due: string; blocked: string[];
  figures: {
    ordinary_income: string; st_gains: string; lt_gains: string; basis_incomplete: boolean;
    annualization_factor: string; annualized_tax: string; safe_harbor_cap: string;
    required_cum: string; payments_cum: string; installment_due: string;
  } | null;
  reserve: { account: string; balance: string | null; required: string; shortfall: string } | null;
  reserve_ok: boolean;
  wash_sales: Array<{ symbol: string; sale_txn_id: string; sale_date: string; loss: string; disallowed_estimate: string }>;
  evidence: string[];
}
export interface TaxQuarterStatus {
  quarter: number; due: string; period_end: string;
  pre: TaxStageStatus; due_stage: TaxStageStatus;
  obligation: { fact_id: string; amount: string | null; due: string | null; observed_at: string; superseded: boolean } | null;
  estimate: TaxEstimatePayload | null;
}
export interface TaxStatus {
  profile: { tax_year: number; reserve_account: string; ordinary_rate: string; ltcg_rate: string; prior_year_tax: string; withholding_annual: string } | null;
  year: number | null; runId: string | null; runStatus: string | null;
  quarters: TaxQuarterStatus[];
}
export interface Obligation {
  subject: string; key: string; obligation_id: string; kind: string; description: string; account_id: string;
  amount: string | null; due: string | null; currency: string; fact_id: string; observed_at: string; supersedes: string | null; provisional: boolean;
}
export type ChatAgentName = "strategist" | "estate_planner";
export interface ChatEvidence { tool: string; result: unknown; fact_ids: string[]; at: string }
export interface ChatTurn {
  agent: ChatAgentName; message_id: string; message: string; reply: string;
  evidence: ChatEvidence[]; journal_ids: string[]; at: string;
}
export interface EstateStatus {
  configured: boolean;
  entities: Array<{ subject: string; fact_id: string; payload: { name?: string; kind?: string } }>;
  titling: Array<{ subject: string; fact_id: string; payload: { owner?: string; in_trust?: string | null; beneficiaries?: Array<{ name: string; share?: string | null }>; verified_at?: string } }>;
  plan: { titling: Array<{ account_id: string; owner: string; in_trust?: string | null; beneficiaries?: Array<{ name: string; share?: string | null }> }>; documents: Array<{ kind: string; description: string }>; executors: string[] } | null;
  openFindings: number;
  lastAudit: unknown;
}
export interface JournalEntry { id: string; at: string; kind: string; subject?: string | null; summary: string; detail: Record<string, unknown>; refs: string[]; author: string }
export interface Recommendation {
  id: string; from: string; subject: string;
  action: { verb: string; instrument?: string | null; quantity?: string | null; amount?: { amount: string; currency: string } | null; detail?: string };
  thesis: string; evidence: string[]; as_of: string; confidence: number; requires: string[]; expires: string;
  tax_lots?: Array<{ lot_id: string; treatment: string }>;
}
export interface QueuedApproval {
  recommendation: Recommendation;
  verdict: { cleared: boolean; attempt: number; as_of: string; blocks: Array<{ condition: string; detail: string }>; figures: Record<string, unknown> };
  severity: string;
}
export interface InstructionRow {
  id: string; approval_id: string; recommendation_id: string; subject: string;
  action: Recommendation["action"]; bound: { max_quantity?: string | null; limit_price?: string | null; max_amount?: { amount: string; currency: string } | null };
  issued_at: string; expires: string; status: string; current_status: string;
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
  tax: () => get<TaxStatus>("/api/tax"),
  obligations: () => get<Obligation[]>("/api/obligations"),
  taxYearStart: (year?: number) => post<{ runId: string }>("/api/tax-year", year !== undefined ? { year } : {}),
  taxCheck: (quarter: number, stage: "pre" | "due") => post<{ runId: string; status: string }>("/api/tax/check", { quarter, stage }),
  taxSkip: (quarter: number, stage: "pre" | "due", note: string) => post<{ runId: string; signalId: string }>("/api/tax/skip", { quarter, stage, note }),
  chatTranscript: (agent: ChatAgentName) => get<ChatTurn[]>(`/api/chat/${agent}`),
  chatSend: (agent: ChatAgentName, text: string) => post<{ message_id: string; turn: ChatTurn | null }>("/api/chat", { agent, text, wait: true }),
  estate: () => get<EstateStatus>("/api/estate"),
  estateAudit: () => post<{ runId: string; status: string }>("/api/estate/audit"),
  journalFull: () => get<JournalEntry[]>("/api/journal"),
  approvals: () => get<QueuedApproval[]>("/api/approvals"),
  instructions: () => get<InstructionRow[]>("/api/instructions"),
  propose: () => post<{ runId: string; state: string; status: string }>("/api/proposal"),
  decide: (recId: string, decision: "approve" | "reject", bound: { max_quantity?: string | null; limit_price?: string | null }, note: string) =>
    post<{ runId: string; signalId: string }>(`/api/recommendation/${recId}/decide`, { decision, bound, note }),
  revoke: (insId: string, note: string) => post<{ replayed: boolean }>(`/api/instruction/${insId}/revoke`, { note }),
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
