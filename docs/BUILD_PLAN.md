# Household Financial Interchange — Build Plan

**Target:** a double-clickable macOS application implementing the Household Financial Interchange described in `financial-interchange-hub`, built on the Corbits/Faremeter **Interchange** agentic OS.

**Framework ground truth:** `github.com/faremeter/interchange` @ `0ae7eba` (2026-08-21), workspace version `0.3.0`, published to npm under `@intx/*`. Status: **alpha**. Public APIs and wire formats change between releases. **Pin exact versions.**

---

## 0. Instructions to the implementing agent

Read this section before writing any code.

1. **Clone the framework and read it.** Do not build from this document alone. `git clone https://github.com/faremeter/interchange`. Read, in order: `README.md`, `LAYOUT.md`, `packages/workflow/README.md`, `packages/agent/README.md`, `docs/AUTH.md`, `docs/CREDENTIALS.md`. Run `examples/agent-quickstart` and `examples/coding-agent` before writing a line of product code.
2. **The deck's "17 agents" are not 17 Interchange agents.** This is the single most important translation in this document. See §3. Most of them are `action` primitives — deterministic TypeScript handlers. Only three or four are model-backed `step` primitives. Building 17 LLM agents would violate the deck's own design principles (§4 of the deck: "Arithmetic never happens in a language model") and would cost roughly 20× more per night to run.
3. **Schema before agents.** The deck's closing slide is an instruction: write the data model first. Phase 1 in §6 is not skippable and not reorderable.
4. **Prefer deleting an agent to adding one.** If a job can be a pure function over the ledger, it is an `action`, not a `step`.
5. **When this document and the repository disagree, the repository wins.** This plan was written against one commit of an alpha project. Re-verify every API signature cited here before depending on it.

---

## 1. What Interchange actually gives you

Interchange is an "agentic operating system": it makes an agent a **managed principal** with identity, scoped permissions, managed credentials, and a git-backed audit trail, rather than a script in a loop.

It splits into two halves:

| Half | What it is | Needs |
| --- | --- | --- |
| **Hub** (control plane) | Multi-tenant Hono/Bun server: tenants, principals, capability grants, credentials, agent lifecycle, deployment | PostgreSQL 15+, Bun 1.2+, git 2.34+ |
| **Agent runtime** | Portable core: `@intx/agent`, `@intx/workflow`, `@intx/inference`, `@intx/harness`, storage/crypto/tools | Bun, Node, or Deno. No database. |

The pieces this product leans on hardest:

- **`@intx/workflow`** — a workflow state machine with a DAG of typed primitives, driven off an **append-only event log**. Explicitly host-agnostic: "It does not know how a run is persisted, scheduled, or spawned — those are the host's job." This is the deck's "deterministic control flow" principle, already built.
- **`@intx/authz`** — a standalone grant-evaluation engine (pattern matching, specificity ordering, conditions). **Pure logic, no database.** The same policy gates API calls and tool invocations. This is the deck's trust-boundary matrix, enforceable without the hub.
- **`@intx/agent`** — `defineAgent` / `createAgent` / `agent.send()`. Context is a real git repository; crash and re-run resumes; rewind `HEAD` to open the agent at an earlier state. The audit log *is* the commit history.
- **`@intx/storage-isogit/node`** — filesystem git-backed context store.
- **`defineTool`** — namespaced tool bundles that statically declare their tool names, so the deploy-time capability walk can enumerate an agent's grant surface **without instantiating it**.
- **`@intx/inference`** — Anthropic / OpenAI-compatible / Gemini adapters with per-call failover and live source hot-swap.

---

## 2. Deployment architecture — the decision

You asked for docker-with-hub *or* a filesystem sidecar. **Build the filesystem host as Track A. Treat the hub as an optional Track B.**

### Why

- **Container deployment of the Interchange sidecar is not shipped.** The repo lists "Container and VM deployment — packaging the sidecar host to run in containers and VMs; **in flight, not yet merged**." You would be building it yourself either way.
- **The hub's dependency footprint is hostile to a consumer .app.** Postgres 15+, two distinct database roles with a grant choreography, four `.env` files, drizzle migrations, a WebSocket handshake token provisioned into a DB row before the sidecar starts. Shipping that behind a double-click means shipping Docker Desktop as a prerequisite.
- **The DI seam is small, documented, and clearly intended for exactly this.** `WorkflowRuntimeEnv` is the whole contract, and the interfaces are tiny — `Scheduler` is *one method*. `runLocal` is a working reference implementation of every one of them.
- **You do not lose the security model.** `@intx/authz` is shared-foundation, dependency-light, database-free. The trust-boundary matrix is enforceable locally. This is the part people assume requires the hub, and it doesn't.

### What you *do* lose without the hub

Be honest about this in the README:

- Multi-tenant isolation and the principal/role/grant **storage** model (you re-implement a single-tenant version over SQLite).
- Hub-managed **credential resolution and push** (§7.3 covers the Keychain replacement).
- Ed25519 identity issuance and hub-brokered session channels.
- The admin UI.

None of these are load-bearing for a single-household, single-machine product.

### Track A — Embedded filesystem host (primary)

```
┌──────────────────────────────────────────────────┐
│  Financial Interchange.app  (Tauri v2)           │
│                                                  │
│  ┌────────────────┐   IPC    ┌────────────────┐ │
│  │  GUI (React)   │◀────────▶│  Host binary    │ │
│  │  Approvals     │          │  (bun compile)  │ │
│  │  Ledger views  │          │                 │ │
│  └────────────────┘          │  @intx/workflow │ │
│                              │  @intx/agent    │ │
│  ~/Library/Application       │  @intx/authz    │ │
│    Support/FinInterchange/   │  fs-host impls  │ │
│      ledger.db   (SQLite)    └────────────────┘ │
│      runs/       (git repos)                     │
│      context/    (git repos)                     │
│      vault/      (documents)                     │
└──────────────────────────────────────────────────┘
```

No Postgres. No Docker. No network listener beyond localhost.

### Track B — Full hub (optional, dev/power-user)

A `docker-compose.yml` you write yourself: `postgres:15`, hub, sidecar. Gated behind a Preferences toggle, off by default. Build it **only after Track A works end to end**, and only if you need multi-user or remote access. Do not let it block Phase 1–3.

> ### ⚠️ Terminology collision — flag this in your own docs
> "Sidecar" means two different things in this project:
> - **Interchange sidecar** (`apps/sidecar`) — the hub-orchestrated agent host process.
> - **Tauri sidecar** (`externalBin`) — a bundled child executable in a desktop app.
>
> Track A ships an Interchange *host* as a Tauri *sidecar*, and it is **not** `apps/sidecar`. Pick unambiguous names in your codebase (`fin-host`, not `sidecar`) and never use the bare word.

---

## 3. The mapping — deck concept → Interchange primitive

This table is the core of the plan. The framework's primitive vocabulary maps onto the deck with unusual precision.

| Deck concept (slide) | Interchange primitive | Notes |
| --- | --- | --- |
| Deterministic control flow (4) | `defineWorkflow({ steps })` DAG | The Hub decides what runs next; the model only decides what to say inside a step. Already the framework's model. |
| Human gate (4, 16) | `awaitSignal({ name, timeout, onTimeout })` | `timeout` **is** the deck's expiry. On expiry, route to a `proposal_expired` step. Never to auto-approve. |
| Ledger-writing agents (6) | `action` primitives | Deterministic TS handlers. **No model.** |
| Interpretation tier (7) | `action` primitives | Tax math, reconciliation, Monte Carlo — all code. Slide 7: "Arithmetic never happens in a language model." |
| Advisory tier (8) | `step` primitives (real agents) | Strategist, Market Manager, Estate Planner. The only model-backed nodes. |
| Auditor (9) | `action` (re-runs figures) + optional `step` (narrates) | Split it: the *check* is deterministic, the *explanation* is a model. |
| Scheduler & Tickler (9, 17) | `ScheduleTrigger` + `sleep({ until })` | The tax calendar is a workflow, not a cron table. |
| Decision Journal (9) | `action` + append-only table | Also naturally falls out of git commit history. |
| Nightly ingest workflow (15) | Workflow with `gate` on reconciliation result | `gate({ when, then, else })` routes clean vs. provisional. |
| "Downstream held on provisional data" (15) | `gate` → terminal step | The refusal is a branch, not a flag. Critical. |
| One event, eight consequences (18) | `map.over` | Fan-out over subscribers of the life event. |
| Sub-workflows nesting (14) | `childWorkflow({ definition })` | Grants fold into the parent's approved surface. |
| Auditor rejects → redraft (16) | `loop({ while, carry, maxIterations, onExhausted })` | Bounded rework. `maxIterations` stops a model arguing with the Auditor forever. |
| Strategist chat surface (8, 19) | `onTrigger({ on: MailTrigger, body })` | Long-lived event-driven section; one body run per message, all inside one living workflow run. Exactly the chat-inside-the-product shape the deck wants. |
| Escalation (15) | `escalation({ to, data })` | For breaks needing a human that aren't approvals. |
| Separation of duties (4) | `grantRequirements` + `defineTool` scoping | Advisory tier gets zero credential-touching tool factories. Enforced by the tool set, not the prompt. |
| Trust-boundary matrix (13) | `@intx/authz` grants | `{ resource, action, source, effect, conditions }`. Deny-by-default. |
| Credentials, read-only (13, 21) | `credentialBindings` (Track B) / Keychain (Track A) | Withdrawal scope must not exist on the key. |
| Typed messages (12) | ArkType schemas in `state.schema` | The framework already uses ArkType throughout. |
| Every figure reproducible (7, 21) | `action` + `EffectContext` ledger | Effects are idempotent keyed by `effectId`; handler output must be deterministic given its effects. |
| Append-only, as-of dated (4) | Workflow event log + SQLite fact table | The runtime is already append-only; make your ledger match. |
| Audit trail (9) | `AuditStore` + git history + `bin/audit` | `bin/audit --dir <path> --session <id> --json` inspects the tool-authorization trail. |

### The three real agents

Only these get a model, a system prompt, and reasoning budget:

| Agent | Tools it gets | Tools it must never get |
| --- | --- | --- |
| **Strategist** | `ledger_read_aggregates`, `journal_write`, `run_projection` | Any credential tool, any write to a fact table, any order placement |
| **Market Manager** | `ledger_read_positions`, `read_plan_targets`, `emit_proposal` | Account identifiers, balances beyond positions, any execution tool |
| **Estate Planner** | `registry_read`, `document_read`, `emit_finding` | Credentials, execution |

A fourth optional model node: **Auditor narrator**, which explains a deterministic audit verdict in prose. It receives the verdict, never computes it.

---

## 4. Repository layout to create

```
financial-interchange/
├── package.json                    # bun workspaces
├── apps/
│   ├── desktop/                    # Tauri v2 shell
│   │   ├── src-tauri/              # Rust: window, menu, sidecar spawn, Keychain
│   │   └── src/                    # React 19 + TanStack Router GUI
│   └── host/                       # the Interchange host (bun build --compile)
│       └── src/
│           ├── main.ts             # boots ledger, host env, workflow registry
│           ├── ipc.ts              # localhost JSON-RPC / unix socket to the GUI
│           └── fs-host/            # ★ the WorkflowRuntimeEnv implementation
│               ├── repo-store.ts       # RepoStore over isomorphic-git
│               ├── scheduler.ts        # Scheduler, wall-clock, survives restart
│               ├── signal-channel.ts   # SignalChannel, durable
│               ├── blobs.ts            # BlobSubstrate over the filesystem
│               ├── effects.ts          # EffectLedger (exactly-once)
│               ├── step-invoker.ts     # StepInvoker → createAgent().send()
│               └── action-invoker.ts   # ActionInvoker → handler registry
├── packages/
│   ├── ledger/                     # SQLite schema, migrations, fact API
│   ├── contracts/                  # ★ ArkType schemas — WRITE THIS FIRST
│   ├── actions/                    # every deterministic handler
│   │   ├── ingest/  normalize/  reconcile/
│   │   ├── tax/  risk/  projections/
│   │   └── audit/  journal/
│   ├── agents/                     # the three model-backed agents
│   ├── tools/                      # defineTool bundles, scoped per agent
│   ├── policy/                     # @intx/authz grants — the §13 matrix as code
│   └── workflows/                  # defineWorkflow definitions
└── docs/
    ├── BREAK_GLASS.md              # ★ deck slide 21 — executor operation
    └── THREAT_MODEL.md
```

---

## 5. Data model (Phase 1, before anything else)

The deck: *"Write the schema before the agents. The data model is the architecture."*

### Core invariants

1. **Append-only.** No `UPDATE`, no `DELETE` on fact tables. A corrected 1099 is a **new row** superseding an old one by id, never an overwrite.
2. **Bitemporal.** Every fact carries `observed_at` (when we learned it) and `effective_at` (when it was true). This is what makes "what did we know on March 3rd?" answerable.
3. **Provenance is mandatory.** Every fact carries `source_id` and `source_document_id`. A fact without provenance is inadmissible.
4. **One writer per fact.** Enforce it in the ledger API: each table has exactly one owning action handler, checked at write time. No second handler may correct a table behind the owner's back.

### Sketch

```sql
CREATE TABLE fact (
  id             TEXT PRIMARY KEY,        -- fact_<ulid>
  kind           TEXT NOT NULL,           -- position | transaction | obligation | ...
  subject        TEXT NOT NULL,           -- acct.brokerage.taxable
  payload        TEXT NOT NULL,           -- JSON, validated against contracts/
  observed_at    TEXT NOT NULL,
  effective_at   TEXT NOT NULL,
  source_id      TEXT NOT NULL,
  source_doc_id  TEXT,
  supersedes     TEXT REFERENCES fact(id),
  writer         TEXT NOT NULL,           -- owning handler; enforced
  provisional    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX fact_asof ON fact(kind, subject, effective_at, observed_at);
```

Plus: `finding`, `recommendation`, `approval`, `instruction`, `receipt`, `journal_entry`, `document`, `access_log`.

### Typed messages

Define all six deck message types in `packages/contracts` as ArkType schemas — `Fact`, `Finding`, `Recommendation`, `Approval`, `Instruction`, `Receipt`. Every one carries `id`, `as_of`, and provenance.

Enforce the chain in the workflow topology, not in a validator:

```
Fact → Finding → Recommendation → Approval → Instruction → Receipt
                                      ▲
                            awaitSignal — the only path
```

There must be **no edge** in any workflow DAG from a `Recommendation` step to an execution step that does not pass through an `awaitSignal`. Write a test that walks every `WorkflowDefinition` and asserts this. This is the highest-value test in the codebase.

---

## 6. Phased build

Phases follow the deck's own sequencing (slide 20) — trust accumulates in this order and no other. Each phase ships something usable.

### Phase 0 — Spike (before committing to the architecture)

Prove the risky assumption first: that a filesystem `WorkflowRuntimeEnv` works.

- [ ] Run `examples/agent-quickstart` and `examples/coding-agent` unmodified.
- [ ] Read `packages/workflow/src/runlocal/*` in full. It is your reference implementation.
- [ ] Implement `RepoStore`, `Scheduler`, `SignalChannel`, `BlobSubstrate` against the filesystem.
- [ ] Run a three-step toy workflow: `action` → `awaitSignal` → `action`.
- [ ] **Kill the process while parked at the signal. Restart. Deliver the signal. Assert the run resumes and completes.**

**Gate:** if crash-resume across a parked signal doesn't work, stop and reconsider Track B. Everything downstream depends on it.

### Phase 1 — Ledger (deck: "boring, and everything else rests on it")

- [ ] `packages/contracts` — all six message schemas.
- [ ] `packages/ledger` — schema, migrations, append-only enforcement, as-of query API, one-writer check.
- [ ] Document Vault: file ingest, storage, original-page retention as evidence.
- [ ] **One institution end to end**: fetch → normalise → reconcile → commit → display. One vertical slice, per the deck.
- [ ] Reconciliation action handler detecting the five silent errors from slide 10: double-booked internal transfers, stale-but-live-looking balances, corrected 1099s, missing cost basis on transferred lots, crypto swaps as taxable events.
- [ ] Nightly workflow with the `gate` on reconciliation result. **Downstream must refuse to run on provisional data.**
- [ ] GUI: net worth, positions, exception queue. Every number clickable back to fact → source document → observed date.

**Acceptance:** two institutions reconcile nightly; an injected duplicate transfer is caught and queued rather than silently absorbed; `observed_at` history survives a corrected statement.

### Phase 2 — Time and obligations ("nothing surprises you")

- [ ] Tax Engine as `action` handlers: running estimate, lot-level gains, wash-sale watch, safe-harbour coverage.
- [ ] Tax-year standing workflow: `ScheduleTrigger` + `sleep({ until })` for each deadline (slide 17).
- [ ] Cash Flow pre-staged reserve — park the estimate before the deadline.
- [ ] Exception queue in the GUI.
- [ ] `escalation` for breaks needing a human.

**Acceptance:** a simulated Q3 with a mid-year income change produces a corrected estimate and funds it from reserve without a forced sale.

### Phase 3 — Judgement ("advice that finally has a memory")

- [ ] Strategist agent as an `onTrigger` section over a mail trigger.
- [ ] Projections: deterministic Monte Carlo in code, narrated by the model. The model never produces a figure.
- [ ] Entity & Estate Registry + hygiene audit.
- [ ] Estate Planner agent.
- [ ] Decision Journal wired to every material decision.

**Acceptance:** the slide-19 question — *"If I sell the rental next spring, what does that do to the Q2 estimate and the trust schedule?"* — returns an answer where every figure is a clickable ledger fact and the thesis lands in the journal.

### Phase 4 — Action ("only once the audit trail is real")

- [ ] Market Manager emitting `Recommendation`s with thesis, evidence ids, expiry.
- [ ] Auditor: deterministic re-run of every figure; blocks on the four conditions in slide 16.
- [ ] `loop` for Auditor-rejected redrafts, bounded.
- [ ] Approval queue as the **home screen**. Chat is a tool inside the product, not the product.
- [ ] Scoped, bounded, revocable, expiring approvals via `awaitSignal`.

> **Stop at "prepare the order."** The deck's own recommendation (slide 16) is to make execution optional for a long time: *"A system that prepares the order and leaves you to place it captures most of the value at a fraction of the risk."* Ship Phase 4 with execution disabled. Treat live execution as a separate Phase 5 with its own decision, and note the deck's regulatory item (slide 21) — automated trading, advice framing, and recordkeeping carry rules that belong with an accountant and attorney before you enable it.

### Phase 5 — Execution (only on an explicit, separate decision)

- [ ] Execution as the **only** component holding a write-scoped credential.
- [ ] Receipt capture → straight back into Reconciliation.
- [ ] Kill switch reachable from the menu bar.

---

## 7. The macOS application

### 7.1 Shell

**Tauri v2.** Smaller than Electron, native menu bar, straightforward notarization, and first-class support for bundled child binaries (`externalBin`) — which is exactly how the host process ships.

Build the host with `bun build --compile --target=bun-darwin-arm64` into a single executable. Ship both arm64 and x64, or a universal binary.

The GUI is React 19 + TanStack Router — deliberately the same stack as `apps/admin-ui`, so you can crib its patterns for run lists, event streams, and grant editing.

### 7.2 Startup sequence

```
double-click
  → Tauri window opens, shows a splash
  → spawn fin-host sidecar
  → host: open/create ~/Library/Application Support/FinInterchange/
  → host: run SQLite migrations
  → host: rehydrate scheduler from persisted timers
  → host: resume any parked workflow runs   ← must work; Phase 0 gate
  → host: signal ready over IPC
  → GUI: render approval queue (home screen)
```

Ship a first-run wizard: create the vault, connect one institution read-only, run the first reconciliation.

### 7.3 Credentials

Track A has no hub credential service. Use the **macOS Keychain** via Tauri's Rust side. Non-negotiable rules from slide 13 and 21:

- Read-only API keys wherever the institution supports it.
- **Withdrawal scope must not exist on the key.** Not "unused" — absent.
- The GUI process never sees key material; only the host does, and only at the moment of use.
- Maintain an access log: which handler read what, when.

### 7.4 Signing and distribution

Developer ID signing + notarization + stapling. Hardened runtime. `.dmg` distribution. Budget real time for notarization of a bundle containing a compiled Bun binary — entitlements for JIT are the usual snag.

### 7.5 Break-glass (deck slide 21 — build this from day one)

*"An estate system your executor cannot read or shut down is a liability."*

- [ ] Plain-language full export: every fact, document, and decision as CSV + PDF, readable with no software from this project.
- [ ] A printed one-page operating guide generated by the app.
- [ ] A documented shutdown path that revokes every credential.
- [ ] Test it by handing a laptop and the printout to someone who has never seen the app.

---

## 8. Sharp edges — verified against the tree

Every item here is something the implementing agent will otherwise hit at the worst moment.

1. **Agent steps do not return structured data.** The production step-invoker surfaces every agent step's output as a `{ reply, turn }` envelope. An agent that "returns `{ tasks }`" actually surfaces `{ reply: "{\"tasks\":[…]}", turn }`, and terminal-tool call arguments **do not survive on `turn`**. So `map.over` and `input.from` selectors **cannot** read a field from a real agent step's output.
   **Consequence for this product:** the whole design is typed messages flowing between steps. You must bridge every agent step through a **parse `action`** that reads `steps.<agent>.output.reply`, parses it, validates it against the ArkType contract, and returns a plain object downstream selectors can navigate. Budget for this everywhere an agent feeds a fan-out. See `tests/workflow-deploy/per-level-pipeline-real-agents.test.ts` for a worked example.

2. **The hub's Approvals API is stubbed.** Every endpoint under `/api/tenants/:tenantId/approvals` returns **501**, and `/api/me/approvals` returns an empty array regardless of pending approvals. Do **not** build the approval queue on it, even on Track B. Build on `awaitSignal` + signal delivery (`POST /api/tenants/:tenantId/workflows/:runId/signals` on Track B, your local `SignalChannel` on Track A). The `signalId` is caller-supplied and deduped by the run state machine — generate it deterministically from the proposal id so a double-click cannot double-approve.

3. **Signal-channel rehydration is explicitly an open design question.** The `SignalChannel` interface is in-process and callback-based; on resume its in-memory queue is empty even though the state machine's `unconsumedSignals` still carries the queued signals. The repo names three possible resolutions and picks none. **You must decide this** in `fs-host/signal-channel.ts`. Recommended: rehydrate from the event log on startup. This is the Phase 0 gate for a reason.

4. **`invokeAction`, `spawnSuspendableChild`, `runLoopIteration`, and `loopFns` are optional env fields.** A host that doesn't wire them doesn't support `action`, `onTrigger`, or `loop` — and fails **loudly** at runtime, not at definition time. This product needs all of them. Wire them in Phase 0.

5. **Loop `while`/`carry` and action `handler` are string refs resolved through registries**, so definitions stay hashable. `while`/`carry` receive only data, never an effect context, and **run on every resume** — they must be genuinely side-effect free.

6. **Loop bodies may not contain `loop`, `awaitSignal`, `sleep`, or `childWorkflow`.** Enforced at definition time. Your Auditor-rework loop therefore cannot contain the human approval gate. Structure it as: `loop` (draft ↔ audit) → exits → `awaitSignal` (human).

7. **Step ids must match `/^[a-zA-Z0-9_-]+$/`** — they become mail-address local-parts by string concatenation.

8. **`drainBehavior` defaults matter at redeploy.** `onTrigger` defaults to `"wait"` so a live chat isn't abandoned mid-conversation. Set it deliberately on every long-lived primitive — an approval parked overnight must not be cancelled by a morning redeploy.

9. **Action handlers carry contracts the runtime cannot enforce.** Every external effect must run through `EffectContext.perform`; each effect must be idempotent keyed by its `effectId` (check-then-act) or atomic with its ledger record; and the handler's output must be deterministic given its effects' results, because **on crash-resume the handler body is replayed** against ledger hits. Violating this in an execution handler is how you place an order twice. Code-review every handler against these three rules.

10. **Alpha means alpha.** `0.3.0`, wire formats still moving, and the repo notes a "documentation accuracy pass" is in progress — some design docs are ahead of the code. Pin exact versions, vendor a lockfile, and re-read the changelog before every upgrade.

11. **Grant requirements need a live creator.** Creator-sourced requirements resolve against `creatorPrincipalId` at *every* launch, and a creator cannot delegate authority they no longer hold. On Track B, plan for ownership transfer; this is also an estate concern.

12. **`bun install` is not run by the Makefile.** `make build` fails with `TS2307: Cannot find module '@intx/...'` if you skip it. Also `git config core.hooksPath .githooks` — `bin/check-env` gates every make target on it.

---

## 9. Testing and acceptance

### Must-have tests

- [ ] **Topology test:** no path from a `Recommendation`-producing step to an execution step bypasses an `awaitSignal`. Walk every `WorkflowDefinition`.
- [ ] **Capability test:** assert the slide-13 matrix cell by cell. Strategist has no credential tool. Market Manager cannot see account numbers. Advisory tier has zero write access.
- [ ] **Crash-resume:** kill the host at each of — mid-fetch, mid-reconcile, parked at signal, mid-action-effect. All four resume correctly and none double-executes.
- [ ] **Provisional containment:** inject a break; assert Tax and Market steps refuse to run and the item appears in the morning queue with both versions side by side.
- [ ] **The five silent errors** (slide 10): one fixture each, all detected.
- [ ] **Reproducibility:** every figure in every `Recommendation` re-derives from ledger facts by id. The Auditor blocks anything it cannot reproduce.
- [ ] **Expiry:** an approval past its window routes to expired, never to execution.
- [ ] **Idempotent approval:** delivering the same `signalId` twice produces one instruction.
- [ ] **Break-glass:** export opens and is comprehensible with the app uninstalled.

### Definition of done for v1 (Phases 1–4, execution disabled)

The app is double-clickable and signed; it reconciles a real set of institutions nightly without silent failure; the approval queue is the home screen; every number traces to a dated, sourced fact; and an executor with the printed guide can read and shut down the system without help.

---

## 10. Explicitly out of scope for v1

- Live order execution (separate decision — see Phase 5).
- Multi-user / multi-tenant (Track B only).
- Cross-tenant federation, remote tools, MCP/A2A discovery, networked mail transport, host-failure migration — all **planned but not in the Interchange tree**. Do not design against them.
- Mobile. The hub's route structure is deliberately mobile-friendly, but that's a Track B future.
- Windows/Linux builds.

---

## Appendix A — Feature coverage checklist

You asked for the plan to exercise as much of Interchange as possible. Coverage:

| Interchange feature | Used | Where |
| --- | --- | --- |
| `defineWorkflow` DAG | ✅ | All workflows |
| `step` (agent) | ✅ | Advisory tier |
| `action` (deterministic effect) | ✅ | Ledger, interpretation, governance |
| `gate` | ✅ | Provisional-data branch |
| `awaitSignal` + timeout | ✅ | Approval gate with expiry |
| `sleep` / `sleep until` | ✅ | Tax calendar |
| `map.over` | ✅ | Life-event fan-out |
| `loop` | ✅ | Auditor rework |
| `childWorkflow` | ✅ | Nested sub-workflows |
| `onTrigger` | ✅ | Strategist chat |
| `escalation` | ✅ | Break handling |
| `ScheduleTrigger` / `MailTrigger` / `ManualTrigger` | ✅ | Nightly / chat / user-initiated |
| `state.schema` (ArkType) | ✅ | Typed messages |
| `grantRequirements` | ✅ | Trust boundaries |
| `credentialBindings` | ⚠️ | Track B only; Keychain on Track A |
| `@intx/authz` | ✅ | Capability matrix |
| `defineTool` + static declarations | ✅ | Per-agent scoped tool sets |
| `EffectLedger` / `EffectContext` | ✅ | Exactly-once effects |
| `AuditStore` | ✅ | Tool-authorization trail |
| Git-backed context, resume, rewind | ✅ | Agent state + run logs |
| Inference failover / hot-swap | ✅ | Provider resilience |
| Compaction + directors | ✅ | Long-lived Strategist section |
| `pendingMarker` correlation | ⚠️ | Alternative approval mechanism; evaluate in Phase 4 |
| Hub, multi-tenancy, admin UI, sidecar orchestration | ⚠️ | Track B only |

---

*This plan describes an architecture. It is not financial, tax, or legal advice; the tax and estate specifics belong with an accountant and attorney, and the regulatory questions on slide 21 should be settled before Phase 5.*
