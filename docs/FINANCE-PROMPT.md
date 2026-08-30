I want to create a set of agents that help me manage my finances. The agents will run inside of an interchange Hub.  The main interface will be a gui that has several workflows built into it, each one of which might have sub-workflows as required. There will be an Assets Manager agent, which  has the job of managing the information about my assets -- gathering them, using tools to connect to my banks and/or coinbase, etc. There will be a Taxes agent, which keeps track of my taxes, and reminds me to make payments when they are due.  There will be a Strategist agent which presents a chat box and brainstorms with me about strategies for managing my finances, wills, and my estate.  There will be a Market Manager that might advise me on what stocks or ETFs I should acquire.  What other agents should I have?  How should they communicate with each other?  What types of workflows will I need?  I would like to create a slide deck that talks about this product.

[ The above was used for the initial discussion starter with Claude.  Some of the brainstorming was not captured.  The output of the discussions where the deck and then the deck was used to create the build-plan.  We completed building phases I through IV, and we have a signed, distributal double-clickable MacOS app.  That app expects some input data to be present in json files, and so now I will tell the builder that it should gather that information and write those files ifself. ]

Currently, the app declares:

<app-text>
Welcome. Connect an institution read-only: list it in /Users/bfox/Library/Application Support/FinInterchange/institutions.json and drop an export into /Users/bfox/Library/Application Support/FinInterchange/institutions/<id>/inbox/ (JSON snapshot, or CSV with a column map). Or seed the fictional demo: fin-host init --demo 1.
</app-text>

This is an app for a non-programmer to use.  The user won't understand JSON data formats, or how to create files in their home directory.  They won't even be able to run "fin-host init --demo 1".  I would like the app to present two options when there is absolutely no data: "Currently, there are no institutions connected, and there's no other data for us to work with." And then two buttons: 1) "Click here to start connecting your institutions" and 2) "Click here to start with a bunch of made up data".

If there is already data present, the user should be able to add or delete institutions and modify their connected status.  The user should be able to manage the data about their assets in general using the GUI.

Whenever a number representing a fiat currency is being entered, be prepared to read the currency symbol and any other marks, such as commas and periods.  The type of currency should be stored with the value.  When displaying values, convert all currencies DYNAMICALLY into the user's preferred currency.

--------------------------------------------------------------------------------------------------------------------------------

We need to include Coinbase as a place to learn about crypto holdings, and we should be able to read a ledger wallet.
Most importantly -- the GUI is the place that the end user will interact with.  Users don't want to learn about the security CLI and how to use the command line.  So the user should be able to paste API keys and secrets once, and the app should store those in the Keychain.  The user should also be able to delete or modify those credentials.

--------------------------------------------------------------------------------------------------------------------------------

The estate planner should have both the chat box, and present a wizard to collect information that an estate planner must have!  For example, spouse, children, other people who should appear in a will, etc.  Please note that there's no onboarding path in place for collecting a user's name, social, country of origin, country of residence, etc.  We need this information available in the user's profile, and it should be collected from any agent that needs it (e.g, Estate Planning, Tax Planning). The chat box should be 4-6 lines tall, and the text should wrap.
--------------------------------------------------------------------------------------------------------------------------------

In the settings, the user should be able to assign an inference provider to each of Profile, Estate, Tax, and Strategy.
--------------------------------------------------------------------------------------------------------------------------------

The user should be able to provide multiple inference providers.  The form for doing so should show the most common ones in a dropdown, with an "Other OpenAI compatible Provider" option allowing the end user to specify the URL and keys.

--------------------------------------------------------------------------------------------------------------------------------
 If a user is entering text into a chat box, and then clicks away to a different tab, the text that has already been entered when the user returns to the original chat box.

--------------------------------------------------------------------------------------------------------------------------------
 A sample will produced by the Estate Planner should be saved as a Document, and be accesible in the Documents panel.  That panel should be tabbed as well, separating the types of documents that stored there, and filterable by creator (Estate, Tax, etc.), type (i.e., PDF, MD, Image, TXT, JSON, etc.), sortable by date, name, and other obvious triggers as you see fit.
 
--------------------------------------------------------------------------------------------------------------------------------
We are going to clean up the UX a little bit.  In Estate and Strategy the previous chats should be collapsed completely, but can be expanded with a disclosure toggle.  A summary of the remembered state should be displayed above the chat box, in an italic font with a subdued color.

--------------------------------------------------------------------------------------------------------------------------------

[Here's the best part of all]

 okay, we're about to do something hard. In a completely new branch, do the following: allow multiple users to use the app, where each user has their own api keys, institutions, assets, and context.  If there are specific features in Interchange that would support the separation of data, etc., use them.

This is a real architectural feature — let me survey the seams first (how the host boots, how createApp isolates state, what Interchange gives us), then design around them.

  Ran 3 shell commands


Since ownership is already keyed off dataDir with injectable secret resolution, I'll implement a user registry/manager, route IPC per user, and add a user picker to the GUI. Starting with the scoped secret store.

⏺ Update(packages/institutions/src/secrets.ts)
Added 15 lines
  };
}

/**
 * One user's slice of a shared store: every account is prefixed with
 * the user's scope, so two users' "anthropic" keys are different
 * Keychain items. The service names stay the same (they're the app's
 * identity); only the account carries the user.
 */
export function scopedSecretStore(base: SecretStore, scope: string): SecretStore {
  const acct = (account: string): string => `${scope}.${account}`;
  return {
    get: (service, account) => base.get(service, acct(account)),
    ...(base.set !== undefined ? { set: (service: string, account: string, value: string) => base.set!(service,
acct(account), value) } : {}),
    ...(base.delete !== undefined ? { delete: (service: string, account: string) => base.delete!(service, acct(a
ccount)) } : {}),
  };
}

/** In-memory store for tests and for capturing tokens mid-connect-flow. */
export function memorySecretStore(initial: Record<string, string> = {}): SecretStore & { dump(): Record<string,
string> } {
  const m = new Map(Object.entries(initial));

Now the user registry and manager:

⏺ Write(apps/host/src/users.ts)
Wrote 197 lines to apps/host/src/users.ts
// Multiple operators on one Mac, one household each. The separation is
// the framework's own: EVERYTHING an operator owns -- ledger, document
// vault, agent context, standing runs, effects, settings -- already
// hangs off a single data directory, so a user simply gets their own
// (`<root>/users/<id>`), each running its own App with its own agents
// and standing runs. Keychain secrets separate the same way: every
// non-primary user resolves credentials through a scoped SecretStore
// that prefixes the account with `u.<id>.`, so two users' Anthropic
// keys are different Keychain items and neither can read the other's.
//
… +187 lines

Now the App options (envAnthropicFallback, mirrorCredentialEnv, keychainSweepOnWipe) and their wiring:

  Ran 1 shell command

Now the IPC layer — per-request user resolution and the /api/users endpoints:

  Ran 2 shell commands

Host side done. Now the GUI: API user header + the user picker and switcher:

  Ran 4 shell commands

Now the App shell: user gate before anything renders, and a switcher in the nav:

  Ran 4 shell commands

Build is clean. Now the tests — migration, isolation (data + secrets + env), and IPC routing:

⏺ Write(apps/host/test/users.test.ts)
Wrote 166 lines to apps/host/test/users.test.ts
// Multiple operators, one Mac: each user is their own data directory
// (ledger, vault, agents, runs) and their own scoped slice of the
// Keychain. A legacy single-user layout migrates into users/primary and
// keeps its unscoped secrets.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
… +156 lines

  Ran 4 shell commands

All 227 tests pass. Shipping the branch, then merging and rebuilding the app:

  Committed 77d444f, pushed to main, wrote 1 memory

Done — built on branch feat/multi-user, merged to main as 2675912, app rebuilt, notarized, and stapled. All 227 tests pass (5 new multi-user tests plus a scoped-store test).

The design leans on the separation Interchange already gives us: everything an operator owns — ledger, document vault, agent context, standing chat runs, effects, settings — already hangs off a single data directory, and secrets resolve through an injectable store. So a user is a data directory plus a Keychain namespace:

- Per-user worlds. Each user lives in users/<id>/ under the app's data folder, running a complete App instance — their own ledger, institutions, documents, profile, inference settings, and their own standing Estate/Strategy agents. Nothing is shared.
- Per-user keys. Non-primary users read and write secrets through a scoped store that prefixes every Keychain account with u.<id>. — your Anthropic key and Bob's are physically different Keychain items. Scoped users also never inherit the process-wide ANTHROPIC_API_KEY, and their credential saves aren't mirrored into the shared process environment, so a missing key fails honestly rather than silently borrowing someone else's.
- Your existing data migrates untouched. On first launch, the current single-user layout moves into users/primary, which keeps the unscoped Keychain accounts it always had — no re-pasting keys, no reconnecting banks. With one user, the app enters directly; no new friction.
- The GUI: a "Who's using Financial Interchange?" gate lists users and adds new ones by name; a 👤 entry at the bottom of the sidebar shows who's signed in and switches users (with a clean reload so no state crosses over). Every request carries the user in an x-fin-user header.
- Lifecycle: fin-host serve boots every user's app (standing runs resume for all); other CLI commands take --user <id> (defaulting to the first user); "Delete all data" now wipes just the signed-in user and removes them from the registry — the Keychain-wide sweep only ever runs for the last unscoped user, so one person's factory reset can't touch another's keys.

Relaunch the app: you'll land in your existing world as "Primary," and the sidebar's 👤 switcher is where a second person gets added.



