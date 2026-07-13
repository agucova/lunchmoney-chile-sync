// Sync engine: fetch per connection → ingest into the identity ledger → plan → apply.
// Planning is derived from state, not from run-local bookkeeping, so a crashed or
// interrupted run converges on the next one (identities without an LM id are simply
// planned again; duplicate inserts recover the existing id).

import type { AccountConfig, Config, ConnectionConfig } from "./config.ts";
import { categorizePayee, compileCategoryRules, type CategoryRule } from "./core/categorize.ts";
import { daysBetween } from "./core/dates.ts";
import { SyncError } from "./core/errors.ts";
import {
  dedupeCrossStatus,
  matchBilledTransitions,
  matchTransactions,
  type MintPlan,
} from "./core/identity.ts";
import type { FetchResult } from "./core/model.ts";
import { expectedSubAccountKey } from "./core/model.ts";
import { NORMALIZE_VERSION } from "./core/normalize.ts";
import {
  describeOp,
  planBalanceOp,
  toLunchMoneyAmount,
  type InsertTxnOp,
  type SyncOp,
} from "./core/plan.ts";
import type { LunchMoneyClient } from "./sink/lunchmoney.ts";
import type { Db } from "./state/db.ts";
import {
  finishRun,
  flagIdentity,
  identitiesAwaitingLm,
  identitiesInWindow,
  insertIdentity,
  journalOp,
  markOpApplied,
  openUnbilledIdentities,
  recordPushedBalance,
  setLmTxnId,
  startRun,
  touchIdentity,
  transitionToBilled,
  type RunOutcome,
} from "./state/repo.ts";

export interface EngineDeps {
  readonly db: Db;
  readonly config: Config;
  readonly client: LunchMoneyClient;
  readonly fetchConnection: (
    connectionId: string,
    connection: ConnectionConfig,
    hooks: { onProgress?: (step: string) => void; onTwoFactorWait?: () => void },
  ) => Promise<Map<string, FetchResult>>;
  readonly log: (message: string) => void;
  readonly notify: (message: string) => void;
}

export interface SyncOptions {
  readonly dryRun: boolean;
  /** Restrict to these account ids (default: all configured). */
  readonly accountIds?: readonly string[];
}

export interface AccountReport {
  readonly accountId: string;
  readonly matched: number;
  readonly minted: number;
  readonly flagged: number;
  readonly transitioned: number;
  readonly vanishFlagged: number;
  readonly ops: readonly SyncOp[];
}

export interface ConnectionReport {
  readonly connectionId: string;
  readonly outcome: RunOutcome;
  readonly error?: string;
  readonly accounts: readonly AccountReport[];
}

function outcomeOf(error: unknown): { outcome: RunOutcome; message: string } {
  if (error instanceof SyncError) {
    const map: Partial<Record<SyncError["code"], RunOutcome>> = {
      schema_drift: "schema_drift",
      auth_error: "auth_error",
      two_factor_timeout: "two_factor_timeout",
      source_unavailable: "source_unavailable",
      sink_error: "sink_error",
    };
    return { outcome: map[error.code] ?? "unexpected", message: error.message };
  }
  return { outcome: "unexpected", message: error instanceof Error ? error.message : String(error) };
}

interface IngestStats {
  matched: number;
  minted: number;
  flagged: number;
  transitioned: number;
  vanishFlagged: number;
}

const NO_INGEST: IngestStats = {
  matched: 0,
  minted: 0,
  flagged: 0,
  transitioned: 0,
  vanishFlagged: 0,
};

const VANISH_NOTE_PREFIX = "unbilled txn vanished";

function mintFromPlan(db: Db, runId: number, accountId: string, mint: MintPlan): number {
  return insertIdentity(db, runId, {
    accountId,
    externalId: mint.externalId,
    bucketHash: mint.bucketHash,
    occurrence: mint.occurrence,
    date: mint.txn.date,
    amount: mint.txn.amount,
    normDesc: mint.txn.normDescription,
    rawDesc: mint.txn.rawDescription,
    normVersion: NORMALIZE_VERSION,
    status: mint.txn.status,
    installments: mint.txn.meta.installments,
    flagged: mint.flagged ?? undefined,
  });
}

/** Ingest one account's transactions into the identity ledger. Idempotent. */
function ingestAccount(
  db: Db,
  runId: number,
  account: AccountConfig,
  fetched: FetchResult,
): IngestStats {
  if (account.kind === "credit_card") return ingestCreditCard(db, runId, account, fetched);

  const txns = fetched.facets.transactions ?? [];
  const posted = txns.filter((t) => t.status === "posted");
  if (posted.length === 0) return NO_INGEST;

  const dates = posted.map((t) => t.date);
  const from = dates.reduce((a, b) => (a < b ? a : b));
  const to = dates.reduce((a, b) => (a > b ? a : b));

  return db.transaction(() => {
    const existing = identitiesInWindow(db, account.id, from, to);
    const outcome = matchTransactions(account.id, posted, existing);

    for (const pair of outcome.matched) {
      touchIdentity(db, pair.identity.id, runId, pair.newVariant);
    }
    let flagged = 0;
    for (const mint of outcome.toMint) {
      if (mint.flagged) flagged++;
      mintFromPlan(db, runId, account.id, mint);
    }
    return {
      ...NO_INGEST,
      matched: outcome.matched.length,
      minted: outcome.toMint.length,
      flagged,
    };
  });
}

/**
 * Credit-card lifecycle ingest:
 *   dedupe same-run unbilled/billed overlap → exact bucket match (transitions ride the
 *   same date+amount bucket) → wider billed-transition pass (posting-date drift) →
 *   mint the rest → vanish flags for unbilled identities that disappeared without
 *   billing. Transitions happen in OUR ledger only — the LM transaction stays put
 *   (same content); FX settlements would change amounts and are flagged for review
 *   instead of guessed (no real USD fixture pair captured yet).
 */
function ingestCreditCard(
  db: Db,
  runId: number,
  account: AccountConfig,
  fetched: FetchResult,
): IngestStats {
  const raw = (fetched.facets.transactions ?? []).filter((t) => t.status !== "posted");
  if (raw.length === 0) return NO_INGEST;
  const incoming = dedupeCrossStatus(raw);

  const dates = incoming.map((t) => t.date);
  const from = dates.reduce((a, b) => (a < b ? a : b));
  const to = dates.reduce((a, b) => (a > b ? a : b));

  return db.transaction(() => {
    const seenIdentityIds = new Set<number>();
    let transitioned = 0;
    let flagged = 0;

    // Stage 1: exact bucket matching (any status ↔ any status).
    const existing = identitiesInWindow(db, account.id, from, to);
    const outcome = matchTransactions(account.id, incoming, existing);

    for (const pair of outcome.matched) {
      seenIdentityIds.add(pair.identity.id);
      if (pair.identity.status === "unbilled" && pair.txn.status === "billed") {
        transitionToBilled(db, pair.identity.id, runId, pair.txn.date, pair.newVariant);
        transitioned++;
      } else if (pair.identity.status !== pair.txn.status) {
        // e.g. billed → unbilled: never rewind state; surface it instead.
        flagIdentity(
          db,
          pair.identity.id,
          `illegal transition ${pair.identity.status}→${pair.txn.status} observed in run ${runId}`,
        );
        touchIdentity(db, pair.identity.id, runId, pair.newVariant);
        flagged++;
      } else {
        touchIdentity(db, pair.identity.id, runId, pair.newVariant);
        // An unbilled identity that reappeared clears any stale vanish flag.
        if (pair.identity.flagged?.startsWith(VANISH_NOTE_PREFIX)) {
          flagIdentity(db, pair.identity.id, null);
        }
      }
    }

    // Stage 2: wider transition pass for billed txns the exact bucket missed.
    const openUnbilled = openUnbilledIdentities(db, account.id).filter(
      (identity) => !seenIdentityIds.has(identity.id),
    );
    const unmatchedBilledTxns = outcome.toMint
      .filter((mint) => mint.txn.status === "billed")
      .map((mint) => mint.txn);
    const transitions = matchBilledTransitions(unmatchedBilledTxns, openUnbilled, daysBetween);
    const transitionedTxns = new Set(transitions.map((t) => t.txn));
    for (const transition of transitions) {
      seenIdentityIds.add(transition.identity.id);
      const isKnownVariant =
        transition.txn.normDescription === transition.identity.normDesc ||
        transition.identity.descVariants.includes(transition.txn.normDescription);
      transitionToBilled(
        db,
        transition.identity.id,
        runId,
        transition.txn.date,
        isKnownVariant ? undefined : transition.txn.normDescription,
      );
      transitioned++;
    }

    // Stage 3: mint what remains.
    let minted = 0;
    for (const mint of outcome.toMint) {
      if (transitionedTxns.has(mint.txn)) continue;
      if (mint.flagged) flagged++;
      seenIdentityIds.add(mintFromPlan(db, runId, account.id, mint));
      minted++;
    }

    // Stage 4: vanish flags — only when this run actually observed the unbilled list,
    // and only after transitions had their chance (no false alarms at statement close).
    let vanishFlagged = 0;
    if (fetched.coverage.unbilled) {
      for (const identity of openUnbilledIdentities(db, account.id)) {
        if (seenIdentityIds.has(identity.id)) continue;
        if (!identity.flagged?.startsWith(VANISH_NOTE_PREFIX)) {
          flagIdentity(
            db,
            identity.id,
            `${VANISH_NOTE_PREFIX} from bank feed (reversal?) — first noticed in run ${runId}`,
          );
        }
        vanishFlagged++;
      }
    }

    return { matched: outcome.matched.length, minted, flagged, transitioned, vanishFlagged };
  });
}

/** Plan ops for one account from ledger + fetch state. Pure read of state. */
function planAccount(
  db: Db,
  account: AccountConfig,
  fetched: FetchResult,
  categoryRules: readonly CategoryRule[],
): SyncOp[] {
  const ops: SyncOp[] = [];
  for (const identity of identitiesAwaitingLm(db, account.id)) {
    const payee = identity.installments
      ? `${identity.rawDesc} (${identity.installments})`
      : identity.rawDesc;
    const categoryId = categorizePayee(payee, categoryRules);
    ops.push({
      op: "insert_txn",
      accountId: account.id,
      lmAccountId: account.lm_account_id,
      identityId: identity.id,
      externalId: identity.externalId,
      date: identity.date,
      amount: toLunchMoneyAmount(identity.amount, account.kind),
      payee,
      ...(categoryId === undefined ? {} : { categoryId }),
    });
  }
  const balance = fetched.facets.balance;
  if (balance) {
    // Stamp the fetch timestamp (not balance.asOf, a date) so LM's balance_as_of reflects
    // the actual sync moment. Always emitted — see planBalanceOp on why balances aren't deduped.
    ops.push(
      planBalanceOp(
        account.id,
        account.lm_account_id,
        balance.amount,
        account.currency,
        fetched.sourceMeta.fetchedAt,
      ),
    );
  }
  return ops;
}

/** Batch size for LM inserts (143 one-by-one requests hit LM's rate limit at ~100). */
const INSERT_BATCH_SIZE = 50;

async function applyOps(
  deps: EngineDeps,
  runId: number,
  ops: readonly SyncOp[],
  seqBase: number,
): Promise<{ inserted: number; deduped: number; balances: number }> {
  const stats = { inserted: 0, deduped: 0, balances: 0 };

  // Journal every op as intent before touching LM; applied_at fills in as we go. seq is
  // unique per run (ops_journal.uq_journal_run_seq): seqBase offsets each account's ops so
  // multiple accounts sharing a connection's run never collide.
  const journaled = ops.map((op, i) => ({
    op,
    journalId: journalOp(deps.db, runId, seqBase + i, op),
  }));

  const inserts = journaled.filter(
    (entry): entry is { op: InsertTxnOp; journalId: number } => entry.op.op === "insert_txn",
  );
  for (let start = 0; start < inserts.length; start += INSERT_BATCH_SIZE) {
    const batch = inserts.slice(start, start + INSERT_BATCH_SIZE);
    const outcomes = await deps.client.insertTransactions(
      batch.map(({ op }) => ({
        date: op.date,
        amount: op.amount,
        payee: op.payee,
        lmAccountId: op.lmAccountId,
        externalId: op.externalId,
        ...(op.categoryId === undefined ? {} : { categoryId: op.categoryId }),
      })),
    );
    for (let i = 0; i < batch.length; i++) {
      const entry = batch[i];
      const outcome = outcomes[i];
      if (!entry || !outcome) continue;
      setLmTxnId(deps.db, entry.op.identityId, outcome.lmTxnId);
      markOpApplied(deps.db, entry.journalId, outcome);
      if (outcome.deduped) stats.deduped++;
      else stats.inserted++;
    }
  }

  for (const { op, journalId } of journaled) {
    if (op.op !== "set_balance") continue;
    await deps.client.setBalance(op.lmAccountId, op.balance, op.asOf);
    recordPushedBalance(deps.db, op.accountId, op.balance);
    markOpApplied(deps.db, journalId, { ok: true });
    stats.balances++;
  }
  return stats;
}

export async function sync(deps: EngineDeps, options: SyncOptions): Promise<ConnectionReport[]> {
  const { config, db, log, notify } = deps;
  const categoryRules = compileCategoryRules(config.categorization);
  const selected = config.accounts.filter(
    (account) => !options.accountIds || options.accountIds.includes(account.id),
  );

  const byConnection = new Map<string, AccountConfig[]>();
  for (const account of selected) {
    byConnection.set(account.connection, [
      ...(byConnection.get(account.connection) ?? []),
      account,
    ]);
  }

  const reports: ConnectionReport[] = [];
  for (const [connectionId, accounts] of byConnection) {
    const connection = config.connections[connectionId];
    if (!connection) continue; // config schema prevents this; belt and braces
    const runId = startRun(db, connectionId, connection.type);
    log(`[${connectionId}] fetching…`);

    let results: Map<string, FetchResult>;
    try {
      results = await deps.fetchConnection(connectionId, connection, {
        onProgress: (step) => log(`[${connectionId}] ${step}`),
        onTwoFactorWait: () => {
          log(`[${connectionId}] waiting for 2FA approval — check the bank app`);
          notify(`${connectionId}: approve the login in the bank app`);
        },
      });
    } catch (error) {
      const { outcome, message } = outcomeOf(error);
      finishRun(db, runId, outcome, message, {});
      log(`[${connectionId}] FAILED (${outcome}): ${message}`);
      reports.push({ connectionId, outcome, error: message, accounts: [] });
      continue;
    }

    const accountReports: AccountReport[] = [];
    let runOutcome: RunOutcome = options.dryRun ? "dry_run" : "ok";
    let runError: string | null = null;
    // Monotonic journal sequence across all accounts sharing this connection's run.
    let seqBase = 0;

    for (const account of accounts) {
      const fetched = results.get(expectedSubAccountKey(account));
      if (!fetched) {
        runOutcome = "schema_drift";
        runError = `sub-account ${expectedSubAccountKey(account)} missing from ${connectionId} fetch`;
        log(`[${account.id}] ${runError}`);
        continue;
      }

      const ingested = ingestAccount(db, runId, account, fetched);
      const ops = planAccount(db, account, fetched, categoryRules);
      accountReports.push({ accountId: account.id, ...ingested, ops });

      log(
        `[${account.id}] matched=${ingested.matched} minted=${ingested.minted}` +
          `${ingested.transitioned ? ` transitioned=${ingested.transitioned}` : ""}` +
          `${ingested.flagged ? ` FLAGGED=${ingested.flagged}` : ""}` +
          `${ingested.vanishFlagged ? ` VANISHED=${ingested.vanishFlagged}` : ""} ops=${ops.length}`,
      );
      for (const op of ops) log(`  ${options.dryRun ? "would " : ""}${describeOp(op)}`);

      if (!options.dryRun && ops.length > 0) {
        try {
          const stats = await applyOps(deps, runId, ops, seqBase);
          seqBase += ops.length;
          log(
            `[${account.id}] applied: inserted=${stats.inserted} deduped=${stats.deduped} balances=${stats.balances}`,
          );
        } catch (error) {
          const { outcome, message } = outcomeOf(error);
          runOutcome = outcome;
          runError = message;
          log(`[${account.id}] APPLY FAILED (${outcome}): ${message} — next run converges`);
        }
      }
    }

    finishRun(db, runId, runOutcome, runError, {
      accounts: accountReports.map((r) => ({
        id: r.accountId,
        matched: r.matched,
        minted: r.minted,
        ops: r.ops.length,
      })),
    });
    reports.push({
      connectionId,
      outcome: runOutcome,
      ...(runError ? { error: runError } : {}),
      accounts: accountReports,
    });
  }
  return reports;
}
