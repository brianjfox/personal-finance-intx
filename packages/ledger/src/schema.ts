// Ledger schema and migrations.
//
// Every table that holds a message of the interchange is append-only:
// `BEFORE UPDATE` / `BEFORE DELETE` triggers abort. Corrections arrive as
// new rows (`supersedes`), resolutions as new rows, revocations as new
// rows. The only mutable table is `ledger_meta`.

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

const APPEND_ONLY_TABLES = [
  "batch",
  "fact",
  "finding",
  "resolution",
  "document",
  "recommendation",
  "approval",
  "instruction",
  "receipt",
  "journal_entry",
  "access_log",
  "ledger_event",
] as const;

function appendOnlyTriggers(table: string): string {
  return `
CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table}
BEGIN SELECT RAISE(ABORT, '${table} is append-only: UPDATE refused'); END;
CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table}
BEGIN SELECT RAISE(ABORT, '${table} is append-only: DELETE refused'); END;
`;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "phase-1-ledger",
    sql: `
CREATE TABLE ledger_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- A write batch: one writer, one transaction, idempotent by id. The
-- effect-context replay contract (BUILD_PLAN §8.9) is satisfied because a
-- second commit of the same batch id returns the first commit's fact ids.
CREATE TABLE batch (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  id           TEXT NOT NULL UNIQUE,
  writer       TEXT NOT NULL,
  committed_at TEXT NOT NULL,
  run_id       TEXT,
  step_id      TEXT,
  fact_ids     TEXT NOT NULL,            -- JSON array, in insertion order
  note         TEXT
);

CREATE TABLE fact (
  seq           INTEGER PRIMARY KEY AUTOINCREMENT,
  id            TEXT NOT NULL UNIQUE,     -- fact_<ulid>
  batch_id      TEXT NOT NULL REFERENCES batch(id),
  kind          TEXT NOT NULL,            -- account | balance | position | lot | transaction | tax_document | obligation | entity
  subject       TEXT NOT NULL,            -- acct.schwab.brokerage-1234
  key           TEXT NOT NULL,            -- identity within (kind, subject)
  payload       TEXT NOT NULL,            -- JSON, validated against @fin/contracts
  observed_at   TEXT NOT NULL,
  effective_at  TEXT NOT NULL,
  source_id     TEXT NOT NULL,
  source_doc_id TEXT,
  page          INTEGER,
  supersedes    TEXT REFERENCES fact(id),
  writer        TEXT NOT NULL,            -- owning principal; enforced at commit
  provisional   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX fact_asof ON fact(kind, subject, key, effective_at, observed_at);
CREATE INDEX fact_supersedes ON fact(supersedes);
CREATE INDEX fact_observed ON fact(observed_at);
CREATE INDEX fact_batch ON fact(batch_id);
CREATE INDEX fact_source_doc ON fact(source_doc_id);

CREATE TABLE finding (
  seq            INTEGER PRIMARY KEY AUTOINCREMENT,
  id             TEXT NOT NULL UNIQUE,
  kind           TEXT NOT NULL,
  code           TEXT NOT NULL,
  severity       TEXT NOT NULL,
  subject        TEXT NOT NULL,
  summary        TEXT NOT NULL,
  detail         TEXT NOT NULL,           -- JSON
  evidence       TEXT NOT NULL,           -- JSON array of fact ids
  before_ids     TEXT NOT NULL,           -- JSON array
  after_ids      TEXT NOT NULL,           -- JSON array
  requires_human INTEGER NOT NULL,
  emitted_by     TEXT NOT NULL,
  as_of          TEXT NOT NULL,
  provenance     TEXT NOT NULL,           -- JSON
  run_id         TEXT,
  step_id        TEXT,
  batch_id       TEXT                     -- idempotency key of the appending step (not a ledger batch)
);
CREATE INDEX finding_subject ON finding(subject, as_of);
CREATE INDEX finding_code ON finding(code);

CREATE TABLE resolution (
  seq             INTEGER PRIMARY KEY AUTOINCREMENT,
  id              TEXT NOT NULL UNIQUE,
  finding_id      TEXT NOT NULL REFERENCES finding(id),
  decision        TEXT NOT NULL,
  note            TEXT NOT NULL,
  decided_by      TEXT NOT NULL,
  decided_at      TEXT NOT NULL,
  resulting_facts TEXT NOT NULL           -- JSON array
);
CREATE INDEX resolution_finding ON resolution(finding_id);

CREATE TABLE document (
  seq            INTEGER PRIMARY KEY AUTOINCREMENT,
  id             TEXT NOT NULL UNIQUE,
  sha256         TEXT NOT NULL UNIQUE,
  mime           TEXT NOT NULL,
  bytes          INTEGER NOT NULL,
  filename       TEXT NOT NULL,
  kind           TEXT NOT NULL,
  pages          INTEGER,
  source_id      TEXT NOT NULL,
  institution_id TEXT,
  account_id     TEXT,
  tax_year       INTEGER,
  ingested_at    TEXT NOT NULL,
  ingested_by    TEXT NOT NULL
);

-- Governance chain (Phase 4 writes these; the schema exists from Phase 1).
CREATE TABLE recommendation (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  id         TEXT NOT NULL UNIQUE,
  from_agent TEXT NOT NULL,
  subject    TEXT NOT NULL,
  as_of      TEXT NOT NULL,
  expires    TEXT NOT NULL,
  body       TEXT NOT NULL                -- JSON (full Recommendation)
);
CREATE TABLE approval (
  seq               INTEGER PRIMARY KEY AUTOINCREMENT,
  id                TEXT NOT NULL UNIQUE,
  recommendation_id TEXT NOT NULL REFERENCES recommendation(id),
  signal_id         TEXT NOT NULL UNIQUE,
  signed_at         TEXT NOT NULL,
  expires           TEXT NOT NULL,
  body              TEXT NOT NULL
);
CREATE TABLE instruction (
  seq               INTEGER PRIMARY KEY AUTOINCREMENT,
  id                TEXT NOT NULL UNIQUE,
  approval_id       TEXT NOT NULL REFERENCES approval(id),
  recommendation_id TEXT NOT NULL REFERENCES recommendation(id),
  status            TEXT NOT NULL,
  issued_at         TEXT NOT NULL,
  body              TEXT NOT NULL
);
CREATE TABLE receipt (
  seq            INTEGER PRIMARY KEY AUTOINCREMENT,
  id             TEXT NOT NULL UNIQUE,
  instruction_id TEXT NOT NULL REFERENCES instruction(id),
  executed_at    TEXT NOT NULL,
  body           TEXT NOT NULL
);

CREATE TABLE journal_entry (
  seq     INTEGER PRIMARY KEY AUTOINCREMENT,
  id      TEXT NOT NULL UNIQUE,
  at      TEXT NOT NULL,
  kind    TEXT NOT NULL,
  subject TEXT,
  summary TEXT NOT NULL,
  detail  TEXT NOT NULL,                  -- JSON
  refs    TEXT NOT NULL,                  -- JSON array of ids
  author  TEXT NOT NULL
);

CREATE TABLE access_log (
  seq       INTEGER PRIMARY KEY AUTOINCREMENT,
  id        TEXT NOT NULL UNIQUE,
  at        TEXT NOT NULL,
  principal TEXT NOT NULL,
  resource  TEXT NOT NULL,
  action    TEXT NOT NULL,
  detail    TEXT,
  run_id    TEXT,
  step_id   TEXT
);

-- Outbox: "Emit events; Tax, Risk and Market agents wake on what changed."
CREATE TABLE ledger_event (
  seq     INTEGER PRIMARY KEY AUTOINCREMENT,
  id      TEXT NOT NULL UNIQUE,
  at      TEXT NOT NULL,
  kind    TEXT NOT NULL,                  -- facts.committed | findings.opened | finding.resolved | ...
  subject TEXT,
  payload TEXT NOT NULL                   -- JSON
);
${APPEND_ONLY_TABLES.map(appendOnlyTriggers).join("\n")}
`,
  },
  {
    version: 2,
    name: "phase-4-governance",
    sql: `
-- The Auditor's deterministic verdict per recommendation attempt
-- (slide 16). Append-only; one verdict per (recommendation, attempt).
CREATE TABLE audit_verdict (
  seq               INTEGER PRIMARY KEY AUTOINCREMENT,
  recommendation_id TEXT NOT NULL REFERENCES recommendation(id),
  attempt           INTEGER NOT NULL,
  cleared           INTEGER NOT NULL,
  at                TEXT NOT NULL,
  blocks            TEXT NOT NULL,        -- JSON AuditBlock[]
  figures           TEXT NOT NULL,        -- JSON
  UNIQUE(recommendation_id, attempt)
);

-- Instruction status transitions (revoked/expired) as appended events;
-- the instruction row itself is append-only, so current status =
-- initial row status folded with the latest event.
CREATE TABLE instruction_event (
  seq            INTEGER PRIMARY KEY AUTOINCREMENT,
  instruction_id TEXT NOT NULL REFERENCES instruction(id),
  at             TEXT NOT NULL,
  status         TEXT NOT NULL,           -- revoked | expired
  by             TEXT NOT NULL,
  note           TEXT,
  UNIQUE(instruction_id, status)
);
${["audit_verdict", "instruction_event"].map(appendOnlyTriggers).join("\n")}
`,
  },
];

export const APPEND_ONLY = APPEND_ONLY_TABLES;
