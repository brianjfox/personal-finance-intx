# Deck notes — `financial-interchange-hub.pdf`, transcribed

The product deck ("HUB — The Household Financial Interchange", 22 slides)
is the design's source of truth alongside `BUILD_PLAN.md`. The plan cites
slides by number but does not transcribe them; this file carries the
normative content so a working session does not depend on parsing the PDF.
Extracted from the PDF text layer 2026-08-24; the PDF remains authoritative
for anything visual (the slide-5 tier diagram, the slide-19 GUI sketch).

Tagline (slide 1): *"A bench of specialist agents, one shared ledger, and a
human gate on everything that moves money."*

## The five design principles (slide 4)

1. **Separation of duties** — the agents that give advice never hold
   credentials and never write to the ledger. "Borrowed straight from how
   accounting departments avoid fraud."
2. **The ledger is the only truth** — agents coordinate through shared
   state, not by messaging each other. If two agents disagree, the ledger
   settles it.
3. **Append-only and as-of dated** — corrected 1099s and restated balances
   arrive as new facts, never overwrites. You can always ask what was known
   on a given date.
4. **Deterministic control flow** — the Hub decides what runs next. A model
   decides what to say inside a step — never who goes next or whether to
   skip the check.
5. **The human is a node, not an audience** — approval is a typed message
   with a schema, an expiry and a signature. Not a chat prompt you scroll
   past.

## The seventeen agents (slides 5–9)

"Facts flow up. Proposals flow down through a gate. Nothing skips a tier."

**Tier 1 — Ledger, own the facts** (the only agents allowed to write; one
writer per fact, "no second agent may correct the ledger behind the
owner's back"):

- *Assets Manager* — banks, brokerages, Coinbase; owns positions,
  balances, cost basis and tax lots; a read-only token per institution.
- *Liabilities & Obligations* — mortgages, margin, loans, credit lines,
  recurring premiums; refi triggers live here.
- *Cash Flow* — income and spending, classified; nothing else can size a
  tax estimate or answer "can I afford it".
- *Document Vault* — statements, 1099s, K-1s, deeds, policies, trust
  instruments; extracts structured facts and keeps the original page as
  evidence.
- *Entity & Estate Registry* — who owns what, titled how, with which
  beneficiary; trusts, LLCs, joint accounts, executors, and where the keys
  physically are.

**Tier 2 — Interpretation, derive meaning** (read-only over the ledger;
"they compute; they never fetch and never trade"; "arithmetic never
happens in a language model — every figure on this tier is produced by
code the auditor can re-run and reproduce exactly"):

- *Reconciliation* — matches every institution against the ledger, kills
  duplicates, recognises that a transfer between your own accounts is not
  income.
- *Tax Engine* — running estimate of what is owed, lot-level gain
  tracking, wash-sale watch, withholding vs. estimate coverage, every
  deadline.
- *Risk & Insurance* — concentration, FDIC/SIPC limits, custody single
  points of failure, coverage gaps, "what one bad month actually does to
  you".
- *Projections* — scenario and Monte Carlo engine; deterministic maths in
  code, narrated by a model.

**Tier 3 — Advisory, propose only** ("context and reasoning — and no keys
at all"; three constraints: **cite or stay quiet** — every claim links to
ledger facts by id, no evidence no proposal; **expire by default** — a
recommendation older than its window is dead, not stale advice; **log the
reasoning** — the thesis is stored so you can grade it against reality
next year):

- *Strategist* — the chat surface; brainstorms structure, trade-offs and
  long-horizon questions across finances, wills and estate; reads
  aggregates; writes only to the decision journal.
- *Market Manager* — candidate positions, drift against target
  allocation, harvest opportunities; every idea emitted as a proposal with
  a thesis, an evidence list and an expiry date.
- *Estate Planner* — compares the plan on paper to the plan in reality:
  titling, beneficiaries, document versions, digital access, and who can
  operate this system when you cannot.

**Tier 4 — Governance, check and act** ("if you build only one agent from
this tier, build the Auditor"):

- *Auditor* — reviews every proposal before you see it: plan conflicts,
  wash-sale risk, tax-lot impact, and any figure it cannot reproduce.
- *Approvals & Execution* — the only agent with write access to the
  outside world; holds the gate, executes what you signed, captures the
  receipt, reconciles the fill.
- *Security & Access* — credential custody, token rotation, scope
  enforcement, an access log of which agent read what and when.
- *Decision Journal* — what you decided, when, why, and what you
  expected; "financial feedback loops are years long; memory is the only
  way to learn from them."
- *Scheduler & Tickler* — owns time; fires the recurring workflows,
  escalates deadlines, chases the things that quietly did not happen.

## The five silent errors (slide 10)

Reconciliation "is the agent that decides whether any of the rest is
true", and it cannot be the agent that fetched the data. The five, each
"silent, plausible, and expensive":

1. A transfer between your own accounts booked twice as income.
2. A balance that stopped updating four days ago but still looks live.
3. A corrected 1099 that silently changes last year's answer.
4. Cost basis missing on transferred lots, quietly assumed as zero.
5. A crypto swap that is a taxable event no bank feed will mention.

Closing line (slide 15): "A reconciliation agent that resolves ambiguity
on its own is worse than none at all."
(Implemented: `packages/actions/src/reconcile/`, one detector each.)

## The six message types (slide 12)

Fact → Finding → Recommendation → Approval → Instruction → Receipt.
"Every message carries provenance, an as-of timestamp and an id. Anything
without them is not admissible."

- **Fact** — a dated observation with a source. Only ledger agents emit
  these.
- **Finding** — an interpretation: a break, a risk, a gap. Carries
  severity.
- **Recommendation** — a proposed action with a thesis, evidence and an
  expiry.
- **Approval** — your signature on a specific proposal id. Scoped and
  time-boxed.
- **Instruction** — what Execution is permitted to do. Derived only from
  an Approval.
- **Receipt** — what actually happened, fed straight back to
  Reconciliation.

The slide's worked Recommendation example, verbatim (the field vocabulary
`packages/contracts/src/governance.ts` mirrors):

```
id:        rec_2026-08-19-014
from:      market_manager
subject:   acct.brokerage.taxable
action:    SELL 40 VTI
thesis:    "equity 6.2% over target"
evidence:  [pos_881, plan_target_v3]
as_of:     2026-08-19T22:04Z
tax_lots:  [lot_44 LTCG, lot_51 STCG]
confidence: 0.71
requires:  [auditor.review, human.approve]
expires:   2026-08-26
```

## The trust matrix (slide 13)

"Capability scoping is enforced by the Hub, not by asking the agent nicely
in a prompt." The slide's six rows, verbatim:

| Agent | Institution credentials | Read ledger | Write ledger | Place orders | Sees full PII |
| --- | --- | --- | --- | --- | --- |
| Assets Manager | R/O token | yes | own tables | no | yes |
| Tax Engine | no | yes | own tables | no | yes |
| Strategist | no | aggregates | journal only | no | masked |
| Market Manager | no | positions | no | no | masked |
| Auditor | no | yes | no | no | masked |
| Approvals & Execution | scoped, per-order | yes | receipts | on approval | yes |

"The Market Manager never learns your account numbers, and the Strategist
never sees a balance it does not need. A compromised advisory agent should
be embarrassing, not catastrophic."
(Implemented and extended to all seventeen: `packages/policy/src/matrix.ts`;
the slide-13 rows are asserted verbatim in the capability test.)

## Workflow cadence (slide 14)

What the Hub runs, and how often:

- **Continuous** — feed ingestion & normalisation; anomaly and break
  detection; document intake and extraction.
- **Daily** — reconcile all institutions; cash position & liquidity check;
  exception queue triage.
- **Monthly** — net worth close & snapshot; spend vs. plan review; drift
  check against targets.
- **Quarterly** — estimated tax calculation & payment; rebalance proposal
  cycle; access & credential review.
- **Annual** — year-end tax planning window; tax-loss harvest sweep;
  estate & beneficiary hygiene audit; insurance and coverage review.
- **Event-driven** — life events (sale, move, inheritance); new account
  onboarding; proposal → approval → execution.

(Phase 1 covers the daily reconcile; Phase 2 the quarterly estimates. The
monthly close, drift check, credential review, and the annual sweeps are
future workflow definitions.)

## The nightly and its exception path (slide 15)

Fetch (scoped token per institution) → Normalise (canonical schema,
dedupe, classify internal transfers) → Reconcile (flag breaks, staleness,
basis gaps) → Commit (append dated facts with provenance, nothing
overwritten) → Notify (emit events; Tax, Risk and Market agents wake on
what changed).

"The exception path is the real product": break found → ledger marked
provisional for that account, not silently patched → downstream held (Tax
and Market agents refuse to run on provisional data) → queued for you (one
item in the morning queue, with both versions side by side) → resolved as
a fact (your answer is appended and dated — the history stays intact).

## Proposal → execution, and what gates it (slide 16)

Six steps, "one of them irreducibly human": Trigger (drift, deadline, or
you asking) → Proposal (Market Mgr drafts with evidence) → Audit (Auditor
re-runs the numbers) → **Approve** (you sign a scoped, expiring order) →
Execute (only Execution touches the broker) → Record (receipt, reconcile,
journal entry).

**What the Auditor blocks on** (the four conditions BUILD_PLAN's Phase 4
references without listing):

1. A figure it cannot reproduce from ledger facts.
2. Wash-sale collision, or a lot choice that quietly costs you.
3. Conflict with a standing constraint or the written plan.
4. Cash needed for a tax payment inside the horizon.

**What your approval actually is**:

- Scoped to one proposal id, not a standing permission.
- Bounded — max size, limit price, expiry attached.
- Revocable until the instruction is actually sent.
- Stored with the thesis you approved, for later review.

## The tax year as a standing workflow (slide 17)

"Your Taxes agent stops being a reminder service and becomes a calendar
with a balance sheet behind it." The year's marks:

- **Jan–Mar** — 1099s and K-1s land; the Vault ingests, extracts, and
  *chases what has not arrived*.
- **Apr 15** — return filed + Q1 estimate, "funded from a pre-staged
  reserve".
- **Jun 15** — Q2 estimate, "recalculated on actual YTD income, not last
  year's guess".
- **Sep 15** — Q3 estimate, "safe-harbour coverage checked against
  withholding".
- **Oct** — planning window: the Strategist runs scenarios "while there is
  still time to act".
- **Dec 31** — last actions: harvesting, gifting, RMDs, charitable timing
  — all hard stops.

"Owned by Scheduler, calculated by Tax Engine, funded by Cash Flow,
confirmed by Reconciliation — four agents, one workflow."

(Phase 2 implemented the quarterly estimate/pre-stage gates. The Vault's
document chasing, the October planning window and the Dec 31 actions
belong with Phases 3–4.)

## One event, eight consequences (slide 18)

The life-event fan-out (`map.over` in Phase 3/4): the trigger "you sell
the rental property" enters the ledger as a single fact, and the Hub fans
it out — "every one of these is a sub-workflow with its own approval step;
none of them depends on you remembering it":

1. **Tax Engine** — recomputes the gain, depreciation recapture and the Q3
   estimate.
2. **Cash Flow** — reserves the tax before the proceeds get spent or
   reinvested.
3. **Liabilities** — closes the mortgage, ends the escrow and the
   insurance premium.
4. **Risk** — flags the new cash concentration and the lapsed liability
   coverage.
5. **Market Manager** — proposes a staged deployment, not a lump-sum
   decision.
6. **Estate Planner** — removes the deed from the trust schedule; flags
   the will clause.
7. **Registry** — retires the entity, archives the title chain and the
   closing file.
8. **Journal** — records why you sold, and what you expected the proceeds
   to do.

## The interface (slide 19)

"Workflows on the left, evidence in the middle, decisions on the right."
The approval queue is the home surface; the slide's example queue items:

- "Rebalance — sell 40 VTI · Auditor: cleared · LTCG $1,840 · expires Tue"
- "Q3 estimate — $14,200 · Funded from reserve · due Sep 15 · safe harbour
  met"
- "Beneficiary mismatch — IRA · Registry vs. trust schedule · needs your
  decision"

The Strategist box carries the Phase 3 acceptance question verbatim: *"If
I sell the rental next spring, what does that do to the Q2 estimate and
the trust schedule?"*

"One rule for the GUI: every number is clickable back to the fact, the
source document, and the date it was observed."

## Sequencing (slide 20)

01 Ledger first ("boring, and everything else rests on it") → 02 Time and
obligations ("first real payoff: nothing surprises you") → 03 Judgement
("advice that finally has a memory") → 04 Action ("only once the audit
trail is real"). "The tempting order is the reverse. Market advice demos
beautifully on day one and is worth almost nothing without a ledger
underneath it that you believe."

## Open questions (slide 21)

- **Credential blast radius** — read-only tokens wherever possible, no
  withdrawal scope on any key, hardware-backed custody for anything that
  can move value.
- **Models and arithmetic** — never let a language model produce a figure;
  it selects, explains and drafts; deterministic code computes and the
  Auditor re-runs it.
- **Regulatory footing** — automated trading, advice framing and
  recordkeeping all carry rules; talk to the accountant and attorney
  before Phase 4 (execution).
- **Stale data wearing fresh clothes** — feeds break quietly; every fact
  needs an observed-at date and a visible staleness threshold.
- **The gate you stop reading** — "if the approval queue is long and
  boring, you will rubber-stamp it. Batch the routine, escalate only what
  genuinely differs."
- **Who operates it when you cannot** — "an estate system your executor
  cannot read or shut down is a liability. Build the break-glass path and
  the plain-language export from day one."

## Where to start (slide 22)

"Start with the ledger, not the advice." (1) Write the schema before the
agents — "the data model is the architecture." (2) Connect one institution
end to end — "one vertical slice tells you more than six half-built
agents." (3) Decide the trust boundary early — which agents ever hold a
credential, and whether execution is in scope at all; "it is much harder
to retrofit."
