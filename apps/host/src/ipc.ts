// IPC: a localhost HTTP/JSON surface for the GUI (BUILD_PLAN §4 `ipc.ts`).
// Read endpoints serve the ledger views; the two writes are "start a
// nightly" and "resolve a finding" (the operator's answer, appended and
// dated). Binds 127.0.0.1 only. Also serves the built GUI when present.

import fs from "node:fs";
import path from "node:path";

import { resolveFinding, views } from "@fin/ledger";
import { ResolutionDecision } from "@fin/contracts";
import { type } from "arktype";

import type { App } from "./app";

export interface IpcOptions {
  app: App;
  port?: number;
  hostname?: string;
  /** Directory holding the built GUI (index.html + assets). */
  guiDir?: string;
  operator?: string;
}

const ResolveBody = type({
  decision: ResolutionDecision,
  "note?": "string",
  "decided_by?": "string",
});

export function startIpc(opts: IpcOptions): ReturnType<typeof Bun.serve> {
  const { app } = opts;
  const operator = opts.operator ?? process.env["USER"] ?? "operator";
  const guiDir = opts.guiDir ?? null;
  const running = new Map<string, Promise<unknown>>();

  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body, null, 0), { status, headers: { "content-type": "application/json" } });
  const notFound = (): Response => json({ error: "not found" }, 404);

  const server = Bun.serve({
    hostname: opts.hostname ?? "127.0.0.1",
    port: opts.port ?? 7777,
    idleTimeout: 120,
    async fetch(req) {
      const url = new URL(req.url);
      const p = url.pathname;
      const q = url.searchParams;
      const asOf = { ...(q.get("effective_at") ? { effectiveAt: q.get("effective_at") as string } : {}), ...(q.get("observed_at") ? { observedAt: q.get("observed_at") as string } : {}) };
      try {
        if (p === "/api/health") return json({ ok: true, dataDir: app.dataDir, now: new Date().toISOString() });
        if (p === "/api/net-worth") return json(views.netWorth(app.ledger, asOf));
        if (p === "/api/accounts") return json(views.accounts(app.ledger, asOf));
        if (p === "/api/balances") return json(views.balances(app.ledger, asOf));
        if (p === "/api/positions") return json(views.positions(app.ledger, asOf));
        if (p === "/api/transactions") {
          const subject = q.get("subject");
          return json(views.transactions(app.ledger, { ...asOf, ...(subject ? { subject } : {}) }));
        }
        if (p === "/api/queue") return json(app.ledger.openFindings({ requiresHuman: true }));
        if (p === "/api/findings") return json(app.ledger.allFindings(Number(q.get("limit") ?? 200)));
        if (p === "/api/provisional") return json([...app.ledger.provisionalSubjects().keys()]);
        if (p === "/api/documents") return json(app.ledger.listDocuments());
        if (p === "/api/journal") return json(app.ledger.listJournal());
        if (p === "/api/access-log") return json(app.ledger.listAccess(Number(q.get("limit") ?? 200)));
        if (p === "/api/events") return json(app.ledger.eventsSince(Number(q.get("since") ?? 0)));
        if (p === "/api/batches") return json(app.ledger.listBatches());
        if (p === "/api/institutions") return json(app.institutions().entries);
        if (p === "/api/runs") return json(await app.listRuns());

        let m = /^\/api\/fact\/([A-Za-z0-9_.:-]+)$/.exec(p);
        if (m !== null) {
          const fact = app.ledger.getFact(m[1] as string);
          if (fact === null) return notFound();
          const doc = fact.source_doc_id === null ? null : app.ledger.getDocument(fact.source_doc_id);
          return json({ fact, history: app.ledger.history(fact.id), document: doc });
        }
        m = /^\/api\/finding\/([A-Za-z0-9_.:-]+)$/.exec(p);
        if (m !== null && req.method === "GET") {
          const f = app.ledger.getFinding(m[1] as string);
          if (f === null) return notFound();
          const facts = (ids: string[]) => ids.map((id) => app.ledger.getFact(id)).filter((x) => x !== null);
          return json({ finding: f, before: facts(f.before), after: facts(f.after), evidence: facts(f.evidence) });
        }
        m = /^\/api\/finding\/([A-Za-z0-9_.:-]+)\/resolve$/.exec(p);
        if (m !== null && req.method === "POST") {
          const body = ResolveBody(await req.json());
          if (body instanceof type.errors) return json({ error: body.summary }, 400);
          const r = resolveFinding(app.ledger, {
            findingId: m[1] as string,
            decision: body.decision,
            note: body.note ?? "",
            decidedBy: body.decided_by ?? operator,
            decidedAt: new Date().toISOString(),
          });
          return json(r);
        }
        m = /^\/api\/document\/([A-Za-z0-9_.:-]+)$/.exec(p);
        if (m !== null) {
          const d = app.ledger.getDocument(m[1] as string);
          if (d === null) return notFound();
          return json({ document: d, facts: app.ledger.factsFromDocument(d.id).map((f) => f.id) });
        }
        m = /^\/api\/document\/([A-Za-z0-9_.:-]+)\/bytes$/.exec(p);
        if (m !== null) {
          const d = app.ledger.getDocument(m[1] as string);
          if (d === null) return notFound();
          const bytes = app.vault.read(d.id, "operator");
          return new Response(bytes, { headers: { "content-type": d.mime, "content-disposition": `inline; filename="${d.filename}"` } });
        }
        m = /^\/api\/run\/([A-Za-z0-9_.:-]+)$/.exec(p);
        if (m !== null) {
          const events = await app.runEvents(m[1] as string);
          if (events.length === 0) return notFound();
          const summary = (await app.listRuns()).find((r) => r.runId === m![1]);
          return json({ summary, events });
        }
        if (p === "/api/nightly" && req.method === "POST") {
          const runId = `nightly_${new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15)}`;
          if (!running.has(runId)) {
            const promise = app.runNightly({ runId }).finally(() => running.delete(runId));
            running.set(runId, promise);
            if (q.get("wait") === "1") {
              const result = (await promise) as { terminalStatus: string };
              return json({ runId, status: result.terminalStatus });
            }
          }
          return json({ runId, status: "started" }, 202);
        }
        if (p.startsWith("/api/")) return notFound();

        // GUI
        if (guiDir !== null) {
          const rel = p === "/" ? "index.html" : p.replace(/^\/+/, "");
          const file = path.join(guiDir, rel);
          if (file.startsWith(guiDir) && fs.existsSync(file) && fs.statSync(file).isFile()) {
            return new Response(Bun.file(file));
          }
          const index = path.join(guiDir, "index.html");
          if (fs.existsSync(index)) return new Response(Bun.file(index));
        }
        return new Response("fin-host: GUI not built. Run `bun run build` in apps/desktop.", { status: 404 });
      } catch (e) {
        return json({ error: e instanceof Error ? e.message : String(e) }, 500);
      }
    },
  });
  return server;
}
