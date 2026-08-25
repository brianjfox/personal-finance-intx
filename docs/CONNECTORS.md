# Connectors (Plaid, Enable Banking, Coinbase, watch-only wallets)

Two API connectors join the file-drop adapters: **Plaid** (US/Canada,
including Chase via OAuth) and **Enable Banking** (2,700+ European banks
under PSD2). Both are read-only by construction — Plaid because only
data products are called (never Transfer), Enable Banking because AIS
consent cannot move money by regulation. The design invariant holds: no
credential with withdrawal scope exists anywhere in the system.

Both are ordinary institution adapters: each nightly fetch maps the
provider's response onto the same `InstitutionSnapshot` contract the
file drops produce, and the raw JSON responses are stored in the vault
as evidence. Everything downstream — normalise, reconcile, the queue,
the GUI — is unchanged.

## Secrets

Connector credentials never live in `institutions.json`. They resolve
through one secret store: **environment variables first, then the macOS
login Keychain** (the Anthropic-key pattern from PACKAGING §7.3).

| Service (Keychain `-s`) | Account (`-a`) | What |
| --- | --- | --- |
| `fin-plaid` | `client_id` | your Plaid client id |
| `fin-plaid` | `secret` | your Plaid secret |
| `fin-plaid` | `access_token:<institution_id>` | per-connection token (stored by the connect flow) |
| `fin-enablebanking` | `app_id` | your Enable Banking application id |
| `fin-enablebanking` | `private_key` | the RSA private key PEM registered with that app |
| `fin-enablebanking` | `session:<institution_id>` | per-connection session (stored by the connect flow) |

Environment override for any of these: `FIN_SECRET_<SERVICE>_<ACCOUNT>`
uppercased with non-alphanumerics as `_` — e.g.
`FIN_SECRET_FIN_PLAID_CLIENT_ID`. Per-connection tokens are written by
the GUI connect flows into the Keychain; you only ever store the four
top rows yourself:

```bash
security add-generic-password -U -s fin-plaid -a client_id -w '<CLIENT_ID>'
security add-generic-password -U -s fin-plaid -a secret    -w '<SECRET>'
security add-generic-password -U -s fin-enablebanking -a app_id      -w '<APP_ID>'
security add-generic-password -U -s fin-enablebanking -a private_key -w "$(cat key.pem)"
```

## Plaid setup (once)

1. Create a Plaid account (dashboard.plaid.com), get `client_id` +
   `secret`. The free Trial tier (10 production Items) covers one
   household; sandbox is free and fake.
2. Store them (above). Set `FIN_PLAID_ENV=sandbox` to point the app at
   the sandbox instead of production.
3. In the GUI: Institutions → Connect an institution → "Connect
   automatically — US & Canadian banks". Step 1 opens Plaid **Hosted
   Link** in the browser (you log in on the bank's page; credentials
   never touch this app); step 2 exchanges the finished session for the
   read-only access token, stores it, and reconciles.

Reconnect (bank forces a re-login): the connection's card → Reconnect.

## Enable Banking setup (once)

1. Register at enablebanking.com, create an **application**, generate an
   RSA keypair, upload the public key. For personal use their free
   *restricted mode* applies: whitelist/link your own bank accounts in
   their portal — no contract, no AISP license of your own.
2. Register a **redirect URL** on the application and set it for the
   host: `FIN_EB_REDIRECT_URL=https://...` (the GUI's finish box accepts
   the whole redirected address, so any registered URL works).
3. Store `app_id` and `private_key` (above).
4. In the GUI: Institutions → Connect an institution → "Connect
   automatically — European banks": country → bank → the bank's own
   consent page (SCA happens there) → paste the code/address you were
   redirected to → Finish.

PSD2 consent expires every 90–180 days by regulation. The card shows
"Bank permission valid until …", warns in the last two weeks, and the
Reconnect button repeats the consent for the same institution (no
duplicate entry, history intact). An expired consent degrades to a
plain-words problem on the card, never a crash.

## Coinbase (crypto holdings)

Create an API key in Coinbase (Settings → API) with the **View**
permission ONLY — the trade/transfer scopes must be absent, not unused.
Then in the GUI: Institutions → Connect an institution → "Connect
Coinbase": paste the key name (`organizations/…/apiKeys/…`) and the EC
private key PEM. Both go into the Keychain (service `fin-coinbase`,
accounts `api_key_name:<institution_id>` / `private_key:<institution_id>`)
via the host; the GUI never stores anything. Auth is Coinbase's CDP
scheme: a fresh ES256 JWT per request, bound to that request's
method+host+path, 2-minute validity. Balances come from
`/api/v3/brokerage/accounts` (paginated); USD folds into cash, everything
else becomes a `crypto` position priced by the public `-USD` spot
endpoint. Unpriced assets stay as positions with an unknown value —
never a made-up one. Key rotation: the card's "Replace the API key".

## Watch-only wallets (Ledger, Trezor, any address)

A hardware wallet is read WITHOUT the device: paste public addresses
(in Ledger Live: each account's receive address). An address can show
balances but can never move funds — read-only is structural, not a
permission. Supported rows: Bitcoin address (via mempool.space),
Bitcoin **legacy** xpub (via blockchain.info/multiaddr — a modern segwit
`zpub` is NOT supported by that API and would report 0; paste addresses
instead), Ethereum address (native ETH via a public JSON-RPC node).
Prices from Coinbase's public spot endpoint. Satoshis and wei are
converted with BigInt string math — quantities never touch floats.

**Privacy trade-off, stated plainly**: each nightly discloses the
watched addresses to the public chain-data services (mempool.space,
blockchain.info, the ETH RPC operator). The endpoints are configurable
in the registry entry's options (`btc_api`, `btc_xpub_api`, `eth_rpc`,
`price_api`) for self-hosted explorers/nodes.

## Testing

- `packages/institutions/test/connectors.test.ts` — hermetic: both
  adapters against local mocks of the documented APIs (shapes, sign
  conventions, ISO balance codes, pagination, tolerated errors).
- `apps/host/test/connectors-host.test.ts` — hermetic: both **connect
  flows** end to end through the App (mock APIs → registry entry →
  secret stored → nightly → ledger; reconnect reuses the institution).
- `packages/institutions/test/crypto-connectors.test.ts` +
  `apps/host/test/connectors-host.test.ts` — hermetic: Coinbase (JWT
  verified with the real public key, pagination, fiat/crypto
  classification) and wallet (sat/wei BigInt conversion, xpub/address/
  ETH summing) adapters and both connect flows against local mocks.
- `packages/institutions/test/connectors-live.test.ts` — gated:
  - `PLAID_CLIENT_ID` + `PLAID_SECRET` → mints a sandbox item at
    sandbox.plaid.com and runs the adapter against it.
  - `ENABLE_BANKING_APP_ID` + `ENABLE_BANKING_PRIVATE_KEY_PATH` →
    verifies the JWT against the real API (bank list, Mock ASPSP);
    add `ENABLE_BANKING_SESSION_ID` from a completed consent to run a
    full adapter fetch.
- `packages/institutions/test/crypto-connectors-live.test.ts` — gated:
  - `COINBASE_API_KEY_NAME` + `COINBASE_PRIVATE_KEY_PATH` → real
    read-only accounts fetch through the adapter.
  - `WALLET_BTC_ADDRESS` / `WALLET_ETH_ADDRESS` → real chain queries.

For debugging, `FIN_PLAID_BASE_URL` / `FIN_EB_BASE_URL` point the host
at a mock or proxy.

## Known limits

- **Multi-currency**: a EUR account enters net worth at face value —
  no FX conversion exists yet. Deciding how to convert (dated FX-rate
  facts vs per-currency reporting) is its own design decision, recorded
  as deferred in DECISIONS D-024.
- Plaid investment cost-basis/lot data is spottier than a broker's own
  export; missing basis surfaces as the existing `missing_cost_basis`
  finding.
- PSD2 covers payment accounts — European brokerage holdings stay on
  file drops or typed-in values.
- Enable Banking's free restricted mode covers the operator's own linked
  accounts (this app's use case). Distributing the app for *other*
  households' European banks needs their contract or per-user app
  registrations.
