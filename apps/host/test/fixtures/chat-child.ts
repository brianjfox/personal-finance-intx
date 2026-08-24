// Child process for the Phase 3 crash test: sends the first chat
// message (starting the standing chat run), waits until the reply is
// recorded AND the step's next input park is durable, then SIGKILLs
// itself -- the mid-conversation shutdown.
//
//   bun chat-child.ts <dataDir>

import { createApp } from "../../src/app";
import { phase3Adapters } from "./phase3-fixture";
import { scriptedAgentFactory } from "./scripted-agent";

const [dataDir] = process.argv.slice(2);
if (!dataDir) throw new Error("usage: chat-child <dataDir>");

const app = createApp({
  dataDir,
  adapters: phase3Adapters(new Date()),
  pollMs: 20,
  agentFactory: scriptedAgentFactory(),
  inferenceSource: () => ({ id: "stub", provider: "anthropic", baseURL: "http://localhost:1", apiKey: "stub", model: "stub" }),
});

const emit = (o: Record<string, unknown>): void => {
  process.stdout.write(`${JSON.stringify(o)}\n`);
};

const r = await app.sendChat({ agent: "strategist", text: "aggregates", wait: true });
emit({ event: "turn", message_id: r.message_id, reply: r.turn?.reply ?? null });

const active = await app.activeChatRun("strategist");
if (active === null) throw new Error("no active chat run after the first turn");
for (;;) {
  const events = await app.runEvents(active.runId);
  const received = new Set(events.filter((e) => e.kind === "SignalReceived").map((e) => (e as { signalName: string }).signalName));
  const open = events.some(
    (e) => e.kind === "SignalAwaited" && (e as { parkKind?: string }).parkKind === "input" && !received.has((e as { signalName: string }).signalName),
  );
  if (open) break;
  await new Promise((res) => setTimeout(res, 50));
}
emit({ event: "parked" });
process.kill(process.pid, "SIGKILL");
