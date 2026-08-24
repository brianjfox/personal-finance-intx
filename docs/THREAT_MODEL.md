# Threat model (v1: Phases 1-4, execution disabled)

What can go wrong, what the design does about it, and what it
deliberately does not defend against. Companion to the deck's slide 21
and the capability matrix (`packages/policy/src/matrix.ts`), which is the
enforced form of most of this document.

## Assets

1. **The ledger** (`ledger.db`): the household's complete financial
   record — balances, positions, transactions, tax documents, titling.
2. **The vault**: original statements, 1099s, deeds, trust instruments.
3. **Credentials**: in v1, exactly one secret — the Anthropic API key.
   Institution data arrives by read-only file drop; there are no
   institution tokens yet, and no credential of any kind with
   withdrawal or transfer scope has ever existed in the design.
4. **The operator's judgement**: approvals, resolutions, the plan files.

## Trust boundaries (enforced, not requested)

- **Advisory models are untrusted narrators.** They hold no credentials,
  cannot write any fact table, cannot place or prepare orders, and every
  tool call authorizes as `tool:<name>` against the matrix under the
  step's principal — a compromised or hallucinating model can propose,
  cite, and journal, and nothing else. Figures only ever come from
  deterministic tool results; the Auditor re-runs them and blocks an
  edited number as unreproducible.
- **One writer per fact kind**, checked at the ledger and at the policy
  layer; the interpretation tier is read-only; the human's approvals are
  typed, scoped to one proposal, bounded, expiring, idempotent by signal
  id, and pass through exactly one `awaitSignal` — the topology test
  walks every workflow to prove no path skips it.
- **Execution is disabled in v1.** `execution.prepare` writes a ledger
  row and nothing else; there is no code path that talks to a broker.
- **The host binds 127.0.0.1 only.** No remote surface exists. The GUI
  is same-machine; anyone with local access to the machine is the
  operator (see "out of scope").

## Failure modes considered

| Threat | Mitigation |
| --- | --- |
| Malicious/compromised model output | Tool-set scoping + matrix authz; canonicalized figures; Auditor's four blocks; human gate; execution disabled |
| Prompt injection via institution data | Feed data never reaches a model as instructions: the ledger tier is deterministic code; advisory agents see aggregates/tool results, not raw feeds |
| Silent data corruption (feed lies, duplicates, staleness) | Reconciliation's detectors; provisional holds; downstream refusal; both-versions queue |
| Crash / power loss mid-anything | Append-only event logs, atomic batch writes, effect ledger exactly-once, crash-resume tests at every phase (SIGKILL is part of CI) |
| Double-approve (UI double-click, replayed signal) | Deterministic signal ids; state-machine dedupe; UNIQUE signal_id on the approval row |
| A stale recommendation acted on late | Expiry is a branch: timeout routes to `expired`, never auto-approve; the queue drops dead proposals |
| Key theft (Anthropic) | Key lives in the macOS Keychain, injected into the host's environment at spawn; never written to the ledger, logs, or exports; revocation = delete one Keychain item. Blast radius: someone else's chat bill — the key moves no money |
| Operator dies / is incapacitated | Break-glass export + generated operating guide + executor checklist (`docs/BREAK_GLASS.md`); estate audit raises `executor_gap` until fixed |
| This project's own software vanishes | The export is plain CSV/PDF/HTML; the ledger is standard SQLite; agent history is plain git |

## Out of scope (v1)

- **Local attackers.** Anyone with the operator's macOS session is the
  operator. Disk encryption (FileVault) and OS login are the boundary;
  the app adds no second factor.
- **Institution-side compromise.** A lying institution is detected as a
  reconciliation break, not prevented.
- **Network attackers**: there is no network surface beyond loopback and
  outbound HTTPS to the inference provider.
- **Execution risks** — order tampering, broker credential custody, kill
  switches under live trading — deferred with Phase 5, which requires
  its own decision and its own threat-model revision, plus the
  accountant/attorney conversation on regulatory footing (slide 21).
