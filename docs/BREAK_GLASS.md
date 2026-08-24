# Break-glass (deck slide 21)

*"An estate system your executor cannot read or shut down is a
liability."* This document is for the person operating the system when
the owner cannot — and for the owner, ahead of time, to make sure that
person will succeed.

## The one-button version

Open the app → **Documents → Break-glass export** (or run
`fin-host export`). That writes a timestamped folder containing:

- **OPERATING-GUIDE.pdf** — a printed guide generated from the live
  data: what the system is, who can act, where everything lives, how to
  shut it down. **Print it and keep it with the estate papers.** Regenerate
  it whenever accounts or executors change.
- **index.html** — a self-contained overview linking everything below.
- **csv/** — accounts, balances, positions, transactions, obligations,
  entities and titling, findings with their resolutions, the decision
  journal, every proposal with its audit verdict and decision, and the
  complete fact history. Plain CSV; any spreadsheet opens them.
- **documents/** — every original statement, 1099, deed and policy from
  the vault, under its real filename, with a checksum manifest.

Nothing in the export needs software from this project. That property is
tested (`apps/host/test/break-glass.test.ts` reads an export with nothing
but the filesystem and a naive CSV parser).

## Shutting the system down

1. **Stop the app** (quit it, or `Ctrl+C` the `fin-host serve` process).
   Every schedule — nightly reconciles, tax deadlines, parked approvals —
   lives inside that process; nothing else runs anywhere.
2. **Revoke the AI key**: delete the `fin-interchange` item in Keychain
   Access (or unset `ANTHROPIC_API_KEY`). The advisory agents stop;
   nothing else is affected.
3. **Revoke institution access at each institution.** The system only
   ever held read-only access (file drops in Phase 1+; read-only tokens
   if API connectors were added). No credential it ever held could move
   money — that is a design invariant, not a configuration.
4. **Keep the data directory** (`~/Library/Application
   Support/FinInterchange`) or a fresh export: it is inert files (SQLite,
   git repositories, documents) that the accountant and the estate will
   want.

## What the system never did

- It never held a withdrawal- or transfer-scoped credential.
- It never placed an order. Proposals required the operator's signature
  on a scoped, bounded, expiring approval — and even then, instructions
  were only **prepared** for a human to place (execution was disabled
  through v1).
- It never overwrote a record: everything is append-only and dated, so
  the history in the export is complete.

## The owner's checklist (do this while you can)

- [ ] Name executors and a digital-access note in `estate.json`; run the
      estate audit until `executor_gap` stays clear.
- [ ] Run a break-glass export; print OPERATING-GUIDE.pdf; store it with
      the will.
- [ ] Hand the printout and a laptop to someone who has never seen the
      app, and watch them find the balances and shut it down. Fix
      whatever confused them; re-export.
- [ ] Re-export after any structural change (new institution, new trust,
      new executor).
