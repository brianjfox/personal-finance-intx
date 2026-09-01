// Governance-chain access (Phase 4): recommendations, audit verdicts,
// approvals, instructions -- the typed message chain of deck slide 12,
// stored append-only, every append idempotent so a crash-replayed
// handler lands exactly one row.
//
//   Fact -> Finding -> Recommendation -> Approval -> Instruction -> Receipt
//                                            ^
//                                  awaitSignal -- the only path
//
// Receipts arrive in Phase 5; everything else lives here.

import { type } from "arktype";

import {
  Approval,
  AuditVerdict,
  ContractViolation,
  Instruction,
  Recommendation,
  type Severity,
} from "@fin/contracts";

import type { Ledger } from "./ledger";

function validate<T>(schema: { (data: unknown): T | type.errors }, data: unknown, what: string): T {
  const out = schema(data);
  if (out instanceof type.errors) throw new ContractViolation(what, out.summary);
  return out;
}

/** Idempotent by `rec.id`: a replay returns the stored row unchanged. */
export function appendRecommendation(ledger: Ledger, rec: Recommendation): { id: string; replayed: boolean } {
  const r = validate(Recommendation, rec, "recommendation");
  const existing = ledger.db.query<{ body: string }, [string]>("SELECT body FROM recommendation WHERE id = ?").get(r.id);
  if (existing !== null) return { id: r.id, replayed: true };
  ledger.db
    .query("INSERT INTO recommendation(id, from_agent, subject, as_of, expires, body) VALUES (?, ?, ?, ?, ?, ?)")
    .run(r.id, r.from, r.subject, r.as_of, r.expires, JSON.stringify(r));
  return { id: r.id, replayed: false };
}

export function getRecommendation(ledger: Ledger, id: string): Recommendation | null {
  const row = ledger.db.query<{ body: string }, [string]>("SELECT body FROM recommendation WHERE id = ?").get(id);
  return row === null ? null : (JSON.parse(row.body) as Recommendation);
}

export function listRecommendations(ledger: Ledger, limit = 200): Recommendation[] {
  return ledger.db
    .query<{ body: string }, [number]>("SELECT body FROM recommendation ORDER BY seq DESC LIMIT ?")
    .all(limit)
    .map((r) => JSON.parse(r.body) as Recommendation);
}

/** Idempotent by (recommendation_id, attempt). */
export function appendAuditVerdict(ledger: Ledger, verdict: AuditVerdict): { replayed: boolean } {
  const v = validate(AuditVerdict, verdict, "audit verdict");
  const existing = ledger.db
    .query<{ seq: number }, [string, number]>("SELECT seq FROM audit_verdict WHERE recommendation_id = ? AND attempt = ?")
    .get(v.recommendation_id, v.attempt);
  if (existing !== null) return { replayed: true };
  ledger.db
    .query("INSERT INTO audit_verdict(recommendation_id, attempt, cleared, at, blocks, figures, caveats) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(v.recommendation_id, v.attempt, v.cleared ? 1 : 0, v.as_of, JSON.stringify(v.blocks), JSON.stringify(v.figures), JSON.stringify(v.caveats ?? []));
  return { replayed: false };
}

export function verdictsFor(ledger: Ledger, recommendationId: string): AuditVerdict[] {
  return ledger.db
    .query<{ recommendation_id: string; attempt: number; cleared: number; at: string; blocks: string; figures: string; caveats: string }, [string]>(
      "SELECT recommendation_id, attempt, cleared, at, blocks, figures, caveats FROM audit_verdict WHERE recommendation_id = ? ORDER BY attempt",
    )
    .all(recommendationId)
    .map((r) => ({
      recommendation_id: r.recommendation_id,
      attempt: r.attempt,
      cleared: r.cleared === 1,
      blocks: JSON.parse(r.blocks) as AuditVerdict["blocks"],
      caveats: JSON.parse(r.caveats) as NonNullable<AuditVerdict["caveats"]>,
      as_of: r.at,
      figures: JSON.parse(r.figures) as Record<string, unknown>,
    }));
}

/**
 * Idempotent by `signal_id` (the deterministic id derived from the
 * recommendation id): delivering the same approval signal twice lands
 * exactly one row -- a double-click cannot double-approve (D-001).
 */
export function appendApproval(ledger: Ledger, approval: Approval): { id: string; replayed: boolean } {
  const a = validate(Approval, approval, "approval");
  const existing = ledger.db.query<{ id: string }, [string]>("SELECT id FROM approval WHERE signal_id = ?").get(a.signal_id);
  if (existing !== null) return { id: existing.id, replayed: true };
  ledger.db
    .query("INSERT INTO approval(id, recommendation_id, signal_id, signed_at, expires, body) VALUES (?, ?, ?, ?, ?, ?)")
    .run(a.id, a.recommendation_id, a.signal_id, a.signed_at, a.expires, JSON.stringify(a));
  return { id: a.id, replayed: false };
}

export function approvalFor(ledger: Ledger, recommendationId: string): Approval | null {
  const row = ledger.db
    .query<{ body: string }, [string]>("SELECT body FROM approval WHERE recommendation_id = ? ORDER BY seq DESC LIMIT 1")
    .get(recommendationId);
  return row === null ? null : (JSON.parse(row.body) as Approval);
}

/** Idempotent by `instruction.id` (derived deterministically from the approval). */
export function appendInstruction(ledger: Ledger, instruction: Instruction): { id: string; replayed: boolean } {
  const i = validate(Instruction, instruction, "instruction");
  const existing = ledger.db.query<{ id: string }, [string]>("SELECT id FROM instruction WHERE id = ?").get(i.id);
  if (existing !== null) return { id: i.id, replayed: true };
  ledger.db
    .query("INSERT INTO instruction(id, approval_id, recommendation_id, status, issued_at, body) VALUES (?, ?, ?, ?, ?, ?)")
    .run(i.id, i.approval_id, i.recommendation_id, i.status, i.issued_at, JSON.stringify(i));
  return { id: i.id, replayed: false };
}

export interface InstructionRow extends Instruction {
  /** Folded with instruction_event rows: prepared | revoked | expired. */
  current_status: Instruction["status"];
}

export function listInstructions(ledger: Ledger, limit = 200): InstructionRow[] {
  const rows = ledger.db
    .query<{ id: string; body: string }, [number]>("SELECT id, body FROM instruction ORDER BY seq DESC LIMIT ?")
    .all(limit);
  return rows.map((r) => {
    const i = JSON.parse(r.body) as Instruction;
    const ev = ledger.db
      .query<{ status: string }, [string]>("SELECT status FROM instruction_event WHERE instruction_id = ? ORDER BY seq DESC LIMIT 1")
      .get(r.id);
    return { ...i, current_status: (ev?.status as Instruction["status"] | undefined) ?? i.status };
  });
}

/** Append a status transition; idempotent per (instruction, status). */
export function markInstruction(
  ledger: Ledger,
  opts: { instructionId: string; status: "revoked" | "expired"; by: string; note?: string; at: string },
): { replayed: boolean } {
  const exists = ledger.db.query<{ id: string }, [string]>("SELECT id FROM instruction WHERE id = ?").get(opts.instructionId);
  if (exists === null) throw new ContractViolation("instruction_event.instruction_id", `${opts.instructionId} does not exist`);
  const prior = ledger.db
    .query<{ seq: number }, [string, string]>("SELECT seq FROM instruction_event WHERE instruction_id = ? AND status = ?")
    .get(opts.instructionId, opts.status);
  if (prior !== null) return { replayed: true };
  ledger.db
    .query("INSERT INTO instruction_event(instruction_id, at, status, by, note) VALUES (?, ?, ?, ?, ?)")
    .run(opts.instructionId, opts.at, opts.status, opts.by, opts.note ?? null);
  return { replayed: false };
}

// --- the approval queue -------------------------------------------------

export interface QueuedApproval {
  recommendation: Recommendation;
  verdict: AuditVerdict;
  severity: Severity;
}

/**
 * The home screen's top half (deck slide 19): recommendations whose
 * LATEST verdict cleared, still inside their window, with no approval
 * row and no decision/expiry event yet.
 */
export function approvalQueue(ledger: Ledger, now: Date): QueuedApproval[] {
  const nowIso = now.toISOString();
  const decided = new Set<string>();
  for (const e of ledger.eventsSince(0, 50_000)) {
    if (e.kind === "proposal.rejected" || e.kind === "proposal.expired") {
      const p = e.payload as { recommendation_id?: string; recommendation_ids?: string[] };
      if (p.recommendation_id !== undefined) decided.add(p.recommendation_id);
      for (const rid of p.recommendation_ids ?? []) decided.add(rid);
    }
  }
  const out: QueuedApproval[] = [];
  for (const rec of listRecommendations(ledger, 500)) {
    if (rec.expires <= nowIso) continue;
    if (decided.has(rec.id)) continue;
    if (approvalFor(ledger, rec.id) !== null) continue;
    const verdicts = verdictsFor(ledger, rec.id);
    const latest = verdicts.at(-1);
    if (latest === undefined || !latest.cleared) continue;
    out.push({ recommendation: rec, verdict: latest, severity: "high" });
  }
  return out;
}
