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
      console.log("fin-host <init|nightly|queue|resolve|runs|tax|tax-start|tax-check|tax-skip|serve> [--data DIR] ...");
      return cmd === "help" ? 0 : 2;
  }
}

process.exitCode = await main(process.argv.slice(2));
