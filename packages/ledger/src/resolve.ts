// Resolving a finding: the operator's answer, appended and dated.
//
// Deck slide 15: "Resolved as a fact -- your answer is appended and dated;
// the history stays intact." A resolution never edits a fact. It appends a
// `resolution` row and, for every provisional incoming fact the finding
// points at, appends a superseding non-provisional fact:
//   accept_incoming / both  -> the incoming payload, now clean
//   keep_prior              -> the prior payload re-asserted at the incoming
//                              effective date (the feed was wrong)
//   dismiss                 -> incoming payload, now clean (nothing to fix)
//   custom                  -> caller-supplied payload per fact
// The superseding facts are written under the owning writer (one-writer
// rule) with provenance `operator.<who>`, so the ledger shows who decided.
//
// A held subject had EVERY fact of that night committed provisional, not
// only the disputed ones. Once no open finding holds the subject any more
// (`detail.holds`), the remaining provisional facts are released: each is
// superseded by a clean copy of itself. The hold lifts as a consequence of
// the operator's answers, never on its own.

import type { FactInput, ResolutionDecision } from "@fin/contracts";
import { writerOf } from "@fin/contracts";

import type { Ledger, StoredFact } from "./ledger";

export interface ResolveInput {
  findingId: string;
  decision: ResolutionDecision;
  note: string;
  decidedBy: string;
  decidedAt: string;
  /** For `custom`: replacement payloads keyed by incoming fact id. */
  custom?: Record<string, object>;
}

export interface ResolveResult {
  resolutionId: string;
  resultingFacts: string[];
}

export function resolveFinding(ledger: Ledger, input: ResolveInput): ResolveResult {
  const finding = ledger.getFinding(input.findingId);
  if (finding === null) throw new Error(`finding ${input.findingId} does not exist`);
  if (finding.resolved) throw new Error(`finding ${input.findingId} is already resolved`);

  const incoming = finding.after
    .map((id) => ledger.getFact(id))
    .filter((f): f is StoredFact => f !== null)
    .filter((f) => f.provisional && isCurrent(ledger, f.id));

  const byWriter = new Map<string, FactInput[]>();
  for (const f of incoming) {
    let payload: object = f.payload;
    if (input.decision === "keep_prior") {
      const prior = priorOf(ledger, finding.before, f);
      if (prior !== null) payload = prior.payload;
    } else if (input.decision === "custom") {
      const c = input.custom?.[f.id];
      if (c === undefined) throw new Error(`custom resolution missing payload for ${f.id}`);
      payload = c;
    }
    const next: FactInput = {
      kind: f.kind,
      subject: f.subject,
      key: f.key,
      payload,
      observed_at: input.decidedAt,
      effective_at: f.effective_at,
      source_id: `operator.${input.decidedBy}`,
      source_doc_id: f.source_doc_id,
      page: f.page ?? null,
      supersedes: f.id,
      writer: writerOf(f.kind),
      provisional: false,
    };
    const list = byWriter.get(next.writer) ?? [];
    list.push(next);
    byWriter.set(next.writer, list);
  }

  const resulting: string[] = [];
  ledger.db.transaction(() => {
    for (const [writer, facts] of byWriter) {
      const r = ledger.commit({
        batchId: `resolve:${input.findingId}:${writer}`,
        writer: writer as FactInput["writer"],
        facts,
        note: `resolution of ${input.findingId} (${input.decision}) by ${input.decidedBy}`,
      });
      resulting.push(...r.factIds);
    }
  })();
  // Release the subject's remaining provisional facts if nothing else holds it.
  const stillHeld = ledger
    .openFindings({ subject: finding.subject })
    .some((f) => f.id !== finding.id && f.detail["holds"] === true);
  if (!stillHeld) {
    const remaining = (ledger.provisionalSubjects().get(finding.subject) ?? []).filter(
      (f) => !incoming.some((i) => i.id === f.id),
    );
    const byW = new Map<string, FactInput[]>();
    for (const f of remaining) {
      const next: FactInput = {
        kind: f.kind,
        subject: f.subject,
        key: f.key,
        payload: f.payload,
        observed_at: input.decidedAt,
        effective_at: f.effective_at,
        source_id: `operator.${input.decidedBy}`,
        source_doc_id: f.source_doc_id,
        page: f.page ?? null,
        supersedes: f.id,
        writer: writerOf(f.kind),
        provisional: false,
      };
      const list = byW.get(next.writer) ?? [];
      list.push(next);
      byW.set(next.writer, list);
    }
    ledger.db.transaction(() => {
      for (const [writer, facts] of byW) {
        const r = ledger.commit({
          batchId: `release:${input.findingId}:${writer}`,
          writer: writer as FactInput["writer"],
          facts,
          note: `release of ${finding.subject} after ${input.findingId}`,
        });
        resulting.push(...r.factIds);
      }
    })();
  }

  const resolutionId = ledger.appendResolution({
    finding_id: input.findingId,
    decision: input.decision,
    note: input.note,
    decided_by: input.decidedBy,
    decided_at: input.decidedAt,
    resulting_facts: resulting,
  });
  ledger.appendJournal({
    at: input.decidedAt,
    kind: "resolution",
    subject: finding.subject,
    summary: `${finding.code}: ${input.decision}`,
    detail: { note: input.note, finding: finding.summary },
    refs: [input.findingId, ...resulting],
    author: input.decidedBy,
  });
  ledger.emitEvent({
    kind: "finding.resolved",
    subject: finding.subject,
    payload: { finding_id: input.findingId, decision: input.decision, resulting_facts: resulting },
  });
  return { resolutionId, resultingFacts: resulting };
}

function isCurrent(ledger: Ledger, id: string): boolean {
  const row = ledger.db
    .query<{ n: number }, [string]>("SELECT count(*) AS n FROM fact WHERE supersedes = ?")
    .get(id);
  return row === null || row.n === 0;
}

function priorOf(ledger: Ledger, before: string[], incoming: StoredFact): StoredFact | null {
  for (const id of before) {
    const f = ledger.getFact(id);
    if (f !== null && f.kind === incoming.kind && f.subject === incoming.subject && f.key === incoming.key) {
      return f;
    }
  }
  // Fall back to the latest clean fact for the same identity observed before the incoming one.
  const prev = ledger.asOf({
    kind: incoming.kind,
    subject: incoming.subject,
    key: incoming.key,
    observedAt: new Date(new Date(incoming.observed_at).getTime() - 1).toISOString(),
  });
  return prev[0] ?? null;
}
