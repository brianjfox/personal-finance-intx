// The ledger API.
//
// One `Ledger` per household database. Writes are batches (one writer, one
// SQLite transaction, idempotent by batch id); reads are as-of queries.
// The ledger never UPDATEs or DELETEs a fact (triggers refuse), validates
// every payload against `@fin/contracts`, and refuses a writer that does
// not own the kind (`FACT_WRITERS`).

import { Database, type SQLQueryBindings } from "bun:sqlite";
import { type } from "arktype";

import {
  AccessLogInput,
  ContractViolation,
  DocumentInput,
  FactInput,
  FindingInput,
  JournalEntryInput,
  newId,
  ResolutionInput,
  validateFactPayload,
  writerOf,
  type AccessLogEntry,
  type Document,
  type Fact,
  type FactKind,
  type Finding,
  type JournalEntry,
  type Principal,
  type Resolution,
} from "@fin/contracts";

import { MIGRATIONS } from "./schema";

export class WriterViolation extends Error {
  override readonly name = "WriterViolation";
}
export class AppendOnlyViolation extends Error {
  override readonly name = "AppendOnlyViolation";
}

export interface CommitInput {
  /** Idempotency key. The effect id of the committing action is the natural choice. */
  batchId: string;
  writer: Principal;
  facts: readonly FactInput[];
  runId?: string | null;
  stepId?: string | null;
  note?: string;
}

export interface CommitResult {
  batchId: string;
  factIds: string[];
  /** True when the batch already existed and nothing was written. */
  replayed: boolean;
}

export interface AsOfQuery {
  kind: FactKind;
  subject?: string;
  key?: string;
  /** Facts effective on or before this instant. Default: no bound. */
  effectiveAt?: string;
  /** Knowledge as of this instant: facts observed on or before it, supersessions observed on or before it. Default: now. */
  observedAt?: string;
  /** Include facts still marked provisional. Default true. */
  includeProvisional?: boolean;
}

/** The stored summary segments, absent (not undefined) on rows written before migration 4. */
function summaryPartsOf(raw: unknown): Pick<FindingRow, "summary_parts"> {
  return typeof raw === "string" ? { summary_parts: JSON.parse(raw) as NonNullable<Finding["summary_parts"]> } : {};
}

export interface FindingRow extends Finding {
  run_id: string | null;
  step_id: string | null;
  resolved: boolean;
  resolutions: Resolution[];
}

export interface LedgerEvent {
  seq: number;
  id: string;
  at: string;
  kind: string;
  subject: string | null;
  payload: unknown;
}

export interface LedgerOptions {
  clock?: () => Date;
  newId?: (prefix: string) => string;
}

const FACT_COLS =
  "id, kind, subject, key, payload, observed_at, effective_at, source_id, source_doc_id, page, supersedes, writer, provisional, batch_id, seq";

interface FactRow {
  id: string;
  kind: string;
  subject: string;
  key: string;
  payload: string;
  observed_at: string;
  effective_at: string;
  source_id: string;
  source_doc_id: string | null;
  page: number | null;
  supersedes: string | null;
  writer: string;
  provisional: number;
  batch_id: string;
  seq: number;
}

export interface StoredFact extends Fact {
  batch_id: string;
  seq: number;
}

function rowToFact(r: FactRow): StoredFact {
  return {
    id: r.id,
    kind: r.kind as FactKind,
    subject: r.subject,
    key: r.key,
    payload: JSON.parse(r.payload) as object,
    observed_at: r.observed_at,
    effective_at: r.effective_at,
    source_id: r.source_id,
    source_doc_id: r.source_doc_id,
    page: r.page,
    supersedes: r.supersedes,
    writer: r.writer as Principal,
    provisional: r.provisional === 1,
    batch_id: r.batch_id,
    seq: r.seq,
  };
}

export function openLedger(path: string, opts: LedgerOptions = {}): Ledger {
  return new Ledger(path, opts);
}

export class Ledger {
  readonly db: Database;
  private readonly clock: () => Date;
  private readonly mkId: (prefix: string) => string;

  constructor(path: string, opts: LedgerOptions = {}) {
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA synchronous = FULL");
    this.clock = opts.clock ?? (() => new Date());
    this.mkId = opts.newId ?? ((p) => newId(p));
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private now(): string {
    return this.clock().toISOString();
  }

  // --- migrations -----------------------------------------------------

  private migrate(): void {
    const has = this.db
      .query<{ n: number }, []>(
        "SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='ledger_meta'",
      )
      .get();
    let current = 0;
    if (has !== null && has.n > 0) {
      const row = this.db
        .query<{ value: string }, []>("SELECT value FROM ledger_meta WHERE key='schema_version'")
        .get();
      current = row === null ? 0 : Number(row.value);
    }
    for (const m of MIGRATIONS) {
      if (m.version <= current) continue;
      this.db.transaction(() => {
        this.db.exec(m.sql);
        this.db
          .query("INSERT OR REPLACE INTO ledger_meta(key, value) VALUES ('schema_version', ?)")
          .run(String(m.version));
      })();
    }
  }

  schemaVersion(): number {
    const row = this.db
      .query<{ value: string }, []>("SELECT value FROM ledger_meta WHERE key='schema_version'")
      .get();
    return row === null ? 0 : Number(row.value);
  }

  // --- facts: write ----------------------------------------------------

  /**
   * Append a batch of facts. Atomic, idempotent by `batchId`, one writer.
   * Validation order: writer owns every kind -> payload matches kind ->
   * `supersedes` names an existing fact of the same kind/subject/key.
   */
  commit(input: CommitInput): CommitResult {
    const existing = this.db
      .query<{ fact_ids: string; writer: string }, [string]>(
        "SELECT fact_ids, writer FROM batch WHERE id = ?",
      )
      .get(input.batchId);
    if (existing !== null) {
      if (existing.writer !== input.writer) {
        throw new WriterViolation(
          `batch ${input.batchId} was committed by ${existing.writer}, not ${input.writer}`,
        );
      }
      return {
        batchId: input.batchId,
        factIds: JSON.parse(existing.fact_ids) as string[],
        replayed: true,
      };
    }

    // Validate everything before touching the database.
    const validated: FactInput[] = [];
    for (const [i, raw] of input.facts.entries()) {
      const f = FactInput(raw);
      if (f instanceof type.errors) {
        throw new ContractViolation(`fact[${i}]`, f.summary);
      }
      if (f.writer !== input.writer) {
        throw new WriterViolation(
          `fact[${i}] names writer ${f.writer} but the batch writer is ${input.writer}`,
        );
      }
      const owner = writerOf(f.kind);
      if (owner !== input.writer) {
        throw new WriterViolation(
          `${input.writer} may not write ${f.kind} facts; owner is ${owner}`,
        );
      }
      const payload = validateFactPayload(f.kind, f.payload);
      if (payload instanceof type.errors) {
        throw new ContractViolation(`fact[${i}].payload (${f.kind})`, payload.summary);
      }
      validated.push(f);
    }

    const insertBatch = this.db.query(
      "INSERT INTO batch(id, writer, committed_at, run_id, step_id, fact_ids, note) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    const insertFact = this.db.query(
      `INSERT INTO fact(id, batch_id, kind, subject, key, payload, observed_at, effective_at, source_id, source_doc_id, page, supersedes, writer, provisional)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const getSup = this.db.query<{ kind: string; subject: string; key: string }, [string]>(
      "SELECT kind, subject, key FROM fact WHERE id = ?",
    );

    const factIds: string[] = [];
    this.db.transaction(() => {
      // Placeholder row first so fact.batch_id FK is satisfied; fact_ids filled below is
      // not possible on an append-only table, so we compute ids first.
      for (const _f of validated) factIds.push(this.mkId("fact"));
      insertBatch.run(
        input.batchId,
        input.writer,
        this.now(),
        input.runId ?? null,
        input.stepId ?? null,
        JSON.stringify(factIds),
        input.note ?? null,
      );
      validated.forEach((f, i) => {
        if (f.supersedes !== null) {
          const sup = getSup.get(f.supersedes);
          if (sup === null) {
            throw new ContractViolation(`fact[${i}].supersedes`, `${f.supersedes} does not exist`);
          }
          if (sup.kind !== f.kind || sup.subject !== f.subject || sup.key !== f.key) {
            throw new ContractViolation(
              `fact[${i}].supersedes`,
              `${f.supersedes} is (${sup.kind}, ${sup.subject}, ${sup.key}); a fact may only supersede one of its own kind/subject/key`,
            );
          }
        }
        insertFact.run(
          factIds[i] as string,
          input.batchId,
          f.kind,
          f.subject,
          f.key,
          JSON.stringify(f.payload),
          f.observed_at,
          f.effective_at,
          f.source_id,
          f.source_doc_id,
          f.page ?? null,
          f.supersedes,
          f.writer,
          f.provisional ? 1 : 0,
        );
      });
    })();
    return { batchId: input.batchId, factIds, replayed: false };
  }

  // --- facts: read -----------------------------------------------------

  getFact(id: string): StoredFact | null {
    const row = this.db
      .query<FactRow, [string]>(`SELECT ${FACT_COLS} FROM fact WHERE id = ?`)
      .get(id);
    return row === null ? null : rowToFact(row);
  }

  /** The supersession chain containing `id`, oldest first. */
  history(id: string): StoredFact[] {
    const chain: StoredFact[] = [];
    // walk back
    let cur = this.getFact(id);
    const back: StoredFact[] = [];
    while (cur !== null) {
      back.push(cur);
      cur = cur.supersedes === null ? null : this.getFact(cur.supersedes);
    }
    back.reverse();
    chain.push(...back);
    // walk forward (a fact may be superseded by at most one live chain; take all)
    const q = this.db.query<FactRow, [string]>(
      `SELECT ${FACT_COLS} FROM fact WHERE supersedes = ? ORDER BY seq`,
    );
    let frontier = [id];
    while (frontier.length > 0) {
      const next: string[] = [];
      for (const f of frontier) {
        for (const r of q.all(f)) {
          const sf = rowToFact(r);
          chain.push(sf);
          next.push(sf.id);
        }
      }
      frontier = next;
    }
    return chain;
  }

  /** Every fact in a batch, insertion order. */
  batchFacts(batchId: string): StoredFact[] {
    return this.db
      .query<FactRow, [string]>(`SELECT ${FACT_COLS} FROM fact WHERE batch_id = ? ORDER BY seq`)
      .all(batchId)
      .map(rowToFact);
  }

  /**
   * Current facts as of a point in (effective, observed) time: for each
   * (subject, key) the fact with the greatest `effective_at` <= effectiveAt
   * among those observed <= observedAt and not superseded by anything
   * observed <= observedAt. "What did we know on March 3rd about Feb 28?"
   */
  asOf(q: AsOfQuery): StoredFact[] {
    const observedAt = q.observedAt ?? "9999-12-31T23:59:59.999Z";
    const effectiveAt = q.effectiveAt ?? "9999-12-31T23:59:59.999Z";
    const includeProv = q.includeProvisional ?? true;
    const params: SQLQueryBindings[] = [q.kind, observedAt, effectiveAt, observedAt];
    let where = "";
    if (q.subject !== undefined) {
      where += " AND f.subject = ?";
      params.push(q.subject);
    }
    if (q.key !== undefined) {
      where += " AND f.key = ?";
      params.push(q.key);
    }
    if (!includeProv) where += " AND f.provisional = 0";
    const sql = `
      WITH cand AS (
        SELECT ${FACT_COLS.split(", ").map((c) => `f.${c}`).join(", ")}
        FROM fact f
        WHERE f.kind = ? AND f.observed_at <= ? AND f.effective_at <= ?
          AND NOT EXISTS (SELECT 1 FROM fact s WHERE s.supersedes = f.id AND s.observed_at <= ?)
          ${where}
      )
      SELECT * FROM cand c
      WHERE c.seq = (
        SELECT c2.seq FROM cand c2
        WHERE c2.subject = c.subject AND c2.key = c.key
        ORDER BY c2.effective_at DESC, c2.observed_at DESC, c2.seq DESC
        LIMIT 1
      )
      ORDER BY c.subject, c.key`;
    return this.db.query<FactRow, SQLQueryBindings[]>(sql).all(...params).map(rowToFact);
  }

  /** Current (latest, non-superseded) facts that are still provisional, grouped by subject. */
  provisionalSubjects(): Map<string, StoredFact[]> {
    const rows = this.db
      .query<FactRow, []>(
        `SELECT ${FACT_COLS} FROM fact f WHERE f.provisional = 1
         AND NOT EXISTS (SELECT 1 FROM fact s WHERE s.supersedes = f.id)
         ORDER BY subject, seq`,
      )
      .all()
      .map(rowToFact);
    const out = new Map<string, StoredFact[]>();
    for (const f of rows) {
      const list = out.get(f.subject) ?? [];
      list.push(f);
      out.set(f.subject, list);
    }
    return out;
  }

  isProvisional(subject: string): boolean {
    const row = this.db
      .query<{ n: number }, [string]>(
        `SELECT count(*) AS n FROM fact f WHERE f.subject = ? AND f.provisional = 1
         AND NOT EXISTS (SELECT 1 FROM fact s WHERE s.supersedes = f.id)`,
      )
      .get(subject);
    return row !== null && row.n > 0;
  }

  /** Facts from a given source document, for the drill-down "fact -> source document -> observed date". */
  factsFromDocument(docId: string): StoredFact[] {
    return this.db
      .query<FactRow, [string]>(`SELECT ${FACT_COLS} FROM fact WHERE source_doc_id = ? ORDER BY seq`)
      .all(docId)
      .map(rowToFact);
  }

  factCount(): number {
    return this.db.query<{ n: number }, []>("SELECT count(*) AS n FROM fact").get()?.n ?? 0;
  }

  // --- findings --------------------------------------------------------

  appendFinding(
    input: FindingInput,
    ctx: { runId?: string | null; stepId?: string | null; batchId?: string | null } = {},
  ): string {
    const f = FindingInput(input);
    if (f instanceof type.errors) throw new ContractViolation("finding", f.summary);
    const id = this.mkId("fnd");
    this.db
      .query(
        `INSERT INTO finding(id, kind, code, severity, subject, summary, summary_parts, detail, evidence, before_ids, after_ids, requires_human, emitted_by, as_of, provenance, run_id, step_id, batch_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        f.kind,
        f.code,
        f.severity,
        f.subject,
        f.summary,
        f.summary_parts === undefined ? null : JSON.stringify(f.summary_parts),
        JSON.stringify(f.detail),
        JSON.stringify(f.evidence),
        JSON.stringify(f.before),
        JSON.stringify(f.after),
        f.requires_human ? 1 : 0,
        f.emitted_by,
        f.as_of,
        JSON.stringify(f.provenance),
        ctx.runId ?? null,
        ctx.stepId ?? null,
        ctx.batchId ?? null,
      );
    return id;
  }

  /** Idempotent finding append: a batch id + index key dedupes across replay. */
  appendFindings(
    batchId: string,
    inputs: readonly FindingInput[],
    ctx: { runId?: string | null; stepId?: string | null } = {},
  ): string[] {
    const existing = this.db
      .query<{ id: string }, [string]>("SELECT id FROM finding WHERE batch_id = ? ORDER BY seq")
      .all(batchId)
      .map((r) => r.id);
    if (existing.length > 0) return existing;
    const ids: string[] = [];
    this.db.transaction(() => {
      for (const i of inputs) ids.push(this.appendFinding(i, { ...ctx, batchId }));
    })();
    return ids;
  }

  getFinding(id: string): FindingRow | null {
    const row = this.db
      .query<Record<string, unknown>, [string]>("SELECT * FROM finding WHERE id = ?")
      .get(id);
    return row === null ? null : this.rowToFinding(row);
  }

  /** Open findings = no resolution yet. `requiresHuman` narrows to the exception queue. */
  openFindings(opts: { requiresHuman?: boolean; subject?: string } = {}): FindingRow[] {
    const params: SQLQueryBindings[] = [];
    let where = "WHERE NOT EXISTS (SELECT 1 FROM resolution r WHERE r.finding_id = f.id)";
    if (opts.requiresHuman !== undefined) {
      where += " AND f.requires_human = ?";
      params.push(opts.requiresHuman ? 1 : 0);
    }
    if (opts.subject !== undefined) {
      where += " AND f.subject = ?";
      params.push(opts.subject);
    }
    return this.db
      .query<Record<string, unknown>, SQLQueryBindings[]>(
        `SELECT * FROM finding f ${where} ORDER BY seq DESC`,
      )
      .all(...params)
      .map((r) => this.rowToFinding(r));
  }

  allFindings(limit = 500): FindingRow[] {
    return this.db
      .query<Record<string, unknown>, [number]>("SELECT * FROM finding ORDER BY seq DESC LIMIT ?")
      .all(limit)
      .map((r) => this.rowToFinding(r));
  }

  private rowToFinding(r: Record<string, unknown>): FindingRow {
    const id = r["id"] as string;
    const resolutions = this.resolutionsFor(id);
    return {
      id,
      kind: r["kind"] as Finding["kind"],
      code: r["code"] as Finding["code"],
      severity: r["severity"] as Finding["severity"],
      subject: r["subject"] as string,
      summary: r["summary"] as string,
      ...summaryPartsOf(r["summary_parts"]),
      detail: JSON.parse(r["detail"] as string) as Record<string, unknown>,
      evidence: JSON.parse(r["evidence"] as string) as string[],
      before: JSON.parse(r["before_ids"] as string) as string[],
      after: JSON.parse(r["after_ids"] as string) as string[],
      requires_human: (r["requires_human"] as number) === 1,
      emitted_by: r["emitted_by"] as Principal,
      as_of: r["as_of"] as string,
      provenance: JSON.parse(r["provenance"] as string) as Finding["provenance"],
      run_id: (r["run_id"] as string | null) ?? null,
      step_id: (r["step_id"] as string | null) ?? null,
      resolved: resolutions.length > 0,
      resolutions,
    };
  }

  appendResolution(input: ResolutionInput): string {
    const r = ResolutionInput(input);
    if (r instanceof type.errors) throw new ContractViolation("resolution", r.summary);
    if (this.getFinding(r.finding_id) === null) {
      throw new ContractViolation("resolution.finding_id", `${r.finding_id} does not exist`);
    }
    const id = this.mkId("res");
    this.db
      .query(
        "INSERT INTO resolution(id, finding_id, decision, note, decided_by, decided_at, resulting_facts) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        id,
        r.finding_id,
        r.decision,
        r.note,
        r.decided_by,
        r.decided_at,
        JSON.stringify(r.resulting_facts),
      );
    return id;
  }

  resolutionsFor(findingId: string): Resolution[] {
    return this.db
      .query<Record<string, unknown>, [string]>(
        "SELECT * FROM resolution WHERE finding_id = ? ORDER BY seq",
      )
      .all(findingId)
      .map((r) => ({
        id: r["id"] as string,
        finding_id: r["finding_id"] as string,
        decision: r["decision"] as Resolution["decision"],
        note: r["note"] as string,
        decided_by: r["decided_by"] as string,
        decided_at: r["decided_at"] as string,
        resulting_facts: JSON.parse(r["resulting_facts"] as string) as string[],
      }));
  }

  // --- documents -------------------------------------------------------

  /** Append a document record; identical bytes (same sha256) return the existing id. */
  appendDocument(input: DocumentInput): { id: string; existed: boolean } {
    const d = DocumentInput(input);
    if (d instanceof type.errors) throw new ContractViolation("document", d.summary);
    const existing = this.db
      .query<{ id: string }, [string]>("SELECT id FROM document WHERE sha256 = ?")
      .get(d.sha256);
    if (existing !== null) return { id: existing.id, existed: true };
    const id = this.mkId("doc");
    this.db
      .query(
        `INSERT INTO document(id, sha256, mime, bytes, filename, kind, pages, source_id, institution_id, account_id, tax_year, ingested_at, ingested_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        d.sha256,
        d.mime,
        d.bytes,
        d.filename,
        d.kind,
        d.pages,
        d.source_id,
        d.institution_id ?? null,
        d.account_id ?? null,
        d.tax_year ?? null,
        d.ingested_at,
        d.ingested_by,
      );
    return { id, existed: false };
  }

  getDocument(id: string): Document | null {
    const r = this.db
      .query<Record<string, unknown>, [string]>("SELECT * FROM document WHERE id = ?")
      .get(id);
    return r === null ? null : rowToDocument(r);
  }

  documentBySha(sha256: string): Document | null {
    const r = this.db
      .query<Record<string, unknown>, [string]>("SELECT * FROM document WHERE sha256 = ?")
      .get(sha256);
    return r === null ? null : rowToDocument(r);
  }

  listDocuments(limit = 500): Document[] {
    return this.db
      .query<Record<string, unknown>, [number]>("SELECT * FROM document ORDER BY seq DESC LIMIT ?")
      .all(limit)
      .map(rowToDocument);
  }

  // --- journal, access log, events --------------------------------------

  appendJournal(input: JournalEntryInput): string {
    const j = JournalEntryInput(input);
    if (j instanceof type.errors) throw new ContractViolation("journal_entry", j.summary);
    const id = this.mkId("jrn");
    this.db
      .query(
        "INSERT INTO journal_entry(id, at, kind, subject, summary, detail, refs, author) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        id,
        j.at,
        j.kind,
        j.subject ?? null,
        j.summary,
        JSON.stringify(j.detail),
        JSON.stringify(j.refs),
        j.author,
      );
    return id;
  }

  listJournal(limit = 200): JournalEntry[] {
    return this.db
      .query<Record<string, unknown>, [number]>(
        "SELECT * FROM journal_entry ORDER BY seq DESC LIMIT ?",
      )
      .all(limit)
      .map((r) => ({
        id: r["id"] as string,
        at: r["at"] as string,
        kind: r["kind"] as JournalEntry["kind"],
        subject: (r["subject"] as string | null) ?? null,
        summary: r["summary"] as string,
        detail: JSON.parse(r["detail"] as string) as Record<string, unknown>,
        refs: JSON.parse(r["refs"] as string) as string[],
        author: r["author"] as string,
      }));
  }

  logAccess(input: AccessLogInput): string {
    const a = AccessLogInput(input);
    if (a instanceof type.errors) throw new ContractViolation("access_log", a.summary);
    const id = this.mkId("acc");
    this.db
      .query(
        "INSERT INTO access_log(id, at, principal, resource, action, detail, run_id, step_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        id,
        a.at,
        a.principal,
        a.resource,
        a.action,
        a.detail ?? null,
        a.run_id ?? null,
        a.step_id ?? null,
      );
    return id;
  }

  listAccess(limit = 500): AccessLogEntry[] {
    return this.db
      .query<Record<string, unknown>, [number]>("SELECT * FROM access_log ORDER BY seq DESC LIMIT ?")
      .all(limit)
      .map((r) => ({
        id: r["id"] as string,
        at: r["at"] as string,
        principal: r["principal"] as Principal,
        resource: r["resource"] as string,
        action: r["action"] as AccessLogEntry["action"],
        ...(r["detail"] === null ? {} : { detail: r["detail"] as string }),
        run_id: (r["run_id"] as string | null) ?? null,
        step_id: (r["step_id"] as string | null) ?? null,
      }));
  }

  /** Append to the outbox. Idempotent by `id` when the caller supplies one. */
  emitEvent(ev: { id?: string; kind: string; subject?: string | null; payload: unknown }): string {
    const id = ev.id ?? this.mkId("evt");
    const exists = this.db
      .query<{ n: number }, [string]>("SELECT count(*) AS n FROM ledger_event WHERE id = ?")
      .get(id);
    if (exists !== null && exists.n > 0) return id;
    this.db
      .query("INSERT INTO ledger_event(id, at, kind, subject, payload) VALUES (?, ?, ?, ?, ?)")
      .run(id, this.now(), ev.kind, ev.subject ?? null, JSON.stringify(ev.payload));
    return id;
  }

  eventsSince(seq: number, limit = 1000): LedgerEvent[] {
    return this.db
      .query<
        { seq: number; id: string; at: string; kind: string; subject: string | null; payload: string },
        [number, number]
      >("SELECT seq, id, at, kind, subject, payload FROM ledger_event WHERE seq > ? ORDER BY seq LIMIT ?")
      .all(seq, limit)
      .map((r) => ({ ...r, payload: JSON.parse(r.payload) as unknown }));
  }

  // --- governance (Phase 4 writes; Phase 1 schema + minimal access) -------

  listBatches(limit = 100): Array<{
    id: string;
    writer: string;
    committed_at: string;
    run_id: string | null;
    step_id: string | null;
    fact_ids: string[];
    note: string | null;
  }> {
    return this.db
      .query<Record<string, unknown>, [number]>("SELECT * FROM batch ORDER BY seq DESC LIMIT ?")
      .all(limit)
      .map((r) => ({
        id: r["id"] as string,
        writer: r["writer"] as string,
        committed_at: r["committed_at"] as string,
        run_id: (r["run_id"] as string | null) ?? null,
        step_id: (r["step_id"] as string | null) ?? null,
        fact_ids: JSON.parse(r["fact_ids"] as string) as string[],
        note: (r["note"] as string | null) ?? null,
      }));
  }
}

function rowToDocument(r: Record<string, unknown>): Document {
  return {
    id: r["id"] as string,
    sha256: r["sha256"] as string,
    mime: r["mime"] as string,
    bytes: r["bytes"] as number,
    filename: r["filename"] as string,
    kind: r["kind"] as Document["kind"],
    pages: (r["pages"] as number | null) ?? null,
    source_id: r["source_id"] as string,
    institution_id: (r["institution_id"] as string | null) ?? null,
    account_id: (r["account_id"] as string | null) ?? null,
    tax_year: (r["tax_year"] as number | null) ?? null,
    ingested_at: r["ingested_at"] as string,
    ingested_by: r["ingested_by"] as Principal,
  };
}
