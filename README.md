# Household Financial Interchange

A bench of specialist agents, one shared ledger, and a human gate on
everything that moves money — built on the Corbits/Faremeter Interchange
agentic OS (`@intx/*`, pinned `0.3.0`). See `docs/BUILD_PLAN.md` for the
plan and `docs/financial-interchange-hub.pdf` for the deck this implements.

Track A (BUILD_PLAN §2): an embedded filesystem host (`fin-host`), no hub,
no Postgres, no network listener beyond localhost. What is lost without the
hub — multi-tenant grant storage, hub-managed credential push, Ed25519
identity issuance, the admin UI — is not load-bearing for one household on
one machine; the trust-boundary matrix is enforced locally with
`@intx/authz`.

## Layout

```
packages/contracts     typed messages (Fact, Finding, Recommendation, Approval, Instruction, Receipt, ...)  ArkType
packages/ledger        append-only, bitemporal SQLite fact store; as-of queries; one writer per kind
packages/vault         document vault: content-addressed originals, the evidence every fact points at
packages/institutions  institution adapters -> InstitutionSnapshot (jsondrop, csvdrop, fixture) + registry
packages/actions       deterministic handlers: fetch, normalise, reconcile (the five silent errors), commit, notify/hold
packages/policy        the slide-13 trust-boundary matrix as @intx/authz grants; step -> principal authorize
packages/workflows     defineWorkflow definitions (nightly reconcile with the provisional gate); topology walker; lints
apps/host              fin-host: fs-host WorkflowRuntimeEnv, app assembly, localhost IPC, CLI, demo seed
apps/desktop           the GUI (React, bundled by bun, served by fin-host); Tauri shell comes later
```

## Run it

```bash
bun install
bun test                       # every package
bunx tsc -b --noEmit           # typecheck

# demo: two FICTIONAL institutions, night 1 then night 2 (with injected breaks)
cd apps/host
bun src/cli.ts init    --data /tmp/fin --demo 1
bun src/cli.ts nightly --data /tmp/fin
bun src/cli.ts init    --data /tmp/fin --demo 2
bun src/cli.ts nightly --data /tmp/fin
bun src/cli.ts queue   --data /tmp/fin

# GUI
(cd ../desktop && bun run build)
bun src/cli.ts serve   --data /tmp/fin --port 7777     # open http://127.0.0.1:7777/
```

Real use: connect institutions from the GUI's **Institutions** page — no
file editing required. On a completely empty household the app opens on a
welcome screen with two buttons: start connecting institutions, or seed
the fictional demo. A connection is either *managed* (you type values
into forms; the host writes dated snapshot files) or *file uploads*
(exports downloaded from the institution's website, uploaded in the GUI).
Connections can be paused, resumed, and deleted — deleting stops updates
but never erases history. Under the hood both kinds are `jsondrop`
adapters over `<dataDir>/institutions.json` + per-institution inboxes, so
the old hand-edited registry and drop-folder path (snapshot JSON, or CSVs
with a `csvdrop` column map) still works for scripts and aggregators.

## Phases

- Phase 0 — spike: filesystem `WorkflowRuntimeEnv`, crash-resume across a
  parked `awaitSignal`. Done (`phase-0/spike`).
- Phase 1 — ledger: contracts, ledger, vault, one institution end to end,
  reconciliation, nightly with the provisional gate, GUI. Done (`phase-1/ledger`).
- Phase 2 — time and obligations: the Tax Engine (annualized estimates,
  lot-level gains, wash-sale watch, safe-harbour coverage), the standing
  tax-year workflow with resumable deadline gates, the pre-staged reserve,
  escalations, tax GUI. Done (`phase-2/obligations`). The estimator is not
  tax advice; rates and the prior-year figure are operator configuration
  (`tax-profile.json`), chosen with an accountant.
- Phase 3 — judgement: the Strategist chat (a standing unbounded agent
  step; figures only ever from deterministic tools, every number
  clickable to facts, theses journaled), seeded Monte Carlo + sell-asset
  scenario engines, the Entity & Estate Registry with its plan-vs-reality
  hygiene audit, the Estate Planner. Done (`phase-3/judgement`). The
  advisory agents need `ANTHROPIC_API_KEY` (and optionally `FIN_MODEL`);
  everything else, including scenarios and projections, runs without a
  model.
- Phase 4 — action (execution disabled). Phase 5 — execution, on a
  separate decision.

Decisions where the plan and the framework disagreed are recorded in
`DECISIONS.md` (kept alongside this repo, outside it).
