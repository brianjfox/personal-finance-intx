// IPC: a localhost HTTP/JSON surface for the GUI (BUILD_PLAN §4 `ipc.ts`).
// Read endpoints serve the ledger views; the two writes are "start a
// nightly" and "resolve a finding" (the operator's answer, appended and
// dated). Binds 127.0.0.1 only. Also serves the built GUI when present.

import fs from "node:fs";
import path from "node:path";

import { resolveFinding, views } from "@fin/ledger";
import { AccountType, ChatAgent, ProjectionRequest, ResolutionDecision, ScenarioRequest, TaxStage } from "@fin/contracts";
import { WalletHolding } from "@fin/institutions";
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

const TaxYearBody = type({ "year?": "number.integer >= 1990" });
const TaxCheckBody = type({ quarter: "1 <= number.integer <= 4", stage: TaxStage });
const TaxSkipBody = type({ quarter: "1 <= number.integer <= 4", stage: TaxStage, "note?": "string" });
const ChatBody = type({ agent: ChatAgent, text: "string > 0", "wait?": "boolean" });
const DecideBody = type({
  decision: "'approve' | 'reject'",
  "bound?": type({ "max_quantity?": "string | null", "limit_price?": "string | null" }),
  "note?": "string",
});
const AddInstitutionBody = type({ name: "string > 0", mode: "'managed' | 'files'" });
const EnabledBody = type({ enabled: "boolean" });
const ManagedAccountBody = type({
  "account_id?": "string",
  name: "string > 0",
  type: AccountType,
  "currency?": /^[A-Z0-9]{2,10}$/,
  value: /^-?\d+(\.\d+)?$/,
});
const RemoveAccountBody = type({ account_id: "string > 0" });
const PlaidCompleteBody = type({ "name?": "string > 0", "institution_id?": "string > 0", "link_token?": "string > 0", "public_token?": "string > 0" });
const EbStartBody = type({ "name?": "string > 0", "institution_id?": "string > 0", country: /^[A-Z]{2}$/, bank: "string > 0", "redirect_url?": "string > 0" });
const EbCompleteBody = type({ state: "string > 0", code: "string > 0" });
const OpenBody = type({ url: /^https:\/\/[^\s]+$/ });
const CoinbaseBody = type({
  "name?": "string > 0",
  "institution_id?": "string > 0",
  // Optional: a pasted CDP key file (JSON in private_key) carries its own name.
  "api_key_name?": "string",
  private_key: "string > 0",
});
const WalletBody = type({
  "name?": "string > 0",
  holdings: WalletHolding.array().atLeastLength(1),
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
        if (p === "/api/institutions" && req.method === "GET") return json(app.institutions().entries);
        if (p === "/api/institutions-overview") return json(app.institutionsOverview());
        if (p === "/api/institutions" && req.method === "POST") {
          const body = AddInstitutionBody(await req.json());
          if (body instanceof type.errors) return json({ error: body.summary }, 400);
          return json(app.addInstitution(body), 201);
        }
        if (p === "/api/demo" && req.method === "POST") return json(await app.seedDemoData());
        // The GUI runs inside the Tauri webview, where window.open() to an
        // external site is blocked -- the host opens the default browser.
        if (p === "/api/open" && req.method === "POST") {
          const body = OpenBody(await req.json());
          if (body instanceof type.errors) return json({ error: body.summary }, 400);
          const cmd = process.platform === "darwin" ? "open" : "xdg-open";
          const proc = Bun.spawn([cmd, body.url], { stdout: "ignore", stderr: "ignore" });
          return json({ opened: (await proc.exited) === 0 });
        }
        if (p === "/api/connect/plaid/start" && req.method === "POST") return json(await app.connectPlaidStart());
        if (p === "/api/connect/plaid/complete" && req.method === "POST") {
          const body = PlaidCompleteBody(await req.json().catch(() => ({})));
          if (body instanceof type.errors) return json({ error: body.summary }, 400);
          return json(
            await app.connectPlaidComplete({
              ...(body.name !== undefined ? { name: body.name } : {}),
              ...(body.institution_id !== undefined ? { institutionId: body.institution_id } : {}),
              ...(body.link_token !== undefined ? { linkToken: body.link_token } : {}),
              ...(body.public_token !== undefined ? { publicToken: body.public_token } : {}),
            }),
          );
        }
        if (p === "/api/connect/eb/banks") {
          const country = (q.get("country") ?? "").toUpperCase();
          if (!/^[A-Z]{2}$/.test(country)) return json({ error: "country must be a two-letter code" }, 400);
          return json(await app.ebListBanks(country));
        }
        if (p === "/api/connect/eb/start" && req.method === "POST") {
          const body = EbStartBody(await req.json());
          if (body instanceof type.errors) return json({ error: body.summary }, 400);
          return json(
            await app.connectEbStart({
              ...(body.name !== undefined ? { name: body.name } : {}),
              ...(body.institution_id !== undefined ? { institutionId: body.institution_id } : {}),
              country: body.country,
              bank: body.bank,
              ...(body.redirect_url !== undefined ? { redirectUrl: body.redirect_url } : {}),
            }),
          );
        }
        if (p === "/api/connect/eb/complete" && req.method === "POST") {
          const body = EbCompleteBody(await req.json());
          if (body instanceof type.errors) return json({ error: body.summary }, 400);
          return json(await app.connectEbComplete({ state: body.state, code: body.code }));
        }
        if (p === "/api/connect/coinbase" && req.method === "POST") {
          const body = CoinbaseBody(await req.json());
          if (body instanceof type.errors) return json({ error: body.summary }, 400);
          return json(
            await app.connectCoinbase({
              ...(body.name !== undefined ? { name: body.name } : {}),
              ...(body.institution_id !== undefined ? { institutionId: body.institution_id } : {}),
              apiKeyName: body.api_key_name ?? "",
              privateKey: body.private_key,
            }),
          );
        }
        if (p === "/api/connect/wallet" && req.method === "POST") {
          const body = WalletBody(await req.json());
          if (body instanceof type.errors) return json({ error: body.summary }, 400);
          return json(await app.connectWallet({ ...(body.name !== undefined ? { name: body.name } : {}), holdings: body.holdings }));
        }
        const instMatch = /^\/api\/institution\/([A-Za-z0-9_.-]+)\/(delete|enabled|refresh|upload|accounts|account|remove-account)$/.exec(p);
        if (instMatch !== null) {
          const instId = instMatch[1] as string;
          const sub = instMatch[2] as string;
          if (sub === "accounts" && req.method === "GET") return json(app.managedAccounts(instId));
          if (req.method === "POST") {
            if (sub === "delete") return json({ removed: app.removeInstitution(instId) });
            if (sub === "refresh") return json(await app.refreshInstitution(instId));
            if (sub === "enabled") {
              const body = EnabledBody(await req.json());
              if (body instanceof type.errors) return json({ error: body.summary }, 400);
              return json({ changed: app.setInstitutionEnabled(instId, body.enabled) });
            }
            if (sub === "upload") {
              const filename = q.get("filename") ?? "upload.json";
              const bytes = new Uint8Array(await req.arrayBuffer());
              if (bytes.length === 0) return json({ error: "empty file" }, 400);
              const stored = app.storeInstitutionFile(instId, filename, bytes);
              const run = await app.refreshInstitution(instId);
              const problems = app.ledger
                .openFindings({ subject: instId })
                .filter((f) => f.code === "fetch_failed")
                .map((f) => f.summary);
              return json({ ...stored, ...run, problems });
            }
            if (sub === "account") {
              const body = ManagedAccountBody(await req.json());
              if (body instanceof type.errors) return json({ error: body.summary }, 400);
              return json(await app.saveManagedAccount(instId, body));
            }
            if (sub === "remove-account") {
              const body = RemoveAccountBody(await req.json());
              if (body instanceof type.errors) return json({ error: body.summary }, 400);
              return json(await app.removeManagedAccount(instId, body.account_id));
            }
          }
        }
        if (p === "/api/runs") return json(await app.listRuns());
        if (p === "/api/obligations") return json(views.obligations(app.ledger));
        if (p === "/api/tax") return json(await app.taxStatus());
        if (p === "/api/tax-year" && req.method === "POST") {
          const body = TaxYearBody(await req.json().catch(() => ({})));
          if (body instanceof type.errors) return json({ error: body.summary }, 400);
          return json(await app.startTaxYear(body.year !== undefined ? { year: body.year } : {}), 202);
        }
        if (p === "/api/tax/check" && req.method === "POST") {
          const body = TaxCheckBody(await req.json());
          if (body instanceof type.errors) return json({ error: body.summary }, 400);
          const r = await app.runTaxCheck({ quarter: body.quarter as 1 | 2 | 3 | 4, stage: body.stage });
          return json({ runId: r.runId, status: r.terminalStatus });
        }
        if (p === "/api/estate") return json(app.estateStatus());
        if (p === "/api/export" && req.method === "POST") {
          const r = app.exportBreakGlass();
          return json({ dir: r.dir, files: r.files.length, documents: r.documents });
        }
        if (p === "/api/approvals") return json(app.approvalQueue());
        if (p === "/api/instructions") return json(app.listPreparedInstructions());
        if (p === "/api/proposal" && req.method === "POST") {
          const r = await app.startProposal();
          return json(r, r.state === "queued" ? 200 : 202);
        }
        const decideMatch = /^\/api\/recommendation\/([A-Za-z0-9_.:-]+)\/decide$/.exec(p);
        if (decideMatch !== null && req.method === "POST") {
          const body = DecideBody(await req.json());
          if (body instanceof type.errors) return json({ error: body.summary }, 400);
          const r = await app.decideRecommendation({
            recommendationId: decideMatch[1] as string,
            decision: body.decision,
            ...(body.bound !== undefined ? { bound: body.bound } : {}),
            ...(body.note !== undefined ? { note: body.note } : {}),
            signedBy: operator,
          });
          return json(r);
        }
        const revokeMatch = /^\/api\/instruction\/([A-Za-z0-9_.:-]+)\/revoke$/.exec(p);
        if (revokeMatch !== null && req.method === "POST") {
          const body = (await req.json().catch(() => ({}))) as { note?: string };
          return json(app.revokeInstruction({ instructionId: revokeMatch[1] as string, by: operator, ...(typeof body.note === "string" ? { note: body.note } : {}) }));
        }
        if (p === "/api/estate/audit" && req.method === "POST") {
          const r = await app.runEstateAudit();
          return json({ runId: r.runId, status: r.terminalStatus, audit: r.outputs["audit_estate"] ?? null });
        }
        if (p === "/api/scenario" && req.method === "POST") {
          const body = ScenarioRequest({ kind: "sell_asset", ...((await req.json()) as object) });
          if (body instanceof type.errors) return json({ error: body.summary }, 400);
          return json(app.runScenarioNow(body));
        }
        if (p === "/api/projection" && req.method === "POST") {
          const body = ProjectionRequest(await req.json());
          if (body instanceof type.errors) return json({ error: body.summary }, 400);
          return json(app.runProjectionNow(body));
        }
        const chatMatch = /^\/api\/chat\/(strategist|estate_planner)$/.exec(p);
        if (chatMatch !== null && req.method === "GET") {
          return json(app.chatTranscript(chatMatch[1] as "strategist" | "estate_planner"));
        }
        if (p === "/api/chat" && req.method === "POST") {
          const body = ChatBody(await req.json());
          if (body instanceof type.errors) return json({ error: body.summary }, 400);
          // The connection's idle timeout is 120s; keep the wait under it.
          const r = await app.sendChat({ agent: body.agent, text: body.text, wait: body.wait ?? true, timeoutMs: 100_000 });
          return json(r, r.turn === null ? 202 : 200);
        }
        if (p === "/api/tax/skip" && req.method === "POST") {
          const body = TaxSkipBody(await req.json());
          if (body instanceof type.errors) return json({ error: body.summary }, 400);
          return json(
            await app.skipTaxDeadline({
              quarter: body.quarter as 1 | 2 | 3 | 4,
              stage: body.stage,
              ...(body.note !== undefined ? { note: body.note } : {}),
              decidedBy: operator,
            }),
          );
        }

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
