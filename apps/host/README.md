# @fin/host (`fin-host`)

The embedded Interchange host for the Household Financial Interchange:
a `WorkflowRuntimeEnv` over the local filesystem, driven by the same
`runtimeRun` body that `@intx/workflow`'s `runLocal` and the production
sidecar use. No Postgres, no hub, no network listener.

The word "sidecar" is never used in this package (BUILD_PLAN §2:
terminology collision).

## Layout

```
src/app.ts           createApp(): ledger + vault + institutions + fs-host with the policy authorize;
                     tax profile, standing tax-year run lifecycle, taxStatus()
src/ipc.ts           localhost HTTP/JSON for the GUI: views, fact drill-down, start nightly, resolve
                     finding, tax calendar (status/check/skip), obligations
src/cli.ts           fin-host init|nightly|queue|resolve|runs|tax|tax-start|tax-check|tax-skip|serve
src/demo.ts          seedDemo(): two fictional institutions as jsondrop inboxes + a demo tax profile
src/fs-host/
  paths.ts           data-dir layout + atomic write helper
  repo-store.ts      RepoStore: runs/<runId>/events.jsonl, atomic batch rewrite
  blobs.ts           BlobSubstrate: inline refs or content-addressed blobs/
  effects.ts         EffectLedger: effects/<sha256(key)>.json, durable on return
  scheduler.ts       Scheduler: runlocal's scheduler wrapped with long-delay chunking (the setTimeout
                     2^31-1 ms clamp) and overdue-timer staggering (D-014/D-015)
  signal-channel.ts  SignalChannel: in-process FIFO + durable per-run inbox
  flush.ts           periodic pending-commit-buffer flush for standing runs (D-017)
  host.ts            createFsHost(): assembles the env, run()/deliver(); rehydrates trigger.payload
                     on adopted resume (D-015)
src/spike/
  toy.ts             action -> awaitSignal -> action (and a sleep variant)
  cli.ts             one process = one host = one run; JSON lines on stdout
test/
  phase0-crash-resume.test.ts   the Phase 0 gate, against real child processes
  phase1-nightly.test.ts        Phase 1 acceptance through fin-host; SIGKILL mid-nightly
  phase2-taxyear.test.ts        Phase 2: a deadline parked in a timed awaitSignal survives SIGKILL
                                and fires after restart; skips delivered while down; long-timer clamp
```

Data directory (`~/Library/Application Support/FinInterchange/` in the
app; any path in tests):

```
<dataDir>/runs/<runId>/events.jsonl    the run's durable event log
<dataDir>/runs/<runId>/inbox/*.json    signals delivered to the run
<dataDir>/blobs/<sha256>.json          spilled step outputs
<dataDir>/effects/<sha256>.json        exactly-once effect records
<dataDir>/ledger.db                    the household ledger (SQLite, WAL)
<dataDir>/vault/<sha256>.<ext>         original documents
<dataDir>/institutions.json            institution registry
<dataDir>/institutions/<id>/inbox/     file-drop inboxes
<dataDir>/tax-profile.json             the operator's tax profile (rates, prior-year tax, reserve account)
```

## Run the Phase 0 gate by hand

Three terminals, or one terminal and `kill -9`:

```bash
cd apps/host
D=/tmp/fin-gate; rm -rf $D

# 1. start a fresh run; it prints {"event":"parked",...} once SignalAwaited is on disk
bun src/spike/cli.ts run $D demo toy '{"order":"demo"}'
#    ... in another terminal:
kill -9 <that pid>

# 2. inspect: the log ends at SignalAwaited, one "prepare" effect line
bun src/spike/cli.ts log $D demo
cat $D/spike-effects.log

# 3. restart the host for the same run; it prints {"event":"resumed"} and re-parks
bun src/spike/cli.ts run $D demo toy

# 4. from another process, approve
bun src/spike/cli.ts deliver $D demo approve-1 '{"approved":true}'

# 5. the restarted host prints {"event":"done","terminalStatus":"completed",...}
#    and the effects log has exactly two lines: prepare, finish
```

Delivering the same `signalId` twice is a no-op. Delivering while no
host is running works: the next host replays the inbox.

## Tests

```bash
bun test
```

## Not yet wired (fails loudly, by contract)

- Model-backed `step` (Phase 3; `createWorkflowStepInvoker` per D-010).
- `childWorkflow`, `onTrigger` (Phase 3; `createInMemorySpawnChild` per D-010).
- Resume of a `sleep` left `awaiting-timer` -- not supported by the
  runtime at the pinned framework version. See `DECISIONS.md` D-006.
- An `action` left in flight at a crash is settled as failed on resume
  (at-most-once); the nightly is idempotent and is simply re-run. D-012.
