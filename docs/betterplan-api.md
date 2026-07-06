# BetterPlan.cl API — end-to-end reference (2026-07-06)

Reverse-engineered from a logged-in portal HAR **and confirmed against the live API** on
2026-07-06 (transport, auth, and every message schema below were exercised live with the user's
token, not just inferred). Field **names** are exact — extracted from the portal's own
`protoc-gen-ng` (ngx-grpc) client stubs in the SPA JS bundle, then cross-checked against live wire
data. Field **numbers** are the protobuf wire numbers.

Repro tooling in `scratchpad/` (session-local): `grpc_client.py` (live gRPC-web caller + schemaless
decoder), `proto_schema.py` (cross-chunk schema extractor from the JS bundle), `decode_har.py`.

## TL;DR for the adapter

- **Balances + cash, one call**: `portal_goal.PortalGoalGrpcService/ListMe` (empty body) → repeated
  `GoalModel`. Each goal = one holding; `currentCapital` (field 4) is the balance in the goal's own
  currency (`currency.currencyCode`, field 31→9). Cash wallets are goals too. (Equivalent, heavier:
  `user.UserGrpcService/GetMe` → `UserModel.goals`, field 36.)
- **Positions (bonus, works)**: `portal_goal.PortalGoalGrpcService/GetCurrentFundings` `{1:goalId}`
  → per-instrument holdings (name, ticker, quotas, balance, weight). Confirmed live.
- **Transport**: gRPC-web (`application/grpc-web+proto`), POST, Bearer JWT. Cloudflare WAF **requires
  browser-like headers** (a real `User-Agent` + `Origin: https://portal.betterplan.cl`); it is
  header-gated, **not** TLS-fingerprint-gated, so a plain Bun `fetch` with those headers passes.
- **Auth (decided)**: **refresh-token grant with rotation**. IdentityServer4/Duende, public PKCE
  client `portal-ts-code`, no secret. Access token lives 30 days; refresh token rotates on every use.
  Password/ROPC grant is **rejected** for this client (`unauthorized_client`), so raw
  username+password is not usable.

## Hosts

| host                   | role                                                       |
| ---------------------- | ---------------------------------------------------------- |
| `id.betterplan.cl`     | IdentityServer4/Duende OIDC (auth, tokens, JWKS, userinfo) |
| `grpc.betterplan.cl`   | all data — gRPC-web, behind Cloudflare                     |
| `portal.betterplan.cl` | Angular SPA (static chunks, i18n)                          |

Everything else in the HAR (Datadog, Sentry, Intercom, a Supabase status ping) is telemetry.

## Authentication

OIDC discovery: `GET https://id.betterplan.cl/.well-known/openid-configuration`.

- `token_endpoint` = `https://id.betterplan.cl/connect/token`
- `authorization_endpoint` = `https://id.betterplan.cl/connect/authorize`
- Public client **`portal-ts-code`** (no secret), authorization_code + PKCE for interactive login.
- Access-token JWT: `iss=https://id.betterplan.cl`, `aud=https://id.betterplan.cl/resources`,
  `client_id=portal-ts-code`, `sub`=user GUID, `scope` includes `apiv1 apiv2 offline_access`.

### Chosen strategy: refresh-token grant with rotation (verified live)

1. **Bootstrap once (interactive)**: log in through a browser to the portal, capture the
   `refresh_token` from the `POST /connect/token` response (this is exactly what the source HAR
   contained). Recommend a **dedicated** login for the adapter (don't share the browser session's
   token) so the two rotation chains stay independent.
2. **Each run**, exchange for a fresh access token:
   ```
   POST https://id.betterplan.cl/connect/token
   Content-Type: application/x-www-form-urlencoded
   grant_type=refresh_token
   &refresh_token=<stored>
   &scope=openid profile email apiv1 apiv2 offline_access IdentityServerApi
   &client_id=portal-ts-code
   ```
   Response (verified): `access_token` (JWT, `expires_in=2592000` → **30 days**), a **NEW**
   `refresh_token` (rotates every call), `id_token`, `token_type=Bearer`.
3. **Persist the rotated `refresh_token` atomically before use, and fail closed**: if the refresh
   response lacks a new refresh token, or the write fails, abort the run rather than risk bricking
   the chain. Only one holder may use the chain at a time (crash-after-rotate-before-persist breaks
   it → manual re-bootstrap). This matches the repo's fail-closed philosophy.
4. Since the access token is valid 30 days, the adapter can cache it and only refresh when it is
   near expiry (or on a 401), minimizing rotation churn.

**Ruled out empirically:**

- **ROPC / password grant** → `{"error":"unauthorized_client"}` for `portal-ts-code`, even though
  the server advertises `password` in `grant_types_supported`. Do not store raw credentials.
- Scripted headless authorization_code login is possible but fragile (login-form antiforgery +
  cookies, MFA/captcha risk); the 30-day token + rotation makes it unnecessary.

Open risk we could not test in one session: whether the refresh token itself has an **absolute**
lifetime (IdentityServer supports sliding vs absolute). If refreshes start failing after some
weeks/months, that's the cause → re-bootstrap. Treat a failed refresh as "needs re-login", alert,
and stop (fail closed).

## Transport (gRPC-web)

- `POST https://grpc.betterplan.cl/<package>.<Service>/<Method>`
- Required headers:
  - `content-type: application/grpc-web+proto`
  - `x-grpc-web: 1`
  - `authorization: Bearer <access_token>`
  - **WAF-passing browser headers** (mandatory — without them Cloudflare returns a 403 HTML page):
    a real `User-Agent`, `Origin: https://portal.betterplan.cl`, `Referer: https://portal.betterplan.cl/`.
    `Sec-Fetch-*` help but the UA+Origin were sufficient in testing. `Accept-Encoding: identity`
    keeps the framing simple.
- **Framing** (both directions): `1 flag byte` + `4-byte big-endian length` + protobuf payload.
  An empty request message is the 5 bytes `00 00 00 00 00`.
- **Response**: one data frame (flag `0x00`) + one trailer frame (flag `0x80`, body
  `grpc-status: 0\r\n...`). Non-zero `grpc-status` in the trailer = app error. (In a HAR the whole
  body is base64; a live call returns raw bytes.)
- No compression needed; requests are tiny, responses ≤ ~40 KB.

The portal's client is `@ngx-grpc` (`protoc-gen-ng`): messages have `deserializeBinaryFromReader`
switch tables that preserve the real field names — that's how the exact names below were recovered.

## Data model

Three layers, all scoped server-side to the JWT's user (requests carry **no** user id):

1. **Financial entity** (`FinancialEntityModel`) = broker relationship.
   `portal_user.PortalUserGrpcService/GetMeFinancialEntities`. This user has:
   `id 3` = Vector Capital (`uuid "vector"`, CLP), `id 4` = Interactive Brokers /
   BetterplanUS (`uuid "bp-us"`, USD).
2. **Goal** (`GoalModel`, "meta"/"objetivo") = the unit the user holds. Binds one portfolio + one
   financial entity + one currency, and carries the balance. **Cash wallets are goals** too.
3. **Portfolio** (`PortfolioModel`) = the strategy/allocation behind a goal, and the container for
   positions (fundings + composition).

### The goal enumerations (pick one)

- `portal_goal.PortalGoalGrpcService/ListMe` — **preferred**. Empty body → `ListGoalResponse`
  (`values` = repeated `GoalModel`, plus paging fields); populates `currentCapital` per goal
  (verified). Live call returned **8** goals vs the dashboard's 7 — the extra one (`33170`
  "Arriesgado Largo Plazo") has `archived = 1`; the dashboard excludes archived goals. **The adapter
  should skip goals with `archived`/`hidden` set** unless you deliberately want them.
- `user.UserGrpcService/GetMe` — empty body → `UserModel`; `goals` (field 36) is the same list,
  wrapped in a ~40 KB user-profile message. Heavier; use `ListMe` unless you also want profile data.
- `portal_goal.PortalGoalGrpcService/GetMe` — `BaseGetRequest` with a **dynamic-LINQ** predicate
  (e.g. `where.predicate = "id == 34876"`) → a single `GoalModel`. Good for refetching one goal.

## Message schemas (exact names, verified)

Google well-known wrappers recur as single-field messages: **`Int32Value`/`Int64Value`** = `{1:
value}`, **`Timestamp`** = `{1: seconds, 2: nanos}`, **`StringValue`** = `{1: value}`. Below, "→ T"
means a nested message of type T.

### `common_message.GoalModel` — the holding (⇐ the important one)

| #     | name                       | type                     | notes                                                        |
| ----- | -------------------------- | ------------------------ | ------------------------------------------------------------ |
| 2     | initialInvestment          | int32                    |                                                              |
| 3     | monthlyContribution        | int32                    |                                                              |
| **4** | **currentCapital**         | **double**               | **BALANCE, in goal currency. Absent ⇒ 0.**                   |
| 5     | amountsTransactionsPending | double                   | pending in-flight amount                                     |
| 6     | currentContribution        | double                   | net deposits / aporte neto (absent ⇒ 0)                      |
| 7     | dateOfCompletion           | string                   | target date (ISO)                                            |
| 8     | progress                   | double                   | 0–1                                                          |
| 9     | state                      | string                   | e.g. `ready`                                                 |
| 11    | targetAmount               | int32                    | goal target ("monto objetivo")                               |
| 14    | title                      | string                   | **goal name**                                                |
| 18    | id                         | int32                    | **goal id** (used by Irr/GetCurrentFundings/GetMe predicate) |
| 19    | userId                     | int32                    |                                                              |
| 22    | goalCategoryId             | int32                    |                                                              |
| 25    | portfolioId                | →Int32Value              | **portfolio id**                                             |
| 28    | financialEntity            | →FinancialEntityModel    | broker                                                       |
| 30    | portfolio                  | →PortfolioModel          | strategy; positions containers empty unless `include`d       |
| 31    | currency                   | →CurrencyModel           | **goal currency**                                            |
| 32    | goalCategory               | →GoalCategoryModel       | e.g. `general-investments`, `fondo-de-emergencia`            |
| 33    | archived                   | bool                     |                                                              |
| 38    | riskLevel                  | →RiskLevelModel          | e.g. "Muy arriesgado"                                        |
| 39    | displayCurrency            | →CurrencyModel           |                                                              |
| 40    | investmentStrategy         | →InvestmentStrategyModel | e.g. "Flexifolios US", "Caja Pesos"                          |
| 49    | goalType                   | enum                     |                                                              |
| 50    | biceAccountNumber          | string                   |                                                              |
| 51    | hidden                     | bool                     |                                                              |

(Also present: 1 years, 12 signedContract, 13 haveDeposited, 15 haveRequestDeposited, 16
waitingContractApproval, 17 starred, 20/21 created/modified, 23 riskLevelId, 24 financialEntityId,
29 goalNotifications, 34 currencyId, 35 lastDepositDate, 36 haveTransactionsProcessed, 37
displayCurrencyId, 41 enabledEdit, 42 firstTransactionDate, 43/44 imageLarge/Small, 45–47 goal
balance/sale flags, 48 apvConfiguration.)

### `common_message.CurrencyModel`

| #     | name             | notes                                                                        |
| ----- | ---------------- | ---------------------------------------------------------------------------- |
| 1     | id               | 1=CLP, 2=USD, 3=UF, 4=EUR                                                    |
| 4     | name             | "Pesos" / "Dólares"                                                          |
| 5     | uuid             | "peso_chileno" / "dolar"                                                     |
| **9** | **currencyCode** | **ISO — "CLP" / "USD"**                                                      |
| 10    | display          | "$" / "USD "                                                                 |
| 11    | digitsInfo       | Angular format → **exponent**: CLP `"1.0-0"` = 0 decimals, USD `"1.2-2"` = 2 |
| 12    | locale           |                                                                              |
| 15    | vectorCode       |                                                                              |

`digitsInfo` is the authoritative decimal count → maps directly to `src/core/money.ts` exponents
(CLP exp 0, USD exp 2).

### `common_message.FinancialEntityModel`

| #   | name              | notes                                                    |
| --- | ----------------- | -------------------------------------------------------- |
| 1   | id                | 3 = Vector/Betterplan (CLP), 4 = IBKR/BetterplanUS (USD) |
| 9   | title             | "Vector Capital" / "Interactive Brokers"                 |
| 10  | shortTitle        | "Betterplan" / "BetterplanUS"                            |
| 12  | uuid              | "vector" / "bp-us"                                       |
| 15  | defaultCurrencyId |                                                          |
| 16  | defaultCurrency   | →CurrencyModel                                           |
| 19  | hasBalance        | bool                                                     |

### `common_message.PortfolioModel` (goal.field 30) — holds positions

| #   | name                 | notes                                                                      |
| --- | -------------------- | -------------------------------------------------------------------------- |
| 1   | id                   | portfolio id                                                               |
| 6   | uuid                 | UUID for investment portfolios; `portfolio-caja-moneda*` slug for **cash** |
| 7   | title                | e.g. "Flexifolio … Muy arriesgado", "Portafolio cuenta moneda pesos"       |
| 13  | investmentStrategyId |                                                                            |
| 17  | portfolioFunding     | repeated PortfolioFundingModel (empty unless requested)                    |
| 23  | portfolioComposition | repeated PortfolioCompositionModel (empty unless requested)                |
| 24  | bpComission          | double — fee (e.g. 0.83)                                                   |

### Positions

`portal_goal.PortalGoalGrpcService/GetCurrentFundings` — request
`GetCurrentFundingsRequest {1: int32 goalId, 2: Timestamp date(optional), 3: bool includePreprocessed}`.
Response `GetCurrentFundingsResponse {1: repeated FundingProfitabilityValueModel values, 2: Timestamp date}`.

`common_message.FundingProfitabilityValueModel`:
| # | name | notes |
|---|---|---|
| 1 | funding | →FundingModel (name/ticker/currency) |
| 2 | percentage | weight within the goal |
| 3 | quotas | units held |
| **4** | **balance** | **position value, goal currency** |
| 5 | netDeposit | |
| 6 | fundingId | |

`common_message.FundingModel` (the instrument): 13 `title` (name, "Vistra Corp"), **5 `mnemonic`
(ticker, "VST")**, 4 `uuid`, 16 `mname`, 19/20 `currencyId`/`currency`, 34 `bpComission`, 6 `isBox`
(true = cash sleeve). Live example (goal 34876): `Vistra Corp / VST` plus `Caja BetterplanUS` cash
(balance 166.89 USD, weight 0.64%).

`portal_goal.PortalGoalGrpcService/GetPortfolioComposition` — request
`GetPortfolioRequest {1: int32 goalId, 2: bool includePreprocessed}`. Returns asset-class allocation
(`PortfolioCompositionModel`: 5 `percentage`, 6 `subCategoryName`, 7 `subcategory`→category/country).
Live example (goal 34876): 99.36% "Acciones de Países Desarrollados", 0.64% "Caja".

### Request envelope for `GetMe`/`ListMe`

`common_message.BaseGetRequest {1: WhereGetRequest where, 2: string include}`, where
`WhereGetRequest {1: StringValue predicate, 2: StringValue order}`. `predicate` is a **dynamic-LINQ**
string (`"id == 34876"`). `include` is an EF-style relation list that controls which nested messages
get populated (why `portfolioFunding`/`composition` are empty in the plain goal list).
`BaseListRequest` additionally has `page`/`size` (Int32Value) in its `WhereListRequest`.

## Balances — reconciliation (why we trust `currentCapital`)

From the source HAR (7 goals): the two funded USD goals summed to **15 679.41 USD**, matching
`GetPatrimonyByFinancialEntity` for BetterplanUS exactly; the one funded CLP goal was **150 000 CLP**,
matching Vector; and `user.GetMeSummary.field2` (grand total, CLP) matched
`GetPatrimonyByFinancialEntity.totalBalance` with the USD converted at the day's rate. Live re-fetch
on 2026-07-06 returned a fresh patrimony (14 888 645 CLP vs the HAR's 14 698 210) — i.e. real,
current market values.

| goal id           | title                   | currentCapital   | cur     | portfolio uuid            | kind       |
| ----------------- | ----------------------- | ---------------- | ------- | ------------------------- | ---------- |
| 34256             | Inversiones generales 2 | 3 333.52         | USD     | UUID                      | investment |
| 34876             | Inversiones generales 3 | 12 345.89        | USD     | UUID                      | investment |
| 31502             | Billetera Pesos         | 150 000          | CLP     | portfolio-caja-moneda-clp | **cash**   |
| 33168/33169/34255 | (empty flexifolios)     | 0 (field absent) | CLP/USD | UUID                      | investment |
| 31503             | Billetera Dólar         | 0 (field absent) | USD     | portfolio-caja-moneda     | **cash**   |

**Absent `currentCapital` ⇒ 0**, not unknown (protobuf omits default doubles).

### Cash vs investment discriminators

- Cash goals: `portfolio.uuid` starts with `portfolio-caja-moneda`; `investmentStrategy.title` like
  "Caja Pesos"; titles "Billetera Pesos"/"Billetera Dólar". Investment goals: UUID portfolios,
  strategy "Flexifolios"/"Flexifolios US".
- Within a portfolio, a cash sleeve is a `FundingModel` with `isBox = true` (e.g. "Caja BetterplanUS").

## Endpoint surface (relevant subset of 27 services / 303 methods)

Read-only, per-user, no-arg unless noted:

- `portal_goal.PortalGoalGrpcService`: **`ListMe`** (all goals), `GetMe` (predicate),
  **`GetCurrentFundings`** (positions), `GetPortfolioComposition`, `GetPortfolioByGoalId`,
  `GetFundingsSummaryByGoalIds`, `GetPatrimonyByFinancialEntity` (per-broker totals),
  `Irr`/`IrrMulti` (return %), `GetBalanceNetDeposit(Graph)` (time series),
  `ListGoalTransactionActivities` (per-goal txns).
- `user.UserGrpcService`: `GetMe` (UserModel+goals), `GetMeSummary` (CLP grand totals),
  `GetMeAdvisor`, `GetAccountBalance`, `GetLastFundingsValues`.
- `portal_user.PortalUserGrpcService`: `GetMeFinancialEntities`, `GetMeActivities` (txn feed;
  amounts are **pre-formatted es-CL strings** like `"USD 1.144,54"`), `GetConfig`.
- `currency_indicator.CurrencyIndicatorGrpcService/GetLastValues`: FX matrix (USD→CLP ≈ 923.67
  observed). Only needed if reporting USD holdings in CLP — Lunch Money can hold native-USD assets,
  so likely unnecessary.
- Mutating methods exist (`CreateGoal`, `RequestDeposit`, `Rescue`, `ArchiveGoal`, …) — **out of
  scope**; the adapter is read-only.

## Bootstrap & operations (implemented adapter)

The adapter (`src/adapters/betterplan*.ts`) is balance-only, refresh-token auth with rotation.

**One-time bootstrap:**

1. Log in to `portal.betterplan.cl` in a browser; from the `POST id.betterplan.cl/connect/token`
   response (a normal refresh during the session), copy the `refresh_token`.
2. Put it in `.env` as `BETTERPLAN_REFRESH_TOKEN` (the `refresh_token_env` your
   `[connections.betterplan]` references).
3. `bun run src/main.ts betterplan-goals` — lists every goal (`id | cur | balance | flags | title`).
4. Add one `[[accounts]]` per goal you want, `match = { sub = "<goalId>" }`, `currency` matching the
   goal, and a Lunch Money `manual_account` id you created for it. Skip empties.
5. `bun run src/main.ts sync --dry-run`, then a real `sync`.

**Steady state:** the env seed is used only until the state db has a token row. Each run reuses the
cached 30-day access token and only refreshes near expiry, rotating + persisting the new refresh
token atomically before any data call (single-flighted by a lockfile in the state dir).

**Re-bootstrap** (only if a run fails with `auth_error`/`invalid_grant` — the chain died): capture a
fresh refresh token and overwrite `BETTERPLAN_REFRESH_TOKEN`. The adapter detects the changed seed
(via a stored fingerprint) and adopts it. Never replays a dead seed automatically.

**Secrets:** `state.sqlite` now holds the refresh + access tokens (`connection_secrets` table). Treat
the state db as secret-bearing; the drift-persist path writes only response bytes, never the `Bearer`
header.

## Proposed adapter shape

- `src/adapters/betterplan.ts`, same `fetch(connection, window) → Map<subAccount, FetchResult>`
  contract as `obc.ts` — but pure Bun `fetch` (no subprocess): the WAF is header-gated, not
  TLS-gated.
- **Auth module**: refresh-token grant against `id.betterplan.cl/connect/token`,
  `client_id=portal-ts-code`; cache access token to expiry; on refresh, persist the rotated
  refresh token atomically in state and fail closed if it's missing. Bootstrap doc = one-time
  browser login to seed the refresh token.
- **gRPC-web client**: hand-roll the 5-byte framing (only a few read methods). Either hand-write
  minimal proto messages for `GoalModel` + `CurrencyModel` (+ `FundingProfitabilityValueModel` for
  positions), or regenerate from the field maps in this doc. Send the WAF headers on every call.
- **Balance facet per goal**: `ListMe` → for each non-hidden goal emit a `balance` facet
  (sub-account = goal `id`), currency = `currency.currencyCode`, amount = `currentCapital`
  (absent ⇒ 0) as BigInt minor units using the `digitsInfo` exponent (CLP 0 / USD 2 — matches
  `src/core/money.ts`). Tag cash vs investment by portfolio uuid so LM assets can be categorized.
- **Positions facet (optional)**: per goal, `GetCurrentFundings` → `values[]` mapped to
  `{name, ticker=funding.mnemonic, quotas, balance, weight}`.
- Parse-don't-validate: zod-parse decoded messages at the boundary; discard the whole FetchResult
  on schema drift (repo hard rule). `currentCapital` and currency are the load-bearing fields.

## Security note

The source HAR (`~/Downloads/portal.betterplan.cl_Archive […].har`) contains a live 30-day access
token and a valid refresh token (the refresh chain was rotated during this investigation, so the
HAR's refresh token is now spent — the current one lives in `scratchpad/refresh_token.txt`, also
session-local). Move/delete the HAR out of Downloads, and treat the scratchpad tokens as secrets to
be discarded once the real adapter has its own bootstrapped token.
