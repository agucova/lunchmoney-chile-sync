// Typed repositories over the state db. Every row crossing this boundary is converted
// to domain types (Money, branded IsoDate) — driver rows never leak out.

import { and, desc, eq, gte, isNotNull, isNull, lte } from "drizzle-orm";
import { assertIsoDate, type IsoDate } from "../core/dates.ts";
import { invariant } from "../core/errors.ts";
import type { StoredIdentity } from "../core/identity.ts";
import type { TxnStatus } from "../core/model.ts";
import { isCurrencyCode, Money } from "../core/money.ts";
import type { Db } from "./db.ts";
import { accountState, opsJournal, runs, txnIdentities } from "./schema.ts";

function nowIso(): string {
  return new Date().toISOString();
}

// ---------- runs ----------

export type RunOutcome =
  | "ok"
  | "dry_run"
  | "auth_error"
  | "two_factor_timeout"
  | "source_unavailable"
  | "schema_drift"
  | "sink_error"
  | "unexpected";

export function startRun(db: Db, connectionId: string, source: string): number {
  const row = db
    .insert(runs)
    .values({ startedAt: nowIso(), connectionId, source })
    .returning({ id: runs.id })
    .get();
  invariant(row, "INSERT INTO runs returned no row");
  return row.id;
}

export function finishRun(
  db: Db,
  runId: number,
  outcome: RunOutcome,
  error: string | null,
  stats: Record<string, unknown>,
): void {
  db.update(runs)
    .set({ finishedAt: nowIso(), outcome, error, stats: JSON.stringify(stats) })
    .where(eq(runs.id, runId))
    .run();
}

// ---------- identities ----------

type IdentityRow = typeof txnIdentities.$inferSelect;

function rowToIdentity(row: IdentityRow): StoredIdentity {
  invariant(isCurrencyCode(row.currency), `bad currency in db: ${row.currency}`);
  return {
    id: row.id,
    accountId: row.accountId,
    externalId: row.externalId,
    bucketHash: row.bucketHash,
    occurrence: row.occurrence,
    date: assertIsoDate(row.date),
    amount: Money.of(row.amountMinor, row.currency),
    normDesc: row.normDesc,
    rawDesc: row.rawDesc,
    descVariants: row.descVariants,
    status: row.status as TxnStatus,
    installments: row.installments,
    lmTxnId: row.lmTxnId,
    flagged: row.flagged,
  };
}

/** All identities for an account within a date window (for bucket matching). */
export function identitiesInWindow(
  db: Db,
  accountId: string,
  from: IsoDate,
  to: IsoDate,
): StoredIdentity[] {
  return db
    .select()
    .from(txnIdentities)
    .where(
      and(
        eq(txnIdentities.accountId, accountId),
        gte(txnIdentities.date, from),
        lte(txnIdentities.date, to),
      ),
    )
    .all()
    .map(rowToIdentity);
}

/** Identities not yet in Lunch Money (fresh mints + crash leftovers awaiting insert). */
export function identitiesAwaitingLm(db: Db, accountId: string): StoredIdentity[] {
  return db
    .select()
    .from(txnIdentities)
    .where(and(eq(txnIdentities.accountId, accountId), isNull(txnIdentities.lmTxnId)))
    .all()
    .map(rowToIdentity);
}

export interface MintInput {
  accountId: string;
  externalId: string;
  bucketHash: string;
  occurrence: number;
  date: IsoDate;
  amount: Money;
  normDesc: string;
  rawDesc: string;
  normVersion: number;
  status: TxnStatus;
  installments?: string | undefined;
  flagged?: string | undefined;
}

export function insertIdentity(db: Db, runId: number, input: MintInput): number {
  const row = db
    .insert(txnIdentities)
    .values({
      accountId: input.accountId,
      externalId: input.externalId,
      bucketHash: input.bucketHash,
      occurrence: input.occurrence,
      date: input.date,
      amountMinor: input.amount.minor,
      currency: input.amount.currency,
      normDesc: input.normDesc,
      rawDesc: input.rawDesc,
      normVersion: input.normVersion,
      status: input.status,
      installments: input.installments ?? null,
      flagged: input.flagged ?? null,
      firstSeenRun: runId,
      lastSeenRun: runId,
      createdAt: nowIso(),
    })
    .returning({ id: txnIdentities.id })
    .get();
  invariant(row, "INSERT INTO txn_identities returned no row");
  return row.id;
}

/** Refresh last-seen and record a newly observed description variant, if any. */
export function touchIdentity(
  db: Db,
  identityId: number,
  runId: number,
  newVariant?: string,
): void {
  if (newVariant === undefined) {
    db.update(txnIdentities)
      .set({ lastSeenRun: runId })
      .where(eq(txnIdentities.id, identityId))
      .run();
    return;
  }
  const row = db
    .select({ descVariants: txnIdentities.descVariants })
    .from(txnIdentities)
    .where(eq(txnIdentities.id, identityId))
    .get();
  invariant(row, `identity ${identityId} vanished mid-run`);
  const variants = row.descVariants.includes(newVariant)
    ? row.descVariants
    : [...row.descVariants, newVariant];
  db.update(txnIdentities)
    .set({ lastSeenRun: runId, descVariants: variants })
    .where(eq(txnIdentities.id, identityId))
    .run();
}

/** All open unbilled identities for an account (billed-transition + vanish passes). */
export function openUnbilledIdentities(db: Db, accountId: string): StoredIdentity[] {
  return db
    .select()
    .from(txnIdentities)
    .where(and(eq(txnIdentities.accountId, accountId), eq(txnIdentities.status, "unbilled")))
    .all()
    .map(rowToIdentity);
}

/**
 * Apply the unbilled→billed transition (the only legal cross-status move). The
 * identity's `date` is rewritten to the billed observation so future runs' exact
 * bucket matching finds it (billed feeds repeat the shifted posting date forever);
 * the LM transaction keeps the original purchase date, and identity.date is a
 * matching key, not a display value.
 */
export function transitionToBilled(
  db: Db,
  identityId: number,
  runId: number,
  billedDate: IsoDate,
  newVariant?: string,
): void {
  db.update(txnIdentities)
    .set({ status: "billed", billedDate, date: billedDate, lastSeenRun: runId })
    .where(eq(txnIdentities.id, identityId))
    .run();
  if (newVariant !== undefined) touchIdentity(db, identityId, runId, newVariant);
}

/** Attach, replace, or clear (null) a human-attention note on an identity. */
export function flagIdentity(db: Db, identityId: number, note: string | null): void {
  db.update(txnIdentities).set({ flagged: note }).where(eq(txnIdentities.id, identityId)).run();
}

export function setLmTxnId(db: Db, identityId: number, lmTxnId: number): void {
  db.update(txnIdentities).set({ lmTxnId }).where(eq(txnIdentities.id, identityId)).run();
}

export function flaggedIdentities(db: Db): StoredIdentity[] {
  return db
    .select()
    .from(txnIdentities)
    .where(isNotNull(txnIdentities.flagged))
    .all()
    .map(rowToIdentity);
}

export interface RunSummary {
  id: number;
  startedAt: string;
  finishedAt: string | null;
  connectionId: string;
  source: string;
  outcome: string | null;
  error: string | null;
}

export function recentRuns(db: Db, limit = 10): RunSummary[] {
  return db
    .select({
      id: runs.id,
      startedAt: runs.startedAt,
      finishedAt: runs.finishedAt,
      connectionId: runs.connectionId,
      source: runs.source,
      outcome: runs.outcome,
      error: runs.error,
    })
    .from(runs)
    .orderBy(desc(runs.id))
    .limit(limit)
    .all();
}

// ---------- ops journal ----------

export function journalOp(db: Db, runId: number, seq: number, op: unknown): number {
  const row = db
    .insert(opsJournal)
    .values({ runId, seq, op: JSON.stringify(op) })
    .returning({ id: opsJournal.id })
    .get();
  invariant(row, "INSERT INTO ops_journal returned no row");
  return row.id;
}

export function markOpApplied(db: Db, journalId: number, result: unknown): void {
  db.update(opsJournal)
    .set({ appliedAt: nowIso(), result: JSON.stringify(result) })
    .where(eq(opsJournal.id, journalId))
    .run();
}

// ---------- account state ----------

export function lastPushedBalance(db: Db, accountId: string): Money | null {
  const row = db
    .select({
      minor: accountState.lastPushedBalanceMinor,
      currency: accountState.lastPushedBalanceCurrency,
    })
    .from(accountState)
    .where(eq(accountState.accountId, accountId))
    .get();
  if (!row || row.minor === null || row.currency === null) return null;
  invariant(isCurrencyCode(row.currency), `bad currency in db: ${row.currency}`);
  return Money.of(row.minor, row.currency);
}

export function recordPushedBalance(db: Db, accountId: string, balance: Money): void {
  db.insert(accountState)
    .values({
      accountId,
      lastPushedBalanceMinor: balance.minor,
      lastPushedBalanceCurrency: balance.currency,
      lastPushedBalanceAt: nowIso(),
    })
    .onConflictDoUpdate({
      target: accountState.accountId,
      set: {
        lastPushedBalanceMinor: balance.minor,
        lastPushedBalanceCurrency: balance.currency,
        lastPushedBalanceAt: nowIso(),
      },
    })
    .run();
}
