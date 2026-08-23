#!/usr/bin/env bun
// Phase 0 spike driver. One process = one host = one run, so the crash
// test can SIGKILL it.
//
//   bun src/spike/cli.ts run <dataDir> <runId> [toy|sleep] [payloadJson]
//       Start or resume the run. Emits one JSON object per line on stdout:
//         {"event":"fresh"|"resumed"}   before the runtime starts
//         {"event":"log","kind":...}    every durable event as it lands
//         {"event":"parked"}            when a SignalAwaited / TimerSet is durable
//         {"event":"done",...}          terminal result
//         {"event":"error",...}         the runtime refused / threw
//   bun src/spike/cli.ts deliver <dataDir> <runId> <signalId> [payloadJson] [name]
//       Durably enqueue a signal for the run from THIS process, which
//       holds no run. Exits immediately.
//   bun src/spike/cli.ts log <dataDir> <runId>
//       Print the durable log, one event kind per line.

import { createFsHost } from "../fs-host/index";
import { sleepWorkflow, toyActions, toyWorkflow } from "./toy";

function emit(obj: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

async function main(argv: string[]): Promise<number> {
  const [cmd, dataDir, runId, ...rest] = argv;
  if (!cmd || !dataDir || !runId) {
    process.stderr.write("usage: cli.ts run|deliver|log <dataDir> <runId> ...\n");
    return 2;
  }
  const host = createFsHost({ dataDir, actions: toyActions(dataDir), pollMs: 50 });

  if (cmd === "deliver") {
    const [signalId, payloadJson, name] = rest;
    if (!signalId) {
      process.stderr.write("deliver needs a signalId\n");
      return 2;
    }
    const payload: unknown = payloadJson ? JSON.parse(payloadJson) : { approved: true };
    const file = host.deliver(runId, name ?? "approve", payload, signalId);
    emit({ event: "delivered", file, signalId });
    return 0;
  }

  if (cmd === "log") {
    for (const e of await host.readLog(runId)) {
      emit({ seq: e.seq, kind: e.kind, ...("stepId" in e ? { stepId: e.stepId } : {}) });
    }
    return 0;
  }

  if (cmd === "run") {
    const [which, payloadJson] = rest;
    const definition = which === "sleep" ? sleepWorkflow : toyWorkflow;
    const payload: unknown = payloadJson ? JSON.parse(payloadJson) : { order: "toy-1" };
    const fresh = !host.repoStore.hasRun(runId);
    emit({ event: fresh ? "fresh" : "resumed", runId });

    // Tail the durable log from the start so "parked" is only ever
    // reported once the SignalAwaited/TimerSet is on disk.
    const tailAbort = new AbortController();
    const tail = (async (): Promise<void> => {
      for await (const { event } of host.repoStore.subscribe(runId, {
        signal: tailAbort.signal,
        from: { seq: 1 },
      })) {
        emit({ event: "log", seq: event.seq, kind: event.kind });
        if (event.kind === "SignalAwaited" || event.kind === "TimerSet") {
          emit({ event: "parked", kind: event.kind, seq: event.seq });
        }
      }
    })();

    try {
      const run = host.run(definition, { runId, triggerPayload: payload });
      const result = await run.complete;
      // Let the tail drain the terminal event before we report done.
      await new Promise((r) => setTimeout(r, 20));
      emit({
        event: "done",
        terminalStatus: result.terminalStatus,
        outputs: result.outputs,
        eventCount: result.events.length,
      });
      return result.terminalStatus === "completed" ? 0 : 1;
    } catch (cause) {
      emit({
        event: "error",
        name: cause instanceof Error ? cause.name : "Error",
        message: cause instanceof Error ? cause.message : String(cause),
      });
      return 1;
    } finally {
      tailAbort.abort();
      await tail;
    }
  }

  process.stderr.write(`unknown command ${cmd}\n`);
  return 2;
}

process.exit(await main(process.argv.slice(2)));
