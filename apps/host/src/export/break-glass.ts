// The break-glass export (deck slide 21, BUILD_PLAN §7.5): "An estate
// system your executor cannot read or shut down is a liability."
//
// One directory, readable with NO software from this project:
//   OPERATING-GUIDE.pdf   the printed one-page(ish) guide, generated
//                         from live data -- what this is, where things
//                         are, who can act, how to shut it down
//   index.html            self-contained overview linking everything
//   csv/*.csv             current state AND full history: accounts,
//                         balances, positions, transactions,
//                         obligations, entities, titling, findings,
//                         journal, recommendations/approvals/
//                         instructions, facts-full
//   documents/            every vault original under its real filename
//                         (sha-prefixed on collision) + manifest
//
// The export is an operator action: journaled, access-logged, and safe
// to re-run (each run gets its own timestamped directory).

import fs from "node:fs";
import path from "node:path";

import type {
  AccountPayload,
  BalancePayload,
  EstateFile,
  ObligationPayload,
  PositionPayload,
  TitlingPayload,
  TransactionPayload,
} from "@fin/contracts";
import { decimal } from "@fin/contracts";
import { listInstructions, listRecommendations, verdictsFor, views, type Ledger } from "@fin/ledger";
import type { Vault } from "@fin/vault";

import { PdfDoc } from "./pdf";

export interface BreakGlassOptions {
  ledger: Ledger;
  vault: Vault;
  dataDir: string;
  outDir: string;
  now: Date;
  estateFile: EstateFile | null;
  operator: string;
}

export interface BreakGlassResult {
  dir: string;
  files: string[];
  documents: number;
}

export function runBreakGlassExport(opts: BreakGlassOptions): BreakGlassResult {
  const stamp = opts.now.toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const dir = path.join(opts.outDir, `fin-export-${stamp}`);
  const csvDir = path.join(dir, "csv");
  const docDir = path.join(dir, "documents");
  fs.mkdirSync(csvDir, { recursive: true });
  fs.mkdirSync(docDir, { recursive: true });
  const files: string[] = [];
  const write = (rel: string, content: string | Uint8Array): void => {
    const p = path.join(dir, rel);
    fs.writeFileSync(p, content);
    files.push(rel);
  };

  const { ledger } = opts;
  const nw = views.netWorth(ledger);

  // --- CSVs: current state ---------------------------------------------
  write(
    "csv/accounts.csv",
    csv(
      ["account", "name", "type", "institution", "masked_number", "currency", "observed_at"],
      ledger.asOf({ kind: "account" }).map((f) => {
        const p = f.payload as AccountPayload;
        return [p.account_id, p.name, p.type, p.institution_id, p.masked_number ?? "", p.currency, f.observed_at];
      }),
    ),
  );
  write(
    "csv/balances.csv",
    csv(
      ["account", "balance_type", "amount", "currency", "observed_at", "effective_at"],
      ledger.asOf({ kind: "balance" }).map((f) => {
        const p = f.payload as BalancePayload;
        return [p.account_id, p.balance_type, p.amount, p.currency, f.observed_at, f.effective_at];
      }),
    ),
  );
  write(
    "csv/positions.csv",
    csv(
      ["account", "symbol", "asset_class", "quantity", "price", "market_value", "cost_basis", "observed_at"],
      ledger
        .asOf({ kind: "position" })
        .filter((f) => !decimal.isZero((f.payload as PositionPayload).quantity))
        .map((f) => {
          const p = f.payload as PositionPayload;
          return [p.account_id, p.instrument.symbol, p.instrument.asset_class, p.quantity, p.price ?? "", p.market_value ?? "", p.cost_basis ?? "unknown", f.observed_at];
        }),
    ),
  );
  write(
    "csv/transactions.csv",
    csv(
      ["account", "txn_id", "posted_at", "amount", "type", "description"],
      ledger.asOf({ kind: "transaction" }).map((f) => {
        const p = f.payload as TransactionPayload;
        return [p.account_id, p.txn_id, p.posted_at, p.amount, p.type, p.description];
      }),
    ),
  );
  write(
    "csv/obligations.csv",
    csv(
      ["subject", "kind", "description", "payment_amount", "payment_due", "observed_at"],
      ledger.asOf({ kind: "obligation" }).map((f) => {
        const p = f.payload as ObligationPayload;
        return [f.subject, p.kind, p.description, p.payment_amount ?? "", p.payment_due ?? "", f.observed_at];
      }),
    ),
  );
  write(
    "csv/entities-and-titling.csv",
    csv(
      ["kind", "subject", "detail", "verified_at"],
      [
        ...ledger.asOf({ kind: "entity" }).map((f) => {
          const p = f.payload as { name?: string; kind?: string };
          return ["entity", f.subject, `${p.name ?? ""} (${p.kind ?? ""})`, ""];
        }),
        ...ledger.asOf({ kind: "titling" }).map((f) => {
          const p = f.payload as TitlingPayload;
          const ben = p.beneficiaries.map((b) => `${b.name}${b.share != null ? ` ${b.share}` : ""}`).join("; ");
          return ["titling", f.subject, `owner ${p.owner}${p.in_trust !== null ? `, in trust ${p.in_trust}` : ""}${ben !== "" ? `, beneficiaries: ${ben}` : ""}`, p.verified_at];
        }),
      ],
    ),
  );
  write(
    "csv/findings.csv",
    csv(
      ["at", "severity", "code", "subject", "summary", "resolved", "resolution"],
      ledger
        .allFindings(10_000)
        .map((f) => [f.as_of, f.severity, f.code, f.subject, f.summary, f.resolved ? "yes" : "no", f.resolutions.map((r) => `${r.decision} by ${r.decided_by}: ${r.note}`).join(" | ")]),
    ),
  );
  write(
    "csv/journal.csv",
    csv(
      ["at", "kind", "author", "summary"],
      ledger.listJournal(10_000).map((j) => [j.at, j.kind, j.author, j.summary]),
    ),
  );
  write(
    "csv/proposals.csv",
    csv(
      ["recommendation", "action", "thesis", "expires", "auditor", "decision", "instruction_status"],
      listRecommendations(ledger, 1000).map((rec) => {
        const verdict = verdictsFor(ledger, rec.id).at(-1);
        const instruction = listInstructions(ledger, 1000).find((i) => i.recommendation_id === rec.id);
        return [
          rec.id,
          `${rec.action.verb} ${rec.action.quantity ?? ""} ${rec.action.instrument ?? ""} (~${rec.action.amount?.amount ?? "?"})`,
          rec.thesis,
          rec.expires,
          verdict === undefined ? "" : verdict.cleared ? "cleared" : `blocked: ${verdict.blocks.map((b) => b.condition).join(",")}`,
          instruction !== undefined ? "approved" : "",
          instruction?.current_status ?? "",
        ];
      }),
    ),
  );
  // Full history, for completeness: every fact ever, with supersession.
  write(
    "csv/facts-full.csv",
    csv(
      ["id", "kind", "subject", "key", "observed_at", "effective_at", "source", "supersedes", "provisional", "payload_json"],
      allFacts(ledger).map((f) => [f.id, f.kind, f.subject, f.key, f.observed_at, f.effective_at, f.source_id, f.supersedes ?? "", f.provisional ? "yes" : "no", JSON.stringify(f.payload)]),
    ),
  );

  // --- documents ---------------------------------------------------------
  const docs = ledger.listDocuments(10_000);
  const used = new Set<string>();
  const docRows: string[][] = [];
  for (const d of docs) {
    let name = d.filename.replace(/[/\\]/g, "_");
    if (used.has(name)) name = `${d.sha256.slice(0, 8)}-${name}`;
    used.add(name);
    try {
      const bytes = opts.vault.read(d.id, "operator");
      fs.writeFileSync(path.join(docDir, name), bytes);
      files.push(`documents/${name}`);
      docRows.push([name, d.kind, d.source_id, d.ingested_at, d.sha256]);
    } catch (cause) {
      docRows.push([name, d.kind, d.source_id, d.ingested_at, `UNREADABLE: ${cause instanceof Error ? cause.message : String(cause)}`]);
    }
  }
  write("documents/manifest.csv", csv(["file", "kind", "source", "ingested_at", "sha256"], docRows));

  // --- the operating guide ----------------------------------------------
  const guide = operatingGuide(opts, nw.net_worth, docs.length);
  write("OPERATING-GUIDE.pdf", guide.pdf);
  write("index.html", indexHtml(opts, nw, files, guide.text));

  // Journal + access log: the export itself is a recorded decision.
  const at = opts.now.toISOString();
  ledger.logAccess({ at, principal: "operator", resource: `export:${dir}`, action: "read", detail: `break-glass export, ${String(files.length)} files` });
  ledger.appendJournal({
    at,
    kind: "system",
    summary: `break-glass export written to ${dir} (${String(files.length)} files, ${String(docs.length)} documents)`,
    detail: { dir, files: files.length },
    refs: [],
    author: opts.operator,
  });

  return { dir, files, documents: docs.length };
}

function allFacts(ledger: Ledger): ReturnType<Ledger["batchFacts"]> {
  return ledger.db
    .query<{ id: string }, []>("SELECT id FROM fact ORDER BY seq")
    .all()
    .map((r) => ledger.getFact(r.id))
    .filter((f): f is NonNullable<typeof f> => f !== null);
}

// --- the guide ----------------------------------------------------------

interface GuideSection {
  heading: string;
  bullets: string[];
}

function guideSections(opts: BreakGlassOptions, netWorth: string, docCount: number): GuideSection[] {
  const estate = opts.estateFile;
  const executors = estate?.plan.executors ?? [];
  const accounts = opts.ledger.asOf({ kind: "account" }).length;
  return [
    {
      heading: "What this is",
      bullets: [
        `The household's financial record system. As of this export: ${String(accounts)} accounts, net worth ${netWorth} USD, ${String(docCount)} original documents.`,
        "Everything in this folder is plain CSV, PDF and HTML -- no software from this project is needed to read it.",
        "The system itself is append-only: it records facts with dates and sources; it never traded or moved money on its own (execution was disabled).",
      ],
    },
    {
      heading: "Who can act",
      bullets: [
        executors.length > 0 ? `Named executor(s): ${executors.join(", ")}.` : "NO EXECUTOR IS RECORDED in the estate plan -- see estate.json in the data directory.",
        estate?.plan.digital_access != null && estate.plan.digital_access.trim() !== ""
          ? `Digital access: ${estate.plan.digital_access}`
          : "No digital-access note is recorded.",
      ],
    },
    {
      heading: "Where everything lives",
      bullets: [
        `Live data directory: ${opts.dataDir}`,
        "ledger.db -- the append-only household ledger (SQLite; any SQLite tool opens it).",
        "vault/ -- original statements and documents, content-addressed; copies are in this export's documents/ folder.",
        "tax-profile.json, estate.json, plan.json -- the operator's configuration, written with the accountant and attorney.",
        "csv/ in this export -- current accounts, balances, positions, transactions, obligations, findings, the decision journal, and the full fact history.",
      ],
    },
    {
      heading: "How to read the important things",
      bullets: [
        "csv/balances.csv and csv/positions.csv: what was held and where, with the date each figure was observed.",
        "csv/obligations.csv: known upcoming payments (tax estimates and similar) with due dates.",
        "csv/journal.csv: every material decision, who made it, and why.",
        "documents/manifest.csv: every original document with its checksum.",
      ],
    },
    {
      heading: "How to shut it down",
      bullets: [
        "Stop the application (quit the app, or Ctrl+C the `fin-host serve` process). Nothing keeps running: all schedules live inside it.",
        "Revoke the AI key: delete the `fin-interchange` item in macOS Keychain Access (or unset ANTHROPIC_API_KEY); the advisory agents stop working, nothing else is affected.",
        "Revoke institution access at each institution's website (the system only ever held read-only file drops or read-only tokens; there is nothing that can move money).",
        "The data directory is inert files; keep it (or this export) for records and taxes.",
      ],
    },
    {
      heading: "What it never did",
      bullets: [
        "It never held a credential that could withdraw or transfer money.",
        "It never placed an order: proposals required a human signature, and even signed instructions were only PREPARED for a human to place.",
      ],
    },
  ];
}

function operatingGuide(opts: BreakGlassOptions, netWorth: string, docCount: number): { pdf: Uint8Array; text: GuideSection[] } {
  const sections = guideSections(opts, netWorth, docCount);
  const doc = new PdfDoc();
  doc.title("Corbits Personal Finance -- Operating Guide");
  doc.body(`Generated ${opts.now.toISOString().slice(0, 10)} by ${opts.operator}. Print this page and keep it with the estate papers.`);
  for (const s of sections) {
    doc.heading(s.heading);
    for (const b of s.bullets) doc.bullet(b);
  }
  return { pdf: doc.render(), text: sections };
}

// --- helpers ------------------------------------------------------------

function csv(header: string[], rows: string[][]): string {
  const esc = (v: string): string => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return [header, ...rows].map((r) => r.map(esc).join(",")).join("\n") + "\n";
}

function indexHtml(opts: BreakGlassOptions, nw: ReturnType<typeof views.netWorth>, files: string[], sections: GuideSection[]): string {
  const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const csvLinks = files.filter((f) => f.startsWith("csv/")).map((f) => `<li><a href="${f}">${f}</a></li>`).join("");
  const guideHtml = sections
    .map((s) => `<h2>${esc(s.heading)}</h2><ul>${s.bullets.map((b) => `<li>${esc(b)}</li>`).join("")}</ul>`)
    .join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Corbits Personal Finance — Export</title>
<style>body{font:15px/1.5 -apple-system,Helvetica,Arial,sans-serif;max-width:820px;margin:2rem auto;padding:0 1rem;color:#1a1a1a}h1{font-size:1.5rem}h2{font-size:1.1rem;margin-top:1.4rem}code{background:#f2f2f2;padding:1px 4px;border-radius:3px}li{margin:.2rem 0}@media print{a{color:inherit;text-decoration:none}}</style>
</head><body>
<h1>Corbits Personal Finance — full export</h1>
<p>Generated ${esc(opts.now.toISOString())}. Net worth at export: <b>${esc(nw.net_worth)} USD</b> (assets ${esc(nw.assets)}, liabilities ${esc(nw.liabilities)})${nw.provisional ? " — some figures were provisional" : ""}.</p>
<p><a href="OPERATING-GUIDE.pdf"><b>OPERATING-GUIDE.pdf</b></a> — print it and keep it with the estate papers. <a href="documents/manifest.csv">documents/manifest.csv</a> lists every original document in <code>documents/</code>.</p>
${guideHtml}
<h2>Data files</h2><ul>${csvLinks}</ul>
</body></html>
`;
}
