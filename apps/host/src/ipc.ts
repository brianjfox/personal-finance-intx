// IPC: a localhost HTTP/JSON surface for the GUI (BUILD_PLAN §4 `ipc.ts`).
// Read endpoints serve the ledger views; the two writes are "start a
// nightly" and "resolve a finding" (the operator's answer, appended and
// dated). Binds 127.0.0.1 only. Also serves the built GUI when present.

import fs from "node:fs";
import path from "node:path";

import { resolveFinding, views } from "@fin/ledger";
import { AccountType, ChatAgent, HouseholdProfileInput, ProjectionRequest, ResolutionDecision, ScenarioRequest, TaxStage } from "@fin/contracts";
import { detectWalletHolding } from "@fin/institutions";
import { type } from "arktype";

import type { App } from "./app";
import { InferenceSettingsV2, type InferenceTask } from "./inference";
import { userDir, type UserManager } from "./users";

export interface IpcOptions {
  /** Single-household mode (tests, CLI one-offs). */
  app?: App;
  /** Multi-user mode: requests carry x-fin-user and each user gets their own App. */
  users?: UserManager;
  port?: number;
  hostname?: string;
  /** When set, only these Host-header values are served (strip the port; lowercase). Blunts DNS rebinding once the bind widens past loopback. */
  allowedHosts?: ReadonlySet<string>;
  /** LAN exposure control (wired by `serve`): read state + addresses; set persists the choice and rebinds. */
  lan?: { get: () => { enabled: boolean; addresses: string[] }; set: (enabled: boolean) => void };
  /** Directory holding the built GUI (index.html + assets). */
  guiDir?: string;
  operator?: string;
  /** Test seam for /api/open: receives openCommand's argv, returns the exit status (default: Bun.spawn). */
  openSpawner?: (argv: readonly string[]) => Promise<number | null>;
}

/**
 * The platform's URL opener as real argv. The URL must always arrive
 * as a single argv element that no shell re-parses: cmd.exe's `start`
 * would execute metacharacters (& | ^ ...) embedded in a URL, so
 * win32 uses rundll32's FileProtocolHandler instead.
 */
export function openCommand(platform: string, url: string): string[] {
  return platform === "darwin" ? ["open", url]
    : platform === "win32" ? ["rundll32", "url.dll,FileProtocolHandler", url]
    : ["xdg-open", url];
}

const LanBody = type({ enabled: "boolean" });
const AccountIgnoreBody = type({ account_id: "string > 0", ignored: "boolean" });
const ReorderBody = type({ order: "string[]" });

const ResolveBody = type({
  decision: ResolutionDecision,
  "note?": "string",
  "decided_by?": "string",
});

const TaxYearBody = type({ "year?": "number.integer >= 1990" });
const TaxProfileBody = type({
  tax_year: "number.integer >= 1990",
  ordinary_rate: "string > 0",
  ltcg_rate: "string > 0",
  prior_year_tax: "string > 0",
  prior_year_agi_over_150k: "boolean",
  withholding_annual: "string > 0",
  reserve_account: "string > 0",
  "prestage_lead_days?": "1 <= number.integer <= 90",
});
const TaxCheckBody = type({ quarter: "1 <= number.integer <= 4", stage: TaxStage });
const TaxSkipBody = type({ quarter: "1 <= number.integer <= 4", stage: TaxStage, "note?": "string" });
const ChatBody = type({ agent: ChatAgent, text: "string > 0", "wait?": "boolean" });
const DecideBody = type({
  decision: "'approve' | 'reject'",
  "bound?": type({ "max_quantity?": "string | null", "limit_price?": "string | null" }),
  "note?": "string",
});
const AddInstitutionBody = type({ name: "string > 0", mode: "'managed' | 'files'", "category?": "'real_estate' | 'crypto'" });
const RenameBody = type({ name: "string > 0" });
const EnabledBody = type({ enabled: "boolean" });
const ManagedAccountBody = type({
  "account_id?": "string",
  name: "string > 0",
  type: AccountType,
  "currency?": /^[A-Z0-9]{2,10}$/,
  value: "string > 0",
});
const RemoveAccountBody = type({ account_id: "string > 0" });
const PlaidStartBody = type({ "name?": "string", "institution_id?": "string" });
const PlaidCompleteBody = type({ "name?": "string > 0", "institution_id?": "string > 0", "link_token?": "string > 0", "public_token?": "string > 0" });
const EbStartBody = type({ "name?": "string > 0", "institution_id?": "string > 0", country: /^[A-Z]{2}$/, bank: "string > 0", "redirect_url?": "string > 0" });
const EbCompleteBody = type({ state: "string > 0", code: "string > 0" });
// https anywhere; plain http only back to this host's own loopback (document
// links); and the macOS Settings deep-link scheme, so a permission refusal
// can walk the operator straight to the right pane.
const OpenBody = type({
  url: /^(https:\/\/[^\s]+|http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/[^\s]*|x-apple\.systempreferences:[A-Za-z0-9._?&=-]+)$/,
});
const CoinbaseBody = type({
  "name?": "string > 0",
  "institution_id?": "string > 0",
  // Optional: a pasted CDP key file (JSON in private_key) carries its own name.
  "api_key_name?": "string",
  private_key: "string > 0",
});
const KrakenBody = type({
  "name?": "string > 0",
  "institution_id?": "string > 0",
  api_key: "string > 0",
  private_key: "string > 0",
});
const WalletRow = type({
  value: "string > 0",
  "label?": "string",
  // Optional: rows without a kind are chain-detected from the address syntax.
  "kind?": "'btc_address' | 'btc_xpub' | 'eth_address' | 'ltc_address' | 'sol_address'",
});
const WalletBody = type({
  "name?": "string > 0",
  holdings: WalletRow.array().atLeastLength(1),
});
const CredentialSetBody = type({ id: "'anthropic' | 'plaid' | 'enablebanking'", values: "Record<string, string>" });
const CredentialDeleteBody = type({ id: "'anthropic' | 'plaid' | 'enablebanking'" });
const TokensDeleteBody = type({ institution_id: "string > 0" });
// The lax input shape: dates as typed ("nov 3 1977"); saveProfile normalizes.
const ProfileBody = HouseholdProfileInput.and(type({ "clear_ssn?": "boolean" }));
const ExtractBody = type({ text: "string > 0" });
const InferenceBody = type({ settings: InferenceSettingsV2, "keys?": "Record<string, string>" });
const InferenceTestBody = type({ "task?": "'profile' | 'estate' | 'tax' | 'strategy'", "provider?": "string" });

const UserAddBody = type({ name: "string > 0", "password?": "string" });
const LoginBody = type({ user: "string > 0", password: "string" });
const ChangePasswordBody = type({ old_password: "string", new_password: "string" });
const SetPasswordBody = type({ user: "string > 0", password: "string" });

export function startIpc(opts: IpcOptions): ReturnType<typeof Bun.serve> {
  if (opts.app === undefined && opts.users === undefined) throw new Error("startIpc: pass app or users");
  const operator = opts.operator ?? process.env["USER"] ?? "operator";
  const guiDir = opts.guiDir ?? null;
  const running = new Map<string, Promise<unknown>>();

  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body, null, 0), { status, headers: { "content-type": "application/json" } });
  const notFound = (): Response => json({ error: "not found" }, 404);

  const server = Bun.serve({
    hostname: opts.hostname ?? "127.0.0.1",
    port: opts.port ?? 7777,
    idleTimeout: 120,
    async fetch(req) {
      // A request must name this host to be served: a hostile page that
      // DNS-rebinds its own name to this address arrives with the wrong
      // Host header and gets nothing.
      if (opts.allowedHosts !== undefined) {
        const host = (req.headers.get("host") ?? "").toLowerCase().replace(/:\d+$/, "");
        if (!opts.allowedHosts.has(host)) return json({ error: "unrecognized Host header" }, 403);
      }
      const url = new URL(req.url);
      const p = url.pathname;
      const q = url.searchParams;
      const asOf = { ...(q.get("effective_at") ? { effectiveAt: q.get("effective_at") as string } : {}), ...(q.get("observed_at") ? { observedAt: q.get("observed_at") as string } : {}) };
      try {
        // User plumbing first: these must work before any user exists.
        if (p === "/api/health") {
          // platform lets the GUI word its copy truthfully before anyone signs in.
          return json({ ok: true, dataDir: opts.users?.rootDir ?? opts.app!.dataDir, platform: process.platform, now: new Date().toISOString() });
        }
        if (p === "/api/users" && req.method === "GET") {
          return json({ multi_user: opts.users !== undefined, users: opts.users?.list() ?? [] });
        }
        if (p === "/api/users" && req.method === "POST") {
          if (opts.users === undefined) return json({ error: "this host runs single-user" }, 400);
          const body = UserAddBody(await req.json());
          if (body instanceof type.errors) return json({ error: body.summary }, 400);
          if (body.password === undefined || body.password === "") return json({ error: "a password is required" }, 400);
          const made = opts.users.add(body.name, body.password);
          // Creating yourself signs you in.
          const sess = opts.users.login(made.id, body.password);
          return json({ user: made, token: sess?.token ?? null }, 201);
        }
        if (p === "/api/login" && req.method === "POST" && opts.users !== undefined) {
          const body = LoginBody(await req.json());
          if (body instanceof type.errors) return json({ error: body.summary }, 400);
          const target = opts.users.list().find((u) => u.id === body.user || u.name.toLowerCase() === body.user.trim().toLowerCase());
          if (target !== undefined && !target.password_set) {
            return json({ error: `${target.name} has no password yet -- set one first`, needs_password: true }, 409);
          }
          const sess = opts.users.login(body.user, body.password);
          if (sess === null) return json({ error: "wrong username or password" }, 401);
          return json(sess);
        }
        if (p === "/api/set-password" && req.method === "POST" && opts.users !== undefined) {
          // First-time only (the migrated user); once set, it cannot be
          // changed this way -- the manager refuses.
          const body = SetPasswordBody(await req.json());
          if (body instanceof type.errors) return json({ error: body.summary }, 400);
          const u = opts.users.setPassword(body.user, body.password);
          const sess = opts.users.login(u.id, body.password);
          return json({ user: u, token: sess?.token ?? null });
        }
        if (p === "/api/logout" && req.method === "POST" && opts.users !== undefined) {
          const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
          opts.users.logout(token);
          return json({ ok: true });
        }
        // Identity comes from the SESSION, never from anything the client
        // asserts: a user sees exactly their own data. Only /api/ needs
        // it -- the GUI's static files stay public (they hold no data).
        let app: App = null as unknown as App;
        let meId: string | null = null;
        if (p.startsWith("/api/")) {
          if (opts.users !== undefined) {
            const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
            const me = token === "" ? null : opts.users.sessionUser(token);
            if (me === null) return json({ error: "login required" }, 401);
            meId = me.id;
            app = opts.users.appFor(me.id);
          } else {
            app = opts.app!;
          }
        }
        if (p === "/api/me/rename" && req.method === "POST" && opts.users !== undefined && meId !== null) {
          const body = RenameBody(await req.json());
          if (body instanceof type.errors) return json({ error: body.summary }, 400);
          return json(opts.users.renameUser(meId, body.name));
        }
        if (p === "/api/me/password" && req.method === "POST" && opts.users !== undefined && meId !== null) {
          const body = ChangePasswordBody(await req.json());
          if (body instanceof type.errors) return json({ error: body.summary }, 400);
          if (!opts.users.changePassword(meId, body.old_password, body.new_password)) {
            return json({ error: "the current password isn't right" }, 403);
          }
          return json({ ok: true });
        }
        if (p === "/api/lan" && req.method === "GET") {
          return json(opts.lan !== undefined ? opts.lan.get() : { enabled: false, addresses: [] });
        }
        if (p === "/api/lan" && req.method === "POST") {
          if (opts.lan === undefined) return json({ error: "LAN control is only available under `serve`" }, 400);
          const body = LanBody(await req.json());
          if (body instanceof type.errors) return json({ error: body.summary }, 400);
          try {
            opts.lan.set(body.enabled);
          } catch (e) {
            return json({ error: e instanceof Error ? e.message : String(e) }, 400);
          }
          return json(opts.lan.get());
        }
        if (p === "/api/fx") return json(await app.getFx());
        if (p === "/api/net-worth") {
          const fx = await app.getFx();
          return json(views.netWorth(app.ledger, { ...asOf, currency: fx.to, rates: fx.rates }));
        }
        if (p === "/api/cashflow") {
          const fx = await app.getFx();
          const months = Number(q.get("months") ?? 12);
          return json(views.cashFlow(app.ledger, { ...asOf, currency: fx.to, rates: fx.rates, ...(Number.isFinite(months) ? { months } : {}) }));
        }
        if (p === "/api/accounts") return json(views.accounts(app.ledger, asOf));
        if (p === "/api/balances") return json(views.balances(app.ledger, asOf));
        if (p === "/api/positions") {
          return json(q.get("consolidated") === "1" ? views.consolidatedPositions(app.ledger, asOf) : views.positions(app.ledger, asOf));
        }
        if (p === "/api/transactions") {
          const subject = q.get("subject");
          return json(views.transactions(app.ledger, { ...asOf, ...(subject ? { subject } : {}) }));
        }
        if (p === "/api/queue") return json(app.ledger.openFindings({ requiresHuman: true }));
        if (p === "/api/findings") return json(app.ledger.allFindings(Number(q.get("limit") ?? 200)));
        if (p === "/api/provisional") return json([...app.ledger.provisionalSubjects().keys()]);
        if (p === "/api/documents") return json(app.ledger.listDocuments());
        if (p === "/api/journal") return json(app.ledger.listJournal());
        if (p === "/api/access-log") return json(app.ledger.listAccess(Number(q.get("limit") ?? 200)));
        if (p === "/api/events") return json(app.ledger.eventsSince(Number(q.get("since") ?? 0)));
        if (p === "/api/batches") return json(app.ledger.listBatches());
        if (p === "/api/institutions" && req.method === "GET") return json(app.institutions().entries);
        if (p === "/api/institutions-overview") return json(app.institutionsOverview());
        if (p === "/api/plan" && req.method === "GET") return json(app.planStatus());
        if (p === "/api/institutions/reorder" && req.method === "POST") {
          const body = ReorderBody(await req.json());
          if (body instanceof type.errors) return json({ error: body.summary }, 400);
          return json({ changed: app.reorderInstitutions(body.order) });
        }
        if (p === "/api/account/ignore" && req.method === "POST") {
          const body = AccountIgnoreBody(await req.json());
          if (body instanceof type.errors) return json({ error: body.summary }, 400);
          app.setAccountIgnored(body.account_id, body.ignored);
          return json({ ok: true });
        }
        if (p === "/api/institutions" && req.method === "POST") {
          const body = AddInstitutionBody(await req.json());
          if (body instanceof type.errors) return json({ error: body.summary }, 400);
          return json(app.addInstitution(body), 201);
        }
        {
          const m = /^\/api\/institution\/([^/]+)\/fetch-log$/.exec(p);
          if (m !== null && req.method === "GET") return json(app.getFetchLogs(m[1] as string));
        }
        {
          const m = /^\/api\/institution\/([^/]+)\/rename$/.exec(p);
          if (m !== null && req.method === "POST") {
            const body = RenameBody(await req.json());
            if (body instanceof type.errors) return json({ error: body.summary }, 400);
            if (!app.renameInstitution(m[1] as string, body.name)) return json({ error: "unknown institution" }, 404);
            return json({ ok: true });
          }
        }
        if (p === "/api/plaid/test" && req.method === "POST") return json(await app.testPlaid());
        if (p === "/api/demo" && req.method === "POST") return json(await app.seedDemoData());
        // The GUI runs inside the Tauri webview, where window.open() to an
        // external site is blocked -- the host opens the default browser.
        if (p === "/api/open" && req.method === "POST") {
          const body = OpenBody(await req.json());
          if (body instanceof type.errors) return json({ error: body.summary }, 400);
          if (body.url.startsWith("x-apple.systempreferences:") && process.platform !== "darwin") {
            return json({ error: "that link opens macOS System Settings, which this machine doesn't have" }, 400);
          }
          const spawner = opts.openSpawner ?? ((argv: readonly string[]) => Bun.spawn([...argv], { stdout: "ignore", stderr: "ignore" }).exited);
          return json({ opened: (await spawner(openCommand(process.platform, body.url))) === 0 });
        }
        if (p === "/api/connect/plaid/start" && req.method === "POST") {
          const body = PlaidStartBody(await req.json().catch(() => ({})));
          if (body instanceof type.errors) return json({ error: body.summary }, 400);
          return json(await app.connectPlaidStart({ ...(body.name !== undefined ? { name: body.name } : {}), ...(body.institution_id !== undefined ? { institutionId: body.institution_id } : {}) }));
        }
        if (p === "/api/connect/plaid/pending" && req.method === "GET") return json(app.plaidPending());
        if (p === "/api/connect/plaid/complete" && req.method === "POST") {
          const body = PlaidCompleteBody(await req.json().catch(() => ({})));
          if (body instanceof type.errors) return json({ error: body.summary }, 400);
          return json(
            await app.connectPlaidComplete({
              ...(body.name !== undefined ? { name: body.name } : {}),
              ...(body.institution_id !== undefined ? { institutionId: body.institution_id } : {}),
              ...(body.link_token !== undefined ? { linkToken: body.link_token } : {}),
              ...(body.public_token !== undefined ? { publicToken: body.public_token } : {}),
            }),
          );
        }
        if (p === "/api/connect/eb/banks") {
          const country = (q.get("country") ?? "").toUpperCase();
          if (!/^[A-Z]{2}$/.test(country)) return json({ error: "country must be a two-letter code" }, 400);
          return json(await app.ebListBanks(country));
        }
        if (p === "/api/connect/eb/start" && req.method === "POST") {
          const body = EbStartBody(await req.json());
          if (body instanceof type.errors) return json({ error: body.summary }, 400);
          return json(
            await app.connectEbStart({
              ...(body.name !== undefined ? { name: body.name } : {}),
              ...(body.institution_id !== undefined ? { institutionId: body.institution_id } : {}),
              country: body.country,
              bank: body.bank,
              ...(body.redirect_url !== undefined ? { redirectUrl: body.redirect_url } : {}),
            }),
          );
        }
        if (p === "/api/connect/eb/complete" && req.method === "POST") {
          const body = EbCompleteBody(await req.json());
          if (body instanceof type.errors) return json({ error: body.summary }, 400);
          return json(await app.connectEbComplete({ state: body.state, code: body.code }));
        }
        if (p === "/api/connect/coinbase" && req.method === "POST") {
          const body = CoinbaseBody(await req.json());
          if (body instanceof type.errors) return json({ error: body.summary }, 400);
          return json(
            await app.connectCoinbase({
              ...(body.name !== undefined ? { name: body.name } : {}),
              ...(body.institution_id !== undefined ? { institutionId: body.institution_id } : {}),
              apiKeyName: body.api_key_name ?? "",
              privateKey: body.private_key,
            }),
          );
        }
        if (p === "/api/delete-all-data" && req.method === "POST") {
          // The factory reset for THIS user. The GUI confirms with typed
          // text before calling; afterwards the host exits so nothing
          // re-creates files, and the next launch starts clean.
          if (opts.users !== undefined) {
            const u = opts.users.list().find((x) => userDir(opts.users!.rootDir, x.id) === app.dataDir);
            if (u === undefined) return json({ error: "no such user" }, 400);
            opts.users.deleteUser(u.id);
          } else {
            app.deleteAllData();
          }
          setTimeout(() => process.exit(0), 400);
          return json({ ok: true });
        }
        if (p === "/api/profile" && req.method === "GET") return json(app.getProfile());
        if (p === "/api/profile" && req.method === "POST") {
          const body = ProfileBody(await req.json());
          if (body instanceof type.errors) return json({ error: body.summary }, 400);
          app.saveProfile(body);
          return json(app.getProfile());
        }
        if (p === "/api/profile/extract" && req.method === "POST") {
          const body = ExtractBody(await req.json());
          if (body instanceof type.errors) return json({ error: body.summary }, 400);
          return json(await app.extractProfile(body.text));
        }
        if (p === "/api/inference" && req.method === "GET") return json(app.getInferenceSettings());
        if (p === "/api/inference" && req.method === "POST") {
          const body = InferenceBody(await req.json());
          if (body instanceof type.errors) return json({ error: body.summary }, 400);
          app.setInferenceSettings(body.settings, body.keys);
          return json(app.getInferenceSettings());
        }
        if (p === "/api/inference/test" && req.method === "POST") {
          const body = InferenceTestBody(await req.json().catch(() => ({})));
          if (body instanceof type.errors) return json({ error: body.summary }, 400);
          return json(
            await app.testInference({
              ...(body.task !== undefined ? { task: body.task as InferenceTask } : {}),
              ...(body.provider !== undefined ? { provider: body.provider } : {}),
            }),
          );
        }
        if (p === "/api/credentials" && req.method === "GET") return json(app.credentialsStatus());
        if (p === "/api/credentials/set" && req.method === "POST") {
          const body = CredentialSetBody(await req.json());
          if (body instanceof type.errors) return json({ error: body.summary }, 400);
          app.setCredential(body.id, body.values);
          return json({ saved: true });
        }
        if (p === "/api/credentials/delete" && req.method === "POST") {
          const body = CredentialDeleteBody(await req.json());
          if (body instanceof type.errors) return json({ error: body.summary }, 400);
          return json({ removed: app.deleteCredential(body.id) });
        }
        if (p === "/api/credentials/tokens/delete" && req.method === "POST") {
          const body = TokensDeleteBody(await req.json());
          if (body instanceof type.errors) return json({ error: body.summary }, 400);
          return json({ removed: app.deleteConnectionTokens(body.institution_id) });
        }
        if (p === "/api/ledgerlive/accounts") {
          const file = q.get("file");
          return json(await app.ledgerLiveAccounts(file ?? undefined));
        }
        if (p === "/api/wallet/detect") {
          return json(detectWalletHolding(q.get("value") ?? ""));
        }
        if (p === "/api/connect/kraken" && req.method === "POST") {
          const body = KrakenBody(await req.json());
          if (body instanceof type.errors) return json({ error: body.summary }, 400);
          return json(
            await app.connectKraken({
              ...(body.name !== undefined ? { name: body.name } : {}),
              ...(body.institution_id !== undefined ? { institutionId: body.institution_id } : {}),
              apiKey: body.api_key,
              privateKey: body.private_key,
            }),
          );
        }
        if (p === "/api/connect/wallet" && req.method === "POST") {
          const body = WalletBody(await req.json());
          if (body instanceof type.errors) return json({ error: body.summary }, 400);
          return json(await app.connectWallet({ ...(body.name !== undefined ? { name: body.name } : {}), holdings: body.holdings }));
        }
        const instMatch = /^\/api\/institution\/([A-Za-z0-9_.-]+)\/(delete|enabled|refresh|upload|accounts|account|remove-account)$/.exec(p);
        if (instMatch !== null) {
          const instId = instMatch[1] as string;
          const sub = instMatch[2] as string;
          if (sub === "accounts" && req.method === "GET") return json(app.managedAccounts(instId));
          if (req.method === "POST") {
            if (sub === "delete") return json({ removed: app.removeInstitution(instId) });
            if (sub === "refresh") return json(await app.refreshInstitution(instId));
            if (sub === "enabled") {
              const body = EnabledBody(await req.json());
              if (body instanceof type.errors) return json({ error: body.summary }, 400);
              return json({ changed: app.setInstitutionEnabled(instId, body.enabled) });
            }
            if (sub === "upload") {
              const filename = q.get("filename") ?? "upload.json";
              const bytes = new Uint8Array(await req.arrayBuffer());
              if (bytes.length === 0) return json({ error: "empty file" }, 400);
              const stored = app.storeInstitutionFile(instId, filename, bytes);
              const run = await app.refreshInstitution(instId);
              const problems = app.ledger
                .openFindings({ subject: instId })
                .filter((f) => f.code === "fetch_failed")
                .map((f) => f.summary);
              return json({ ...stored, ...run, problems });
            }
            if (sub === "account") {
              const body = ManagedAccountBody(await req.json());
              if (body instanceof type.errors) return json({ error: body.summary }, 400);
              return json(await app.saveManagedAccount(instId, body));
            }
            if (sub === "remove-account") {
              const body = RemoveAccountBody(await req.json());
              if (body instanceof type.errors) return json({ error: body.summary }, 400);
              return json(await app.removeManagedAccount(instId, body.account_id));
            }
          }
        }
        if (p === "/api/runs") return json(await app.listRuns());
        if (p === "/api/obligations") return json(views.obligations(app.ledger));
        if (p === "/api/tax") return json(await app.taxStatus());
        if (p === "/api/tax-profile" && req.method === "POST") {
          const body = TaxProfileBody(await req.json());
          if (body instanceof type.errors) return json({ error: body.summary }, 400);
          return json(app.saveTaxProfile(body));
        }
        if (p === "/api/tax-year" && req.method === "POST") {
          const body = TaxYearBody(await req.json().catch(() => ({})));
          if (body instanceof type.errors) return json({ error: body.summary }, 400);
          return json(await app.startTaxYear(body.year !== undefined ? { year: body.year } : {}), 202);
        }
        if (p === "/api/tax/check" && req.method === "POST") {
          const body = TaxCheckBody(await req.json());
          if (body instanceof type.errors) return json({ error: body.summary }, 400);
          const r = await app.runTaxCheck({ quarter: body.quarter as 1 | 2 | 3 | 4, stage: body.stage });
          return json({ runId: r.runId, status: r.terminalStatus });
        }
        if (p === "/api/estate") return json(app.estateStatus());
        if (p === "/api/export" && req.method === "POST") {
          const r = app.exportBreakGlass();
          return json({ dir: r.dir, files: r.files.length, documents: r.documents });
        }
        if (p === "/api/approvals") return json(app.approvalQueue());
        if (p === "/api/instructions") return json(app.listPreparedInstructions());
        if (p === "/api/proposal" && req.method === "POST") {
          const r = await app.startProposal();
          return json(r, r.state === "queued" ? 200 : 202);
        }
        const decideMatch = /^\/api\/recommendation\/([A-Za-z0-9_.:-]+)\/decide$/.exec(p);
        if (decideMatch !== null && req.method === "POST") {
          const body = DecideBody(await req.json());
          if (body instanceof type.errors) return json({ error: body.summary }, 400);
          const r = await app.decideRecommendation({
            recommendationId: decideMatch[1] as string,
            decision: body.decision,
            ...(body.bound !== undefined ? { bound: body.bound } : {}),
            ...(body.note !== undefined ? { note: body.note } : {}),
            signedBy: operator,
          });
          return json(r);
        }
        const revokeMatch = /^\/api\/instruction\/([A-Za-z0-9_.:-]+)\/revoke$/.exec(p);
        if (revokeMatch !== null && req.method === "POST") {
          const body = (await req.json().catch(() => ({}))) as { note?: string };
          return json(app.revokeInstruction({ instructionId: revokeMatch[1] as string, by: operator, ...(typeof body.note === "string" ? { note: body.note } : {}) }));
        }
        if (p === "/api/estate/audit" && req.method === "POST") {
          const r = await app.runEstateAudit();
          return json({ runId: r.runId, status: r.terminalStatus, audit: r.outputs["audit_estate"] ?? null });
        }
        if (p === "/api/scenario" && req.method === "POST") {
          const body = ScenarioRequest({ kind: "sell_asset", ...((await req.json()) as object) });
          if (body instanceof type.errors) return json({ error: body.summary }, 400);
          return json(app.runScenarioNow(body));
        }
        if (p === "/api/projection" && req.method === "POST") {
          const body = ProjectionRequest(await req.json());
          if (body instanceof type.errors) return json({ error: body.summary }, 400);
          return json(app.runProjectionNow(body));
        }
        const chatMatch = /^\/api\/chat\/(strategist|estate_planner)$/.exec(p);
        if (chatMatch !== null && req.method === "GET") {
          return json(app.chatTranscript(chatMatch[1] as "strategist" | "estate_planner"));
        }
        if (p === "/api/chat" && req.method === "POST") {
          const body = ChatBody(await req.json());
          if (body instanceof type.errors) return json({ error: body.summary }, 400);
          // The connection's idle timeout is 120s; keep the wait under it.
          const r = await app.sendChat({ agent: body.agent, text: body.text, wait: body.wait ?? true, timeoutMs: 100_000 });
          return json(r, r.turn === null ? 202 : 200);
        }
        if (p === "/api/tax/skip" && req.method === "POST") {
          const body = TaxSkipBody(await req.json());
          if (body instanceof type.errors) return json({ error: body.summary }, 400);
          return json(
            await app.skipTaxDeadline({
              quarter: body.quarter as 1 | 2 | 3 | 4,
              stage: body.stage,
              ...(body.note !== undefined ? { note: body.note } : {}),
              decidedBy: operator,
            }),
          );
        }

        let m = /^\/api\/fact\/([A-Za-z0-9_.:-]+)$/.exec(p);
        if (m !== null) {
          const fact = app.ledger.getFact(m[1] as string);
          if (fact === null) return notFound();
          const doc = fact.source_doc_id === null ? null : app.ledger.getDocument(fact.source_doc_id);
          return json({ fact, history: app.ledger.history(fact.id), document: doc });
        }
        m = /^\/api\/finding\/([A-Za-z0-9_.:-]+)$/.exec(p);
        if (m !== null && req.method === "GET") {
          const f = app.ledger.getFinding(m[1] as string);
          if (f === null) return notFound();
          const facts = (ids: string[]) => ids.map((id) => app.ledger.getFact(id)).filter((x) => x !== null);
          return json({ finding: f, before: facts(f.before), after: facts(f.after), evidence: facts(f.evidence) });
        }
        m = /^\/api\/finding\/([A-Za-z0-9_.:-]+)\/resolve$/.exec(p);
        if (m !== null && req.method === "POST") {
          const body = ResolveBody(await req.json());
          if (body instanceof type.errors) return json({ error: body.summary }, 400);
          const r = resolveFinding(app.ledger, {
            findingId: m[1] as string,
            decision: body.decision,
            note: body.note ?? "",
            decidedBy: body.decided_by ?? operator,
            decidedAt: new Date().toISOString(),
          });
          return json(r);
        }
        m = /^\/api\/document\/([A-Za-z0-9_.:-]+)$/.exec(p);
        if (m !== null) {
          const d = app.ledger.getDocument(m[1] as string);
          if (d === null) return notFound();
          return json({ document: d, facts: app.ledger.factsFromDocument(d.id).map((f) => f.id) });
        }
        m = /^\/api\/document\/([A-Za-z0-9_.:-]+)\/bytes$/.exec(p);
        if (m !== null) {
          const d = app.ledger.getDocument(m[1] as string);
          if (d === null) return notFound();
          const bytes = app.vault.read(d.id, "operator");
          return new Response(bytes, { headers: { "content-type": d.mime, "content-disposition": `inline; filename="${d.filename}"` } });
        }
        m = /^\/api\/run\/([A-Za-z0-9_.:-]+)$/.exec(p);
        if (m !== null) {
          const events = await app.runEvents(m[1] as string);
          if (events.length === 0) return notFound();
          const summary = (await app.listRuns()).find((r) => r.runId === m![1]);
          return json({ summary, events });
        }
        if (p === "/api/nightly" && req.method === "POST") {
          const runId = `nightly_${new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15)}`;
          if (!running.has(runId)) {
            const promise = app.runNightly({ runId }).finally(() => running.delete(runId));
            running.set(runId, promise);
            if (q.get("wait") === "1") {
              const result = (await promise) as { terminalStatus: string };
              return json({ runId, status: result.terminalStatus });
            }
          }
          return json({ runId, status: "started" }, 202);
        }
        if (p.startsWith("/api/")) return notFound();

        // GUI
        if (guiDir !== null) {
          const rel = p === "/" ? "index.html" : p.replace(/^\/+/, "");
          const file = path.join(guiDir, rel);
          if (file.startsWith(guiDir) && fs.existsSync(file) && fs.statSync(file).isFile()) {
            return new Response(Bun.file(file));
          }
          const index = path.join(guiDir, "index.html");
          if (fs.existsSync(index)) return new Response(Bun.file(index));
        }
        return new Response("fin-host: GUI not built. Run `bun run build` in apps/desktop.", { status: 404 });
      } catch (e) {
        return json({ error: e instanceof Error ? e.message : String(e) }, 500);
      }
    },
  });
  return server;
}
