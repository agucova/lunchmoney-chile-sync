# Phase 0 spike findings (2026-07-05)

Empirical results that Phase 1+ must implement against. Raw payloads in `fixtures/raw/`
(gitignored). Scraper = open-banking-chile @ `085faafd` run headless from macOS with system
Chrome; both banks succeeded on first try; **0/2 runs hit a 2FA challenge**.

## Scraper output shapes (they differ per bank!)

### Santander — still the flat v2 shape

- Everything lands in `accounts[0].movements` with `source` tags; **no `creditCards[]`**,
  no per-card `label`/cupo/`lastStatement`/`nextBillingDate`. Account `label` is `null`.
- Observed: 24 `account` + 24 `credit_card_unbilled` + 119 `credit_card_billed` (history
  back to 2025-11). Checking movements carry a running `balance`; CC movements have
  `balance: 0`.
- The debug log sees **three** sidebar accounts (the main CLP checking, a second
  sight/USD account, and an old dormant checking) but only the main checking is
  extracted.
- ⇒ Adapter must split sub-accounts by `source`, not by array structure.
- ⇒ **Santander CC owed balance must be computed from movements** (no cupo/statement data).

### Banco de Chile — proper v3 nested shape

- `accounts[0]` + `creditCards[]` (2 cards) with `label` + last-4, `national` and
  `international` (USD) cupos. Both cards have 0 movements (unused) — **all CC lifecycle
  work rides on Santander data**.
- `lastStatement`/`nextDueDate` are `null`; `nextBillingDate` is Spanish prose _without a
  year_ ("29 de julio").
- Movement `balance` is a **string** ("1450000") while `amount` is a number.

### Cross-bank data quirks (ingestion contracts)

- **Date formats are inconsistent within one payload**: Santander billed + account = ISO
  (`2026-06-21`); Santander unbilled = `dd-mm-yyyy` (`05-07-2026`); BdCh account =
  `dd-mm-yyyy`. Parse per (bank, source); reject ambiguous.
- **Descriptions are truncated at varying lengths** across API responses of the same bank
  (`PAYU *UBER EA` vs `PAYU *UBER EATS`, `DP *IKEA CO` vs `DP *IKEA COM`) and drift between
  unbilled→billed (whitespace, suffixes). Matching must be prefix-tolerant; amount+date is
  the load-bearing key.
- **No movement carries any id-like field** — deterministic hash identity is necessary.
- Movements have **no currency field**; no USD/international purchase was in the window, so
  the USD unbilled→CLP billed fixture pair is **still uncaptured** (open item — capture after
  the next international purchase).
- `installments: "NN/NN"` appears (1 active cuota observed); `card`/`totalAmount` never
  appear on Santander.

## Lunch Money API

- **v2 is live** (`api.lunchmoney.dev/v2`, same bearer token). Assets are
  "manual accounts"; transactions take `manual_account_id` (v1's `asset_id` is rejected).
- **v2 insert** (`POST /v2/transactions`) returns HTTP 201 with `transactions[]` (full
  objects) plus `skipped_duplicates[]`:
  `{reason: "duplicate_external_id", request_transactions_index, existing_transaction_id,
request_transaction}` — **duplicate replays return the existing LM id**, so crash
  recovery = re-POST and read `existing_transaction_id`. (v1 returns `{"ids":[]}` and hides
  the id; v1 window queries do include `external_id` — backstop only.)
- **v2 insert defaults `currency` to the budget's primary currency (usd), NOT the account's
  currency** — a CLP insert without explicit currency became usd. ⇒ Sink must always send
  explicit `currency`.
- **v2 covers the whole sink surface**: `PUT /v2/manual_accounts/:id` updates balance,
  `DELETE /v2/transactions/:id` and `/v2/manual_accounts/:id` work. ⇒ **No v1 dependency
  anywhere; the sink is pure v2.** NB: a balance-only PUT does **not** re-stamp
  `balance_as_of` (it keeps the prior date) — the sink sends `balance_as_of` explicitly.
- Manual accounts have their own `external_id` and `custom_metadata` fields — useful for
  tagging accounts with our config account ids.

## Existing LM assets (map into config.toml; no assets need creating)

| LM id  | Name                                     | Type / currency     |
| ------ | ---------------------------------------- | ------------------- |
| 1xxxxx | Santander Cuenta Corriente Limited (CLP) | checking, clp       |
| 1xxxxx | Santander Cuenta Corriente Limited (USD) | checking, usd       |
| 1xxxxx | WorldMember Limited Visa (CLP)           | credit card, clp    |
| 1xxxxx | WorldMember Limited Visa (USD)           | credit card, usd    |
| 1xxxxx | Cuenta Corriente Banco de Chile          | checking, clp       |
| 1xxxxx | Visa Signature (CLP)                     | credit card, clp    |
| 1xxxxx | Visa Signature (USD)                     | credit card, usd    |
| 1xxxxx | BCI Cuenta Vista                         | savings, clp        |
| 1xxxxx | Santander Línea de Crédito               | credit (other), usd |
| 1xxxxx | Línea de Crédito Banco de Chile          | credit (other), clp |
| 1xxxxx | Racional Stocks                          | investment, usd     |
| 1xxxxx | Racional Cash                            | cash, usd           |
| 1xxxxx | Santander CC Universitaria (stale, 0)    | checking, clp       |
| 1xxxxx | Inheritance                              | investment, clp     |

The CLP/USD asset _pairs_ per card match the planned international-purchase design.

## Upstream (open-banking-chile) contribution candidates

1. Migrate Santander to the v3 nested shape (per-card split, cupo, `lastStatement`).
2. Normalize unbilled/BdCh dates to ISO (or document per-source formats).
3. Expose `userDataDir`/`extraArgs` in `ScraperOptions` (persistent profile → fewer 2FA).

## Phase 1 operational notes (2026-07-06)

- Some Santander descriptions arrive mojibake'd (`CARLA PEÃ±A` = double-encoded UTF-8).
  Stable across runs, so identity is unaffected; payee cleanup is a Phase 3 nicety.
- Santander's login page stopped loading (`No cargaron los campos de login`) for every
  attempt between ~02:00–03:00 Chile time (after 3 rapid logins), then worked first-try
  mid-morning. Consistent with an overnight maintenance/anti-bot window. ⇒ Schedule the
  daily timer during daytime hours (e.g. 10:00 America/Santiago), never overnight.
- `src/obc-runner.ts --screenshots` saves the scraper's step-by-step screenshots to
  `./screenshots/` (gitignored — they contain account data) for debugging runs like the
  above.

## Open items

- Capture a USD international purchase pair (unbilled USD → billed CLP) when one occurs.
- 2FA challenge frequency: keep counting across future runs (currently 0/2).
- Nix packaging sanity check (node/bun + chromium pinning) — deferred to Phase 1 deploy.

## Santander checking history: the cartola endpoints (2026-07-08)

The `current-accounts/transactions` (openbanking host) feed silently caps at ~60–90 days
regardless of `openingDate` — no error, no pagination. Historical checking movements come
from the monthly **cartola** (statement), a two-step flow on `api-dsk.santander.cl/perdsk`,
delivered as a base64 PDF exactly like the USD card `estadoDeCuenta`:

**List** — `POST /perdsk/datosCliente/ultCartolaHistorica` with `INPUT` fields `ENTIDAD` (0035),
`PRODUCTO` (00), `CONTRATO` (the 12-digit account), `MESCONSULTA` (MM), `ANOCONSULTA` (YYYY).
Returns `DATA.AS_TIB_ConsultaUltCartolaHistorica.INFO.CODERR`: `00` = statement exists, `16` =
none that month (e.g. the current incomplete month). On success `OUTPUT.MATRIZ[0]` carries
`NUMEROCARTOLA`, `NUMEROCUENTA` (12-digit) and `FECHADESDE` (the ISO statement close date).
History reaches at least 12 months (verified back to 07/2025).

**Download** — `POST /perdsk/datosCliente/buzonVirtual` with `INPUT` fields `formato` (PDF),
`contrato` (the 12-digit account dash-formatted 1-3-2-5-1, e.g. `001234567890` becomes
`0-012-34-56789-0`), `rutCliente`, `fechaInicio` and `fechaFin` (both the close date as
YYYYMMDD), and `tipoDocumento` (CUENTAS_AR). Returns `DATA.OUTPUT.FILE` (a base64 PDF) with
`INFO.CODERR` `00` on success.

PDF layout (`pdftotext -layout`): table `FECHA(dd/mm) | SUCURSAL | DESCRIPCION | Nº DCTO |
CHEQUES Y OTROS CARGOS | DEPOSITOS Y OTROS ABONOS | SALDO`; a row carries a value in the
CARGOS _or_ ABONOS column (by horizontal position), SALDO is the running balance. Year is not
on the row — take it from the statement period. A "Resumen de Comisiones" block at the end
repeats commission rows (exclude to avoid double-count). Reconciliation footer under
`INFORMACION DE CUENTA CORRIENTE`: `SALDO INICIAL | DEPOSITOS | OTROS ABONOS | CHEQUES |
OTROS CARGOS | IMPUESTOS | SALDO FINAL` — gate: `INICIAL + DEPOSITOS + OTROS_ABONOS − CHEQUES
− OTROS_CARGOS − IMPUESTOS == SALDO_FINAL`, and parsed debit/credit sums must match those
totals (same fail-closed discipline as usd-statement.ts).

cabecera constants (frontend verbatim): `HOST:{ "USUARIO-ALT":"GHOBP","TERMINAL-ALT":"","CANAL-ID":"078" },
CanalFisico:"003", CanalLogico:"74", InfoDispositivo:"003", InfoGeneral:{ NumeroServidor:"01" }`
plus RutCliente/RutUsuario. (DocRecientes / consultaCampana / refreshtoken also fire in the
cartola view but aren't needed for movement backfill.)
