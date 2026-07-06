# lunchmoney-chile-sync

Syncs Chilean banks (Santander, Banco de Chile) into Lunch Money. High-reliability financial
software: fail closed, parse-don't-validate (zod at every boundary), explicit plan → apply.

## Hard rules

- **Money is BigInt minor units** (`src/core/money.ts`), CLP exponent 0 (whole pesos),
  USD/GBP exponent 2. Amounts must never pass through float arithmetic — parse from decimal
  strings, render with `toDecimalString()`. Same-currency-only arithmetic; mixing throws.
- **Transaction identity is DB-authoritative**: the bootstrap hash is computed once at first
  sight; afterwards identity comes from `txn_identities`, never recomputed-and-trusted.
- **Fail closed on schema drift**: if a source payload fails zod parsing, discard the whole
  FetchResult, persist the raw payload, alert. Never partially ingest.
- Dates are ISO date strings (no time); banks emit `dd-mm-yyyy` America/Santiago.

## Toolchain

- Bun runtime; `bun test`; `bun:sqlite` with `safeIntegers: true` (BigInt survives the DB).
- oxlint + oxfmt (not Biome/ESLint/Prettier); `tsc --noEmit` for types. Run `bun run check`
  before finishing a change.
- The open-banking-chile scraper is vendored as a **prebuilt tarball** pinned by commit
  (`vendor/*.tgz`, rebuilt only via `scripts/update-obc.sh`, which needs node/npm) and runs
  as an isolated bun subprocess (`src/obc-runner.ts`, JSON-lines protocol). Everything else
  is pure bun. Don't switch the dependency back to a `github:` specifier — bun can't run its
  devDependency-requiring `prepare` build.
- VCS is jj (colocated with git).

## Architecture map

- `src/core/` — Money, canonical model, identity ledger, reconciler, SyncPlan (pure).
- `src/adapters/` — source adapters (`fetch(connection, window) → Map<subAccount, FetchResult>`).
  FetchResults are facet-based (`transactions`, `balance`, future `valuation`).
- `src/sink/` — Lunch Money API client (v2 txns, v1 balances), idempotent journaled apply.
- `src/cli/` — `sync [--dry-run]`, `assets`, `backfill`, `status`, `review`.
- `fixtures/` — sanitized golden fixtures; `fixtures/raw/` is gitignored (personal data).
