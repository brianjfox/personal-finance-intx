// Connect flows for the API connectors (BUILD_PLAN's "when API
// connectors arrive" note in docs/PACKAGING.md §7.3): the browser-based
// handshakes that turn "the operator picked their bank" into a stored
// read-only credential and a registry entry. Secrets go through the
// SecretStore (Keychain in production, memory in tests); the registry
// entry that results holds configuration only.
//
// Plaid: create a Hosted Link session -> the operator finishes in the
// browser -> we read the public_token back from the link token and
// exchange it for the (data-only) access token.
// Enable Banking: list banks -> start a bank consent (the bank's own
// page; SCA happens there) -> the redirect hands back a code -> POST
// /sessions turns it into a 90-180 day read-only session.

import crypto from "node:crypto";

import {
  enableBankingJwt,
  ENABLEBANKING_BASE_URL,
  ENABLEBANKING_SERVICE,
  PLAID_BASE_URLS,
  PLAID_SERVICE,
  type SecretStore,
} from "@fin/institutions";

export interface ConnectorConfig {
  secrets: SecretStore;
  plaidBaseUrl?: string;
  plaidEnvironment?: keyof typeof PLAID_BASE_URLS;
  ebBaseUrl?: string;
  /** Registered with the Enable Banking application; where the bank redirects after consent. */
  ebRedirectUrl?: string;
  coinbaseBaseUrl?: string;
  krakenBaseUrl?: string;
  fxBaseUrl?: string;
  /** Endpoint overrides for watch-only wallets (tests, self-hosted explorers/nodes). */
  walletApis?: Partial<Record<"btc_api" | "btc_xpub_api" | "eth_rpc" | "ltc_api" | "sol_rpc" | "price_api", string>>;
  fetchImpl?: typeof fetch;
  clock?: () => Date;
}

export interface PendingEbConnect {
  name: string;
  /** Set on a reconnect of an existing institution; null for a new connection. */
  institutionId: string | null;
  aspsp: { name: string; country: string };
}

export function createConnectors(cfg: ConnectorConfig) {
  const doFetch = cfg.fetchImpl ?? fetch;
  const clock = cfg.clock ?? (() => new Date());
  const plaidBase = cfg.plaidBaseUrl ?? PLAID_BASE_URLS[cfg.plaidEnvironment ?? "production"];
  const ebBase = cfg.ebBaseUrl ?? ENABLEBANKING_BASE_URL;
  const pendingEb = new Map<string, PendingEbConnect>();

  const plaidCall = async <T>(path: string, body: Record<string, unknown>): Promise<T> => {
    const clientId = cfg.secrets.get(PLAID_SERVICE, "client_id");
    const secret = cfg.secrets.get(PLAID_SERVICE, "secret");
    if (clientId === null || secret === null) {
      throw new Error("Plaid is not set up yet -- add your Plaid Client ID and Secret on the Credentials page first");
    }
    const r = await doFetch(`${plaidBase}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_id: clientId, secret, ...body }),
    });
    const json = (await r.json()) as T & { error_code?: string; error_message?: string };
    if (!r.ok) throw new Error(`plaid ${path}: ${json.error_code ?? r.status} ${json.error_message ?? ""}`.trim());
    return json;
  };

  const ebCall = async <T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> => {
    const appId = cfg.secrets.get(ENABLEBANKING_SERVICE, "app_id");
    const key = cfg.secrets.get(ENABLEBANKING_SERVICE, "private_key");
    if (appId === null || key === null) {
      throw new Error("Enable Banking is not set up yet -- add your Application ID and private key on the Credentials page first");
    }
    const r = await doFetch(`${ebBase}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${enableBankingJwt(appId, key, clock())}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!r.ok) throw new Error(`enablebanking ${path}: ${r.status} ${(await r.text()).slice(0, 300)}`);
    return (await r.json()) as T;
  };

  return {
    /**
     * The wizard's "Save & test": try to mint a Link token and translate
     * Plaid's answer into plain words the operator can act on.
     */
    async plaidTest(): Promise<{ ok: boolean; detail: string }> {
      try {
        await plaidCall<{ link_token: string }>("/link/token/create", {
          client_name: "Financial Interchange",
          language: "en",
          country_codes: ["US"],
          user: { client_user_id: "operator" },
          products: ["transactions"],
          hosted_link: {},
        });
        return { ok: true, detail: "Your Plaid keys work: Link sessions can be created. Note that Chase, Bank of America, and most large US banks also require the one-time OAuth registration on Plaid's site before they appear in Link." };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes("not set up yet")) return { ok: false, detail: msg };
        if (/INVALID_API_KEYS|INVALID_CLIENT_ID|INVALID_SECRET/i.test(msg)) {
          return { ok: false, detail: "Plaid rejected the keys. Check that the Client ID and secret are from the SAME team, and that you copied the Production secret (the Sandbox one only works with fake banks)." };
        }
        if (/INVALID_PRODUCT|PRODUCTS_NOT_ENABLED|NOT_AUTHORIZED/i.test(msg)) {
          return { ok: false, detail: "The keys are real, but this Plaid team can't use the Transactions product yet -- request Production access (pay-as-you-go) in the Plaid dashboard, then test again." };
        }
        if (/ADDITIONAL_CONSENT_REQUIRED|OAUTH/i.test(msg)) {
          return { ok: false, detail: "The keys work, but the bank you want needs Plaid's one-time OAuth registration -- complete it in the Plaid dashboard (Settings, US OAuth institutions)." };
        }
        return { ok: false, detail: msg };
      }
    },
    /** Step 1: a Hosted Link session the operator opens in the browser. */
    async plaidLinkStart(): Promise<{ link_token: string; hosted_link_url: string | null }> {
      const r = await plaidCall<{ link_token: string; hosted_link_url?: string | null }>("/link/token/create", {
        client_name: "Financial Interchange",
        language: "en",
        country_codes: ["US"],
        user: { client_user_id: "operator" },
        products: ["transactions"],
        optional_products: ["investments", "liabilities"],
        hosted_link: {},
      });
      return { link_token: r.link_token, hosted_link_url: r.hosted_link_url ?? null };
    },

    /**
     * Step 2: after the operator finishes Hosted Link, read the public
     * token back and exchange it. A directly supplied public_token
     * (sandbox flows, tests) skips the lookup.
     */
    async plaidExchange(opts: { linkToken?: string; publicToken?: string }): Promise<{ accessToken: string; itemId: string | null }> {
      let publicToken = opts.publicToken ?? null;
      if (publicToken === null) {
        if (opts.linkToken === undefined) throw new Error("plaid: need a link_token or a public_token to finish connecting");
        const got = await plaidCall<{ link_sessions?: Array<{ results?: { item_add_results?: Array<{ public_token?: string }> } }> }>(
          "/link/token/get",
          { link_token: opts.linkToken },
        );
        publicToken = got.link_sessions?.flatMap((s) => s.results?.item_add_results ?? []).find((x) => x.public_token)?.public_token ?? null;
        if (publicToken === null) {
          throw new Error("plaid: the Link session hasn't finished yet -- complete the bank login in the browser, then try again");
        }
      }
      const ex = await plaidCall<{ access_token: string; item_id?: string }>("/item/public_token/exchange", { public_token: publicToken });
      return { accessToken: ex.access_token, itemId: ex.item_id ?? null };
    },

    async ebListBanks(country: string): Promise<Array<{ name: string; country: string }>> {
      const r = await ebCall<{ aspsps: Array<{ name: string; country: string }> }>("GET", `/aspsps?country=${encodeURIComponent(country)}`);
      return r.aspsps.map((a) => ({ name: a.name, country: a.country }));
    },

    /** Start a bank consent; the returned URL is the bank's own page. */
    async ebAuthStart(opts: { name: string; institutionId?: string; country: string; bank: string; redirectUrl?: string; validDays?: number }): Promise<{ url: string; state: string }> {
      const redirect = opts.redirectUrl ?? cfg.ebRedirectUrl;
      if (redirect === undefined) {
        throw new Error("enablebanking: no redirect URL -- enter the one registered with your Enable Banking application (enablebanking.com -> API applications -> Redirect URLs)");
      }
      const state = crypto.randomUUID();
      const validUntil = new Date(clock().getTime() + (opts.validDays ?? 180) * 86_400_000).toISOString();
      const r = await ebCall<{ url: string }>("POST", "/auth", {
        access: { valid_until: validUntil },
        aspsp: { name: opts.bank, country: opts.country },
        state,
        redirect_url: redirect,
        psu_type: "personal",
      });
      pendingEb.set(state, { name: opts.name, institutionId: opts.institutionId ?? null, aspsp: { name: opts.bank, country: opts.country } });
      return { url: r.url, state };
    },

    ebPending(state: string): PendingEbConnect | null {
      return pendingEb.get(state) ?? null;
    },

    /** The redirect's code becomes the session. */
    async ebSessionCreate(code: string): Promise<{ sessionId: string; validUntil: string | null; aspsp: { name?: string; country?: string } | null }> {
      const r = await ebCall<{ session_id: string; access?: { valid_until?: string }; aspsp?: { name?: string; country?: string } }>(
        "POST",
        "/sessions",
        { code },
      );
      return { sessionId: r.session_id, validUntil: r.access?.valid_until ?? null, aspsp: r.aspsp ?? null };
    },
  };
}

export type Connectors = ReturnType<typeof createConnectors>;
