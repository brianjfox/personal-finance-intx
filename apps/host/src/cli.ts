#!/usr/bin/env bun
// fin-host command line.
//
//   fin-host serve   [--data DIR] [--port N] [--gui DIR]   start the IPC server (+ GUI), resume in-flight runs
//   fin-host nightly [--data DIR] [--inst id,id]           run the nightly once and print the verdict
//   fin-host init    [--data DIR] [--demo [1|2]]           create the data dir; --demo seeds two fictional institutions
//   fin-host queue   [--data DIR]                          print the exception queue
//   fin-host resolve [--data DIR] <finding_id> <decision> [note]
//   fin-host runs    [--data DIR]
//   fin-host tax        [--data DIR]                       tax calendar status (profile, gates, obligations)
//   fin-host tax-start  [--data DIR] [--year Y]            launch the standing tax-year run (use under `serve` normally)
//   fin-host tax-check  [--data DIR] --q N --stage pre|due run one manual tax check now
//   fin-host tax-skip   [--data DIR] --q N --stage pre|due [note]  skip a deadline gate (journaled)
//   fin-host chat       [--data DIR] [--agent strategist|estate_planner] <message...>   (needs ANTHROPIC_API_KEY)
//   fin-host propose    [--data DIR]                       drift -> Market Manager -> Auditor -> approval queue (needs key)
//   fin-host approvals  [--data DIR]                       print the approval queue
//   fin-host decide     [--data DIR] <rec_id> approve|reject [--qty N] [--limit N] [note...]
//   fin-host instructions [--data DIR]                     prepared (never sent) instructions
//   fin-host revoke     [--data DIR] <instruction_id> [note...]
//   fin-host estate-audit [--data DIR]                     sync estate.json + hygiene audit
//   fin-host scenario   [--data DIR] --subject S --date YYYY-MM-DD [--price N --basis N --depreciation N]
//   fin-host projection [--data DIR] --years N [--seed S]
//
// Default data dir: ~/Library/Application Support/FinInterchange (macOS) or $FIN_DATA_DIR.

import os from "node:os";
import path from "node:path";

import { resolveFinding, views } from "@fin/ledger";

import { createApp } from "./app";
import { seedDemo } from "./demo";
import { startIpc } from "./ipc";

function defaultDataDir(): string {
  const env = process.env["FIN_DATA_DIR"];
  if (env !== undefined && env !== "") return env;
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "FinInterchange");
  return path.join(os.homedir(), ".fin-interchange");
}

function parseArgs(argv: string[]): { cmd: string; flags: Record<string, string>; rest: string[] } {
  const [cmd = "help", ...tail] = argv;
  const flags: Record<string, string> = {};
  const rest: string[] = [];
  for (let i = 0; i < tail.length; i += 1) {
    const a = tail[i] as string;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = tail[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i += 1;
      } else {
        flags[key] = "true";
      }
    } else {
      rest.push(a);
    }
  }
  return { cmd, flags, rest };
}

async function main(argv: string[]): Promise<number> {
  const { cmd, flags, rest } = parseArgs(argv);
  const dataDir = flags["data"] ?? defaultDataDir();

  switch (cmd) {
    case "init": {
      const app = createApp({ dataDir });
      const out: Record<string, unknown> = { dataDir, schema: app.ledger.schemaVersion() };
      if (flags["demo"] !== undefined) {
        const night = flags["demo"] === "2" ? 2 : 1;
        out["seeded"] = seedDemo(dataDir, night);
      }
      app.close();
      console.log(JSON.stringify(out, null, 2));
      return 0;
    }
    case "nightly": {
      const app = createApp({ dataDir });
      const institutions = flags["inst"]?.split(",").filter((s) => s !== "");
      const r = await app.runNightly(institutions !== undefined ? { institutions } : {});
      const rec = r.outputs["reconcile"] as { clean?: boolean; provisional_subjects?: string[]; stats?: Record<string, number> } | undefined;
      console.log(
        JSON.stringify(
          {
            runId: r.runId,
            status: r.terminalStatus,
            clean: rec?.clean ?? null,
            provisional_subjects: rec?.provisional_subjects ?? [],
            findings: rec?.stats ?? {},
            queue: app.ledger.openFindings({ requiresHuman: true }).length,
            net_worth: views.netWorth(app.ledger).net_worth,
          },
          null,
          2,
        ),
      );
      app.close();
      return r.terminalStatus === "completed" ? 0 : 1;
    }
    case "queue": {
      const app = createApp({ dataDir });
      for (const f of app.ledger.openFindings({ requiresHuman: true })) {
        console.log(`${f.id}  ${f.severity.padEnd(8)} ${f.code.padEnd(34)} ${f.subject}\n    ${f.summary}`);
      }
      app.close();
      return 0;
    }
    case "resolve": {
      const [findingId, decision, ...noteParts] = rest;
      if (findingId === undefined || decision === undefined) {
        console.error("usage: fin-host resolve <finding_id> <accept_incoming|keep_prior|both|dismiss> [note]");
        return 2;
      }
      const app = createApp({ dataDir });
      const r = resolveFinding(app.ledger, {
        findingId,
        decision: decision as "accept_incoming" | "keep_prior" | "both" | "dismiss",
        note: noteParts.join(" "),
        decidedBy: process.env["USER"] ?? "operator",
        decidedAt: new Date().toISOString(),
      });
      console.log(JSON.stringify(r, null, 2));
      app.close();
      return 0;
    }
    case "runs": {
      const app = createApp({ dataDir });
      for (const r of await app.listRuns()) {
        console.log(`${r.runId}  ${r.status.padEnd(9)} ${r.startedAt ?? ""}  gate=${r.steps["gate"]?.status ?? "-"} notify=${r.steps["notify"]?.status ?? "-"} hold=${r.steps["hold"]?.status ?? "-"}`);
      }
      app.close();
      return 0;
    }
    case "tax": {
      const app = createApp({ dataDir });
      console.log(JSON.stringify(await app.taxStatus(), null, 2));
      app.close();
      return 0;
    }
    case "tax-start": {
      // Starts the standing run and keeps the process alive so the timers
      // are armed; under normal operation `serve` resumes and drives it.
      const app = createApp({ dataDir });
      const year = flags["year"] !== undefined ? Number(flags["year"]) : undefined;
      const r = await app.startTaxYear(year !== undefined ? { year } : {});
      console.log(JSON.stringify({ started: r.runId }, null, 2));
      console.log("standing run is live in THIS process; Ctrl+C parks it (deadline gates survive restart)");
      await new Promise<void>((resolve) => {
        process.on("SIGINT", () => resolve());
        process.on("SIGTERM", () => resolve());
      });
      app.close();
      return 0;
    }
    case "tax-check": {
      const q = Number(flags["q"] ?? flags["quarter"]);
      const stage = flags["stage"];
      if (!(q >= 1 && q <= 4) || (stage !== "pre" && stage !== "due")) {
        console.error("usage: fin-host tax-check --q <1-4> --stage <pre|due>");
        return 2;
      }
      const app = createApp({ dataDir });
      const r = await app.runTaxCheck({ quarter: q as 1 | 2 | 3 | 4, stage });
      const est = r.outputs["est_check"] as { figures?: unknown; reserve_ok?: boolean; blocked?: string[] } | undefined;
      console.log(JSON.stringify({ runId: r.runId, status: r.terminalStatus, reserve_ok: est?.reserve_ok ?? null, blocked: est?.blocked ?? [], figures: est?.figures ?? null }, null, 2));
      app.close();
      return r.terminalStatus === "completed" ? 0 : 1;
    }
    case "tax-skip": {
      const q = Number(flags["q"] ?? flags["quarter"]);
      const stage = flags["stage"];
      if (!(q >= 1 && q <= 4) || (stage !== "pre" && stage !== "due")) {
        console.error("usage: fin-host tax-skip --q <1-4> --stage <pre|due> [note]");
        return 2;
      }
      const app = createApp({ dataDir });
      const r = await app.skipTaxDeadline({ quarter: q as 1 | 2 | 3 | 4, stage, note: rest.join(" "), decidedBy: process.env["USER"] ?? "operator" });
      console.log(JSON.stringify(r, null, 2));
      app.close();
      return 0;
    }
    case "chat": {
      const message = rest.join(" ").trim();
      if (message === "") {
        console.error('usage: fin-host chat [--agent strategist|estate_planner] "<message>"');
        return 2;
      }
      const agent = flags["agent"] === "estate_planner" ? "estate_planner" : "strategist";
      const app = createApp({ dataDir });
      await app.resumeInFlight();
      const r = await app.sendChat({ agent, text: message, wait: true });
      const turn = r.turn;
      console.log(turn?.reply ?? "(no reply)");
      for (const e of turn?.evidence ?? []) {
        console.log(`\n[evidence: ${e.tool}] facts: ${e.fact_ids.slice(0, 6).join(", ")}${e.fact_ids.length > 6 ? ", ..." : ""}`);
      }
      if ((turn?.journal_ids.length ?? 0) > 0) console.log(`\n[journaled: ${(turn?.journal_ids ?? []).join(", ")}]`);
      app.close();
      // The standing chat run stays parked on disk; this process exits.
      process.exit(0);
    }
    case "estate-audit": {
      const app = createApp({ dataDir });
      const r = await app.runEstateAudit();
      console.log(JSON.stringify({ runId: r.runId, status: r.terminalStatus, audit: r.outputs["audit_estate"] ?? null }, null, 2));
      const status = app.estateStatus();
      console.log(JSON.stringify({ openEstateFindings: status.openFindings, entities: status.entities.length, titling: status.titling.length }, null, 2));
      app.close();
      return r.terminalStatus === "completed" ? 0 : 1;
    }
    case "scenario": {
      const subject = flags["subject"];
      const date = flags["date"];
      if (subject === undefined || date === undefined) {
        console.error("usage: fin-host scenario --subject <acct.subject> --date YYYY-MM-DD [--price N --basis N --depreciation N]");
        return 2;
      }
      const app = createApp({ dataDir });
      const r = app.runScenarioNow({
        kind: "sell_asset",
        subject,
        sale_date: date,
        ...(flags["price"] !== undefined ? { sale_price: flags["price"] } : {}),
        ...(flags["basis"] !== undefined ? { cost_basis: flags["basis"] } : {}),
        ...(flags["depreciation"] !== undefined ? { depreciation_taken: flags["depreciation"] } : {}),
      });
      console.log(JSON.stringify(r, null, 2));
      app.close();
      return 0;
    }
    case "projection": {
      const years = Number(flags["years"] ?? "10");
      const app = createApp({ dataDir });
      const r = app.runProjectionNow({ years, ...(flags["seed"] !== undefined ? { seed: flags["seed"] } : {}) });
      console.log(JSON.stringify(r, null, 2));
      app.close();
      return 0;
    }
    case "propose": {
      const app = createApp({ dataDir });
      await app.resumeInFlight();
      const r = await app.startProposal();
      console.log(JSON.stringify(r, null, 2));
      if (r.state === "queued") {
        for (const q of app.approvalQueue()) {
          console.log(`${q.recommendation.id}  ${q.recommendation.action.verb} ${q.recommendation.action.quantity ?? ""} ${q.recommendation.action.instrument ?? ""} @ ~${q.recommendation.action.amount?.amount ?? "?"}  expires ${q.recommendation.expires}`);
          console.log(`    ${q.recommendation.thesis}`);
        }
      }
      app.close();
      process.exit(r.state === "queued" ? 0 : 1);
    }
    case "approvals": {
      const app = createApp({ dataDir });
      for (const q of app.approvalQueue()) {
        console.log(`${q.recommendation.id}  ${q.recommendation.action.verb} ${q.recommendation.action.quantity ?? ""} ${q.recommendation.action.instrument ?? ""}  auditor: cleared  expires ${q.recommendation.expires}`);
        console.log(`    ${q.recommendation.thesis}`);
      }
      app.close();
      return 0;
    }
    case "decide": {
      const [recId, decision, ...noteParts] = rest;
      if (recId === undefined || (decision !== "approve" && decision !== "reject")) {
        console.error("usage: fin-host decide <rec_id> approve|reject [--qty N] [--limit N] [note...]");
        return 2;
      }
      const app = createApp({ dataDir });
      await app.resumeInFlight();
      const r = await app.decideRecommendation({
        recommendationId: recId,
        decision,
        bound: { ...(flags["qty"] !== undefined ? { max_quantity: flags["qty"] } : {}), ...(flags["limit"] !== undefined ? { limit_price: flags["limit"] } : {}) },
        note: noteParts.join(" "),
        signedBy: process.env["USER"] ?? "operator",
      });
      console.log(JSON.stringify(r, null, 2));
      app.close();
      process.exit(0);
    }
    case "instructions": {
      const app = createApp({ dataDir });
      for (const i of app.listPreparedInstructions()) {
        console.log(`${i.id}  ${i.current_status.padEnd(9)} ${i.action.verb} up to ${i.bound.max_quantity ?? "?"} ${i.action.instrument ?? ""}  expires ${i.expires}`);
      }
      app.close();
      return 0;
    }
    case "revoke": {
      const [insId, ...noteParts] = rest;
      if (insId === undefined) {
        console.error("usage: fin-host revoke <instruction_id> [note...]");
        return 2;
      }
      const app = createApp({ dataDir });
      const r = app.revokeInstruction({ instructionId: insId, by: process.env["USER"] ?? "operator", note: noteParts.join(" ") });
      console.log(JSON.stringify(r, null, 2));
      app.close();
      return 0;
    }
    case "serve": {
      const app = createApp({ dataDir });
      const resumed = await app.resumeInFlight();
      const guiDir = flags["gui"] ?? path.resolve(import.meta.dir, "../../desktop/dist");
      const server = startIpc({ app, port: Number(flags["port"] ?? 7777), guiDir });
      console.log(JSON.stringify({ listening: server.url.href, dataDir, resumed: resumed.map((r) => `${r.runId}:${r.status}`), gui: guiDir }));
      await new Promise<void>((resolve) => {
        process.on("SIGINT", () => resolve());
        process.on("SIGTERM", () => resolve());
      });
      await server.stop();
      app.close();
      return 0;
    }
    default:
      console.log(
        "fin-host <init|nightly|queue|resolve|runs|tax|tax-start|tax-check|tax-skip|chat|estate-audit|scenario|projection|propose|approvals|decide|instructions|revoke|serve> [--data DIR] ...",
      );
      return cmd === "help" ? 0 : 2;
  }
}

process.exitCode = await main(process.argv.slice(2));
