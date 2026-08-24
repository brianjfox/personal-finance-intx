// Child process for the Phase 4 test: runs one proposal to the point
// where it parks at the approval gate, prints the queued recommendation,
// and exits -- leaving the run parked on disk like a host shutdown.
//
//   bun propose-child.ts <dataDir>

import { createApp } from "../../src/app";
import { scriptedAgentFactory } from "./scripted-agent";

const [dataDir] = process.argv.slice(2);
if (!dataDir) throw new Error("usage: propose-child <dataDir>");

const app = createApp({
  dataDir,
  adapters: [],
  pollMs: 20,
  agentFactory: scriptedAgentFactory(),
  inferenceSource: () => ({ id: "stub", provider: "anthropic", baseURL: "http://localhost:1", apiKey: "stub", model: "stub" }),
});

const r = await app.startProposal();
const queue = app.approvalQueue();
process.stdout.write(`${JSON.stringify({ event: "proposed", state: r.state, runId: r.runId, recommendation_id: queue[0]?.recommendation.id ?? null })}\n`);
app.close();
process.exit(r.state === "queued" ? 0 : 1);
