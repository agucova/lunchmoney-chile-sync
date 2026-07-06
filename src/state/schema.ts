// Drizzle schema — the single source of truth for the state db (drizzle-kit generates
// migrations from this file; row types are inferred from it).
//
// Conventions:
// - Monetary amounts are TEXT columns holding BigInt minor units (exact regardless of
//   driver integer handling; SQLite INTEGER + JS number would silently lose precision
//   past 2^53). The `amountMinor` custom type converts TEXT ↔ bigint at the boundary.
// - Dates are TEXT ISO dates (branded IsoDate in domain code).
// - No INTEGER column stores values anywhere near 2^53 (LM ids are ~2^31), so plain
//   number mode is safe for ids.

import { customType, index, integer, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";

/** BigInt minor units stored as TEXT. */
const amountMinor = customType<{ data: bigint; driverData: string }>({
  dataType: () => "text",
  toDriver: (value) => value.toString(),
  fromDriver: (value) => BigInt(value),
});

/** JSON-encoded string array (observed description variants). */
const stringArray = customType<{ data: readonly string[]; driverData: string }>({
  dataType: () => "text",
  toDriver: (value) => JSON.stringify(value),
  fromDriver: (value) => JSON.parse(value) as string[],
});

export const runs = sqliteTable("runs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  startedAt: text("started_at").notNull(),
  finishedAt: text("finished_at"),
  connectionId: text("connection_id").notNull(),
  source: text("source").notNull(),
  outcome: text("outcome"),
  error: text("error"),
  stats: text("stats"),
});

export const txnIdentities = sqliteTable(
  "txn_identities",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    accountId: text("account_id").notNull(),
    externalId: text("external_id").notNull(),
    bucketHash: text("bucket_hash").notNull(),
    occurrence: integer("occurrence").notNull(),
    date: text("date").notNull(),
    amountMinor: amountMinor("amount_minor").notNull(),
    currency: text("currency").notNull(),
    normDesc: text("norm_desc").notNull(),
    rawDesc: text("raw_desc").notNull(),
    descVariants: stringArray("desc_variants").notNull().default([]),
    normVersion: integer("norm_version").notNull(),
    /** Lifecycle: posted | unbilled | billed. */
    status: text("status").notNull(),
    /** ISO date when the unbilled→billed transition was observed (audit trail). */
    billedDate: text("billed_date"),
    installments: text("installments"),
    /** Original currency/amount before FX settlement (international CC purchases). */
    origCurrency: text("orig_currency"),
    origAmountMinor: amountMinor("orig_amount_minor"),
    lmTxnId: integer("lm_txn_id"),
    /** Low-confidence match note, surfaced by `status`; null = clean. */
    flagged: text("flagged"),
    firstSeenRun: integer("first_seen_run")
      .notNull()
      .references(() => runs.id),
    lastSeenRun: integer("last_seen_run")
      .notNull()
      .references(() => runs.id),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    unique("uq_identities_account_external").on(table.accountId, table.externalId),
    index("idx_identities_bucket").on(
      table.accountId,
      table.date,
      table.amountMinor,
      table.currency,
    ),
    index("idx_identities_bucket_hash").on(table.accountId, table.bucketHash),
  ],
);

export const opsJournal = sqliteTable(
  "ops_journal",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    runId: integer("run_id")
      .notNull()
      .references(() => runs.id),
    seq: integer("seq").notNull(),
    op: text("op").notNull(),
    appliedAt: text("applied_at"),
    result: text("result"),
  },
  (table) => [unique("uq_journal_run_seq").on(table.runId, table.seq)],
);

export const accountState = sqliteTable("account_state", {
  accountId: text("account_id").primaryKey(),
  lastPushedBalanceMinor: amountMinor("last_pushed_balance_minor"),
  lastPushedBalanceCurrency: text("last_pushed_balance_currency"),
  lastPushedBalanceAt: text("last_pushed_balance_at"),
});

// Per-connection rotating OAuth secrets (currently BetterPlan). The refresh token rotates on
// every use and the identity provider revokes the whole family on reuse, so the live token
// must be persisted here (env only seeds the first run). The access token is cached to its
// expiry so most runs make zero token calls. Secret-bearing: back up state.sqlite accordingly.
export const connectionSecrets = sqliteTable("connection_secrets", {
  connectionId: text("connection_id").primaryKey(),
  refreshToken: text("refresh_token").notNull(),
  accessToken: text("access_token"),
  accessTokenExpiresAt: text("access_token_expires_at"),
  /** sha256 of the env bootstrap seed that produced this row; a change forces a re-bootstrap. */
  seedFingerprint: text("seed_fingerprint"),
  updatedAt: text("updated_at").notNull(),
});
