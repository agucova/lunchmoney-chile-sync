# Racional.cl API surface

Reverse-engineered from an authenticated web session HAR (2026-07-06) plus a live verification
run. Racional is a Firebase web app (project `racional-prod`) fronting a DriveWealth brokerage
account. This documents everything the sync adapter depends on, plus the surface reserved for
future work (transactions, valuation, refresh-token auth). All example values here are
**sanitized** — no real uid, email, tokens, or balances.

The adapter (`src/adapters/racional.ts`) uses only the REST endpoints in §1–2 and the auth flow
in §1. The Firestore surface (§4) is unused in v1 and documented for later.

## Client fingerprint

Requests are sent with a uniform, browser-realistic header set matching the captured session
(Firefox 153 / macOS) so they are indistinguishable from the real web app and don't trip
anti-automation heuristics. Load-bearing headers:

- `User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:153.0) Gecko/20100101 Firefox/153.0`
- `Origin: https://app.racional.cl`, `Referer: https://app.racional.cl/`
- `Accept-Language: en-US,en;q=0.9`, `DNT: 1`, `Sec-GPC: 1`, `Sec-Fetch-*` (cors/empty)
- Firebase auth calls additionally send `X-Client-Version: Firefox/JsCore/8.10.1/FirebaseCore-web`
- `Accept-Encoding` / `Connection` / `Host` / `Content-Length` are left to the runtime (undici
  handles compression + pooling); pinning `zstd` manually would break decompression.

`Accept` varies by call: `application/json, text/plain, */*` (cloud functions, axios default),
`*/*` (Firebase auth), `application/json` (api.racional.cl REST).

## 1. Authentication

Firebase email/password auth gated by a custom device-trust MFA. The Firebase **web API key**
`AIzaSyCHCBAaUWhTc8mGtyqfahJ4cYpeVACoCJk` is a public client identifier shipped in the app
bundle (not a secret; safe to commit).

### 1.1 `POST authMfaStart` — device-trust gate

`https://us-central1-racional-prod.cloudfunctions.net/authMfaStart`

```jsonc
// request
{ "email": "user@example.com", "deviceId": "<uuid>", "method": "email" }
// response (trusted device)
{ "success": true, "canSkipMfa": false, "showMfaModal": false, "statusCode": 200 }
```

- `deviceId` is a client-generated UUID that Racional remembers after a first successful MFA.
  A **trusted** device returns `showMfaModal: false` → login proceeds with no challenge.
- An **untrusted** device is expected to return `showMfaModal: true` and email a one-time code
  (unverified — never captured; we fail closed on it, see adapter). The adapter calls this
  gate _before_ `verifyPassword` to avoid burning a password attempt on an untrusted device.
- `canSkipMfa` observed `false` even for a trusted device; not load-bearing.

### 1.2 `POST verifyPassword` — Firebase sign-in

`https://www.googleapis.com/identitytoolkit/v3/relyingparty/verifyPassword?key=<FIREBASE_KEY>`

```jsonc
// request
{ "email": "user@example.com", "password": "<password>", "returnSecureToken": true }
// response 200
{ "kind": "identitytoolkit#VerifyPasswordResponse", "localId": "<uid>",
  "email": "...", "displayName": "", "registered": true,
  "idToken": "<JWT>", "refreshToken": "<opaque>", "expiresIn": "3600" }
```

- `idToken` is a standard Firebase JWT, ~920 chars, **1 h** lifetime (`expiresIn` seconds).
  Claims: `iss/aud=racional-prod`, `user_id`, `email`, `sign_in_provider: "password"`. No MFA
  claim — MFA is enforced by the app layer (§1.1), not inside the token.
- Error responses are HTTP 400 `{ "error": { "message": "<CODE>", ... } }`. Codes to expect:
  `INVALID_PASSWORD`, `EMAIL_NOT_FOUND`, `INVALID_LOGIN_CREDENTIALS`, `USER_DISABLED`,
  `TOO_MANY_ATTEMPTS_TRY_LATER`. The adapter treats these as fatal auth errors (no retry —
  lockout hygiene).

### 1.3 `POST securetoken …/token` — refresh (reserved, unused in v1)

`https://securetoken.googleapis.com/v1/token?key=<FIREBASE_KEY>`, standard Firebase
`grant_type=refresh_token`. v1 auth is stateless (fresh password sign-in each run); persisting
the `refreshToken` and refreshing here is the planned hardening once per-run sign-in proves
noisy (Google throttling / login alerts).

### 1.4 Client-invoked cloud functions we deliberately skip

- `NotifySuccessfulLogin` (`{ data: { deviceId } }`) — sends the user a login email + push. The
  web app calls it after sign-in; **the adapter never does**, which is what keeps scheduled
  syncs silent.
- `UserUpdateDateCallableGen2` (`{ data: null }`) — pokes the backend to recompute the user's
  portfolio aggregates. Only relevant to the Firestore CLP path (§4); the REST path is always
  live without it.

## 2. Data endpoints (REST)

Both are `GET`, `Authorization: Bearer <idToken>`, host `api.racional.cl`. This is the entire
data surface the adapter reads.

### 2.1 `GET /positions` — holdings

Returns a JSON **array** (empty array = fully divested; legal, not drift). One object per
holding, all monetary fields in **USD**:

```jsonc
{
  "assetId": "AAPL", // ticker
  "amountOfShares": 1.04898772, // fractional shares held
  "sharePriceOriginalCurrency": 309.09, // last price, USD
  "amountUSD": 324.23, // <-- position market value; the field we sum
  "availableAmountOfShares": 1.04898772,
  "availableAmountUSD": 324.2316143748,
  "unrealizedPL": 124.23, // signed
  "unrealizedPLPercent": 62.115, // signed
  "unrealizedDayPL": 0.48, // signed
  "unrealizedDayPLPercent": 0.15, // signed
  "lastUpdated": "2026-07-06T13:54:17.152Z", // ISO 8601 UTC; pricing timestamp
  "avgCost": 190.66, // cost basis / share
  "weight": 0.48, // % of portfolio
}
```

- **Verified invariant:** Σ `amountUSD` over all positions equals the dashboard's headline USD
  portfolio total exactly (to the cent). This is what the adapter pushes as the stocks balance.
- `lastUpdated` reflects live pricing (matched capture time to the minute). The adapter's
  staleness guard rejects the whole payload if the newest `lastUpdated` is older than 7 days.

### 2.2 `GET /positions/buying-power` — cash

```jsonc
{
  "buyingPower": 2500.0, // <-- cash balance the adapter pushes (USD)
  "breakdown": {
    "cashAvailableForTrade": 2500.0,
    "cashAvailableForWithdrawal": 65.46,
    "cashBalance": 65.46, // added upstream 2026-09; settled cash, can be < buyingPower
    "amountUSD": 2500.0,
    "cashFromSellsInTransit": 0,
    "usedDriveWealthValue": true,
    "isPro": true,
  },
  "accountContext": { "cashSettling": 0, "tradingType": "CASH" },
}
```

- `buyingPower == cash` **only for `tradingType: "CASH"`**. A margin account's buying power
  includes leverage and is _not_ a cash balance — the adapter pins `tradingType` to the literal
  `"CASH"` so a future margin upgrade drifts loudly instead of pushing a levered figure as cash.
- `cashSettling` / `cashFromSellsInTransit` semantics are unverified (both 0 in capture). v1
  ignores them and uses `buyingPower` alone; during a settlement window synced cash may
  transiently understate. Known-unknown, not a guessed formula.
- `cashBalance` appeared upstream in 2026-09. In the capture that introduced it,
  `buyingPower` (8272.12) exceeded `cashBalance` (5687.63) with `cashSettling` and
  `cashFromSellsInTransit` both 0 — consistent with a pending deposit counting toward buying
  power before settlement, but unverified. v1 keeps pushing `buyingPower` unchanged.

## 3. Verified cross-checks

- Σ `positions[].amountUSD` == user-doc USD total == dashboard headline (66,871.13 at capture;
  67,111.12 on live re-check — live prices).
- Dashboard CLP total == USD total × daily rate (922.60 at capture), where the rate lives in a
  Firestore `assetValues/{yyyymmdd}` doc (§4). Cash is displayed separately from the stock total.
- ⇒ The pure-REST USD path fully reconstructs the dashboard; Firestore is optional and only
  needed if we ever denominate the LM asset in CLP.

## 4. Firestore surface (unused in v1 — reserved for future work)

The web app opens a Firestore `Listen` streaming channel
(`firestore.googleapis.com/.../Listen/channel`, project `racional-prod`, Bearer idToken) and
subscribes to documents. Not consumed by the adapter; documented because deposits/withdrawals
are the basis for a future transactions facet.

- `users/{uid}` — portfolio aggregates. `lastHistoricEvolution.totalAmount` (CLP) +
  `.portfolioEvolutionUSD.totalAmount` (USD); `periodReferences` (week/month/ytd/year indices);
  `assetValuesUpdatedAt`. Recomputed when the app calls `UserUpdateDateCallableGen2` (§1.4);
  `waitingForPortfolioCalculation` flags an in-flight recompute.
- `portfolios/{portfolioId}` — one per portfolio (e.g. "Mis acciones", "Depósito a Plazo"),
  each with its own `lastHistoricEvolution` (CLP + USD legs), `strategicPortfolioComposition`,
  `riskLevel`. Sub-collection `historicTotalAmounts/{allTime,year,…}` holds time series.
- `assetValues/{yyyymmdd}` — daily reference values including the USD↔CLP rate used to render
  the CLP dashboard figure. (Its field shape was not re-sent in the capture; verify before use.)
- `deposits/{…}` and `withdrawals/{…}` collections — the **full** contribution/withdrawal
  history keyed by uid + timestamp + amount. Future: book these as transactions and reconcile
  against bank-side transfers.
- `businessConstants/*`, `appTextsCL/*`, `campaigns/*`, `contributionStrategies/{uid}` — app
  config / content; not financial data.

## 5. Reliability notes

- Undocumented private API: field sets can change without notice. The adapter parses money-path
  payloads (§2) with **strict** zod and fails closed on any unknown/missing field, persisting the
  raw payload to `fixtures/raw/`. Auth responses (§1) are parsed **loosely** (third-party
  surfaces that grow fields and carry no money) requiring only the fields we act on.
- Single-capture schemas: legitimate-but-unseen variants (fields that appear only for e.g.
  dividends-in-transit) will alert as drift early on; each is a one-line schema fix.
- Device-trust TTL is unknown. If trust lapses, the adapter fails with an actionable
  "re-capture a trusted deviceId" error rather than silently.
