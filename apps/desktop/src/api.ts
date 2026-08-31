// Thin client over fin-host's localhost IPC.

export interface NetWorthLine {
  account_id: string; name: string; type: string; value: string; currency: string;
  basis: string; fact_ids: string[]; observed_at: string | null; provisional: boolean;
  display_value?: string | null;
}
export interface NetWorth {
  assets: string; liabilities: string; net_worth: string; currency: string; lines: NetWorthLine[]; provisional: boolean;
  as_of: { effective_at: string | null; observed_at: string | null };
  fx_missing?: string[];
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

export interface ConsolidatedPosition {
  symbol: string; name: string | null; asset_class: string; currency: string;
  accounts: number; account_ids: string[]; quantity: string; price: string | null;
  market_value: string | null; cost_basis: string | null; basis_complete: boolean;
  fact_ids: string[]; observed_at: string; provisional: boolean;
}

export interface InstitutionAccountRow {
  account_id: string; name: string; type: string; currency: string;
  value: string | null; observed_at: string | null; closed: boolean; ignored: boolean;
}
export interface InstitutionOverview {
  institution_id: string; name: string; adapter: string; enabled: boolean; managed: boolean;
  accounts: InstitutionAccountRow[]; problems: string[];
  consent_until: string | null; aspsp: { name: string; country: string } | null;
  category: string | null;
}
export interface InstitutionsOverview { institutions: InstitutionOverview[]; hasFacts: boolean }
export interface ProfileRelation { legal_name: string; relationship?: string; date_of_birth?: string | null; note?: string }
export interface ProfileRedacted {
  configured: boolean;
  person?: {
    legal_name: string; preferred_name?: string; date_of_birth?: string | null; ssn_last4: string | null;
    citizenship?: string; country_of_residence?: string; state_or_province?: string; marital_status?: string;
  };
  spouse?: ProfileRelation | null;
  children?: ProfileRelation[];
  others?: ProfileRelation[];
  preferred_currency?: string;
  updated_at?: string;
}
export interface ProfileSave {
  person: {
    legal_name: string; preferred_name?: string; date_of_birth?: string | null; ssn?: string | null;
    citizenship?: string; country_of_residence?: string; state_or_province?: string; marital_status?: string;
  };
  spouse?: ProfileRelation | null;
  children: ProfileRelation[];
  others: ProfileRelation[];
  preferred_currency?: string;
  clear_ssn?: boolean;
}

export interface ProviderRow { id: string; kind: "anthropic" | "openai-compatible"; label: string; base_url: string; model: string }
export interface InferenceState {
  version: "2";
  providers: ProviderRow[];
  default: string;
  tasks?: Record<string, string>;
  key_set: Record<string, boolean>;
  presets: Array<{ id: string; label: string; kind: "anthropic" | "openai-compatible"; base_url: string; model: string; keyless?: boolean }>;
}

export interface ManagedAccount {
  account_id: string; name: string; type: string; currency: string; value: string; updated_at: string; closed_at?: string;
}

// The session token from login; every request carries it. Identity is
// the SESSION's -- the host ignores anything else the client asserts.
let apiToken: string | null = null;
export function setApiToken(token: string | null): void {
  apiToken = token;
}
const userHeaders = (): Record<string, string> => (apiToken !== null ? { authorization: `Bearer ${apiToken}` } : {});

/** A 401 means the session died (host restart, expiry): back to the login screen. */
function handleUnauthorized(status: number): void {
  if (status === 401 && apiToken !== null) {
    apiToken = null;
    try {
      localStorage.removeItem("fin.token");
    } catch {
      /* private mode */
    }
    // The user gate listens and drops the session (a reload can be a
    // no-op inside the desktop webview).
    window.dispatchEvent(new Event("fin:unauthorized"));
  }
}

/** `encrypted` is the machine's at-rest truth: "volume" (per-user AES-256 store), "os-disk" (BitLocker), or "none". */
export interface UserInfo { id: string; name: string; created_at: string; password_set: boolean; encrypted: "volume" | "os-disk" | "none" }

async function get<T>(path: string): Promise<T> {
  const r = await fetch(path, { headers: userHeaders() });
  if (!r.ok) {
    handleUnauthorized(r.status);
    // Host errors carry a plain-words message; show it, not just the status.
    const body = await r.text().catch(() => "");
    let detail = body;
    try {
      detail = String((JSON.parse(body) as { error?: string }).error ?? body);
    } catch {
      /* not JSON */
    }
    throw new Error(detail !== "" ? detail : `${path}: ${r.status}`);
  }
  return (await r.json()) as T;
}
async function post<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json", ...userHeaders() }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  if (!r.ok) {
    handleUnauthorized(r.status);
    const text = await r.text().catch(() => "");
    let detail = text;
    try {
      detail = String((JSON.parse(text) as { error?: string }).error ?? text);
    } catch {
      /* not JSON */
    }
    throw new Error(detail !== "" ? detail : `${path}: ${r.status}`);
  }
  return (await r.json()) as T;
}

export interface HttpLogEntry {
  at: string; method: string; url: string;
  request_headers: Record<string, string>; request_body: string | null;
  status: number; response_headers: Record<string, string>; response_body: string; ms: number;
}
export interface FetchLogRecord { institution_id: string; at: string; via: string; ok: boolean; error?: string; entries: HttpLogEntry[] }

export interface LanStatus { enabled: boolean; addresses: string[] }

export interface CashFlowMonth { month: string; inflow: string; outflow: string; net: string; txns: number }
export interface CashFlowView {
  currency: string; months: CashFlowMonth[]; fx_missing: string[]; excluded_internal: number; provisional: boolean;
}

export const api = {
  netWorth: () => get<NetWorth>("/api/net-worth"),
  cashFlow: (months = 12) => get<CashFlowView>(`/api/cashflow?months=${months}`),
  institutionFetchLog: (id: string) => get<FetchLogRecord[]>(`/api/institution/${encodeURIComponent(id)}/fetch-log`),
  lanStatus: () => get<LanStatus>("/api/lan"),
  lanSet: (enabled: boolean) => post<LanStatus>("/api/lan", { enabled }),
  positions: () => get<Position[]>("/api/positions"),
  positionsConsolidated: () => get<ConsolidatedPosition[]>("/api/positions?consolidated=1"),
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
  taxProfileSave: (input: {
    tax_year: number; ordinary_rate: string; ltcg_rate: string; prior_year_tax: string;
    prior_year_agi_over_150k: boolean; withholding_annual: string; reserve_account: string; prestage_lead_days?: number;
  }) => post<{ tax_year: number }>("/api/tax-profile", input),
  accounts: () => get<Array<{ account_id: string; name: string; type: string; currency: string }>>("/api/accounts"),
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
  exportBreakGlass: () => post<{ dir: string; files: number; documents: number }>("/api/export"),
  health: () => get<{ ok: boolean; dataDir: string; platform: string }>("/api/health"),
  fx: () => get<{ to: string; date: string; rates: Record<string, string>; stale: boolean }>("/api/fx"),
  institutions: () => get<Array<{ institution_id: string; name: string; adapter: string; enabled?: boolean }>>("/api/institutions"),
  institutionsOverview: () => get<InstitutionsOverview>("/api/institutions-overview"),
  addInstitution: (name: string, mode: "managed" | "files", category?: "real_estate" | "crypto") =>
    post<{ institution_id: string; name: string; adapter: string }>("/api/institutions", { name, mode, ...(category !== undefined ? { category } : {}) }),
  deleteInstitution: (id: string) => post<{ removed: boolean }>(`/api/institution/${id}/delete`),
  setInstitutionEnabled: (id: string, enabled: boolean) => post<{ changed: boolean }>(`/api/institution/${id}/enabled`, { enabled }),
  refreshInstitution: (id: string) => post<{ runId: string; status: string }>(`/api/institution/${id}/refresh`),
  uploadInstitutionFile: async (id: string, filename: string, bytes: ArrayBuffer) => {
    const r = await fetch(`/api/institution/${id}/upload?filename=${encodeURIComponent(filename)}`, { method: "POST", headers: userHeaders(), body: bytes });
    if (!r.ok) throw new Error(`upload: ${r.status} ${await r.text()}`);
    return (await r.json()) as { filename: string; runId: string; status: string; problems: string[] };
  },
  managedAccounts: (id: string) => get<ManagedAccount[]>(`/api/institution/${id}/accounts`),
  saveManagedAccount: (id: string, input: { account_id?: string; name: string; type: string; currency?: string; value: string }) =>
    post<{ account: ManagedAccount; runId: string; status: string }>(`/api/institution/${id}/account`, input),
  removeManagedAccount: (id: string, accountId: string) =>
    post<{ runId: string; status: string }>(`/api/institution/${id}/remove-account`, { account_id: accountId }),
  setAccountIgnored: (accountId: string, ignored: boolean) => post<{ ok: boolean }>("/api/account/ignore", { account_id: accountId, ignored }),
  reorderInstitutions: (order: string[]) => post<{ changed: boolean }>("/api/institutions/reorder", { order }),
  seedDemo: () => post<{ institutions: number; runId: string; status: string }>("/api/demo"),
  openExternal: (url: string) => post<{ opened: boolean }>("/api/open", { url }),
  plaidStart: (input?: { name?: string; institution_id?: string }) =>
    post<{ link_token: string; hosted_link_url: string | null; auto_finish: boolean }>("/api/connect/plaid/start", input ?? {}),
  plaidPending: () => get<{ state: "none" | "waiting" | "done" | "failed"; detail: string | null }>("/api/connect/plaid/pending"),
  plaidComplete: (input: { name?: string; institution_id?: string; link_token?: string; public_token?: string }) =>
    post<{ institution_id: string; runId: string; status: string }>("/api/connect/plaid/complete", input),
  ebBanks: (country: string) => get<Array<{ name: string; country: string }>>(`/api/connect/eb/banks?country=${encodeURIComponent(country)}`),
  ebStart: (input: { name?: string; institution_id?: string; country: string; bank: string; redirect_url?: string }) =>
    post<{ url: string; state: string }>("/api/connect/eb/start", input),
  ebComplete: (input: { state: string; code: string }) =>
    post<{ institution_id: string; consent_until: string | null; runId: string; status: string }>("/api/connect/eb/complete", input),
  connectCoinbase: (input: { name?: string; institution_id?: string; api_key_name: string; private_key: string }) =>
    post<{ institution_id: string; runId: string; status: string }>("/api/connect/coinbase", input),
  connectKraken: (input: { name?: string; institution_id?: string; api_key: string; private_key: string }) =>
    post<{ institution_id: string; runId: string; status: string }>("/api/connect/kraken", input),
  connectWallet: (input: { name?: string; holdings: Array<{ value: string; label?: string; kind?: string }> }) =>
    post<{ institution_id: string; runId: string; status: string }>("/api/connect/wallet", input),
  profile: () => get<ProfileRedacted>("/api/profile"),
  profileExtract: (text: string) =>
    post<{
      person?: Partial<{ legal_name: string; preferred_name: string; date_of_birth: string; ssn: string; citizenship: string; country_of_residence: string; state_or_province: string; marital_status: string }>;
      spouse?: ProfileRelation | null;
      children?: ProfileRelation[];
      others?: ProfileRelation[];
      note?: string;
    }>("/api/profile/extract", { text }),
  profileSave: (input: ProfileSave) => post<ProfileRedacted>("/api/profile", input),
  renameInstitution: (id: string, name: string) => post<{ ok: boolean }>(`/api/institution/${id}/rename`, { name }),
  plaidTest: () => post<{ ok: boolean; detail: string }>("/api/plaid/test", {}),
  deleteAllData: () => post<{ ok: boolean }>("/api/delete-all-data", {}),
  users: () => get<{ multi_user: boolean; users: UserInfo[] }>("/api/users"),
  addUser: (name: string, password: string) => post<{ user: UserInfo; token: string | null }>("/api/users", { name, password }),
  login: (user: string, password: string) => post<{ token: string; user: UserInfo }>("/api/login", { user, password }),
  setPassword: (user: string, password: string) => post<{ user: UserInfo; token: string | null }>("/api/set-password", { user, password }),
  logout: () => post<{ ok: boolean }>("/api/logout", {}),
  renameMe: (name: string) => post<UserInfo>("/api/me/rename", { name }),
  changeMyPassword: (oldPassword: string, newPassword: string) => post<{ ok: boolean }>("/api/me/password", { old_password: oldPassword, new_password: newPassword }),
  inference: () => get<InferenceState>("/api/inference"),
  inferenceSave: (settings: InferenceState["providers"] extends unknown ? { version: "2"; providers: ProviderRow[]; default: string; tasks?: Record<string, string> } : never, keys?: Record<string, string>) =>
    post<InferenceState>("/api/inference", { settings, ...(keys !== undefined ? { keys } : {}) }),
  inferenceTest: (target?: { task?: string; provider?: string }) =>
    post<{ ok: boolean; detail: string }>("/api/inference/test", target ?? {}),
  credentials: () =>
    get<{
      slots: Array<{ id: string; label: string; note: string; configured: boolean; fields: Array<{ account: string; label: string; multiline: boolean; set: boolean }> }>;
      tokens: Array<{ institution_id: string; name: string; adapter: string; set: boolean }>;
    }>("/api/credentials"),
  credentialSet: (id: string, values: Record<string, string>) => post<{ saved: boolean }>("/api/credentials/set", { id, values }),
  credentialDelete: (id: string) => post<{ removed: boolean }>("/api/credentials/delete", { id }),
  connectionTokensDelete: (institutionId: string) => post<{ removed: number }>("/api/credentials/tokens/delete", { institution_id: institutionId }),
  ledgerLiveAccounts: () =>
    get<{
      found: boolean;
      accounts: Array<{ id: string; name: string; chain: string; balance: string | null; supported: boolean; reason?: string; holding?: { kind: string; value: string; label?: string } }>;
      error?: string;
      permission_denied?: boolean;
    }>("/api/ledgerlive/accounts"),
  walletDetect: (value: string) =>
    get<{ ok: true; kind: string; chain: string; value: string; note?: string; label?: string } | { ok: false; reason: string }>(
      `/api/wallet/detect?value=${encodeURIComponent(value)}`,
    ),
};

/** Display FX state: set once per refresh from /api/fx; money() converts DYNAMICALLY into it. */
let FX: { to: string; date: string; rates: Record<string, string>; stale: boolean } | null = null;
export function setFxRates(fx: typeof FX): void {
  FX = fx;
}
export function fxState(): typeof FX {
  return FX;
}

const fmt = (n: number, currency: string): string =>
  new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: 2 }).format(n);

/** Format for display, converted into the preferred currency when a rate exists; native otherwise. */
// The privacy veil (the title bar's eye): when on, every formatted
// financial figure shows *s instead of digits. Formatting still runs —
// only the rendered digits are hidden.
let MASKED = false;
try {
  MASKED = localStorage.getItem("fin.masked") === "1";
} catch {
  /* private mode */
}
export function setMasked(m: boolean): void {
  MASKED = m;
  try {
    localStorage.setItem("fin.masked", m ? "1" : "0");
  } catch {
    /* private mode */
  }
}
export function isMasked(): boolean {
  return MASKED;
}
/** Digits become *s while the veil is on; everything else passes through. */
export function maskDigits(s: string): string {
  return MASKED ? s.replace(/\d/g, "*") : s;
}

export function money(v: string | null | undefined, currency = "USD"): string {
  if (v === null || v === undefined) return "—";
  const n = Number(v);
  if (!Number.isFinite(n)) return maskDigits(v);
  if (FX !== null && currency !== FX.to) {
    const rate = FX.rates[currency];
    if (rate !== undefined) return maskDigits(fmt(n * Number(rate), FX.to));
  }
  return maskDigits(fmt(n, currency));
}

/** The native form, for showing alongside a converted figure. */
export function moneyNative(v: string | null | undefined, currency = "USD"): string {
  if (v === null || v === undefined) return "—";
  const n = Number(v);
  return maskDigits(Number.isFinite(n) ? fmt(n, currency) : v);
}
export function when(iso: string | null | undefined): string {
  if (!iso) return "—";
  return iso.replace("T", " ").replace(/\.\d{3}Z$/, "Z");
}
