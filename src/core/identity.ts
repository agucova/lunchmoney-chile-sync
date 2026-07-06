// Transaction identity: assigned once, DB-authoritative afterwards.
//
// Matching is BUCKET-BASED, not per-transaction-hash: the stable fields (account,
// date, amount, currency) group incoming transactions and stored identities into
// buckets, and descriptions are reconciled *within* each bucket by truncation-tolerant
// similarity. This is what makes identity robust to the observed messiness: the same
// transaction can arrive as "PAYU *UBER EA" in one run and "PAYU *UBER EATS" in the
// next (per-response truncation), and must NOT mint a duplicate.
//
// The content hash is only the external_id generator at mint time. Once minted, an
// identity is never recomputed-and-trusted — the DB is the source of truth.

import type { IsoDate } from "./dates.ts";
import { invariant } from "./errors.ts";
import type { CanonicalTxn, TxnStatus } from "./model.ts";
import type { Money } from "./money.ts";
import { SIMILARITY_THRESHOLD, descriptionSimilarity } from "./normalize.ts";

export interface StoredIdentity {
  readonly id: number;
  readonly accountId: string;
  readonly externalId: string;
  readonly bucketHash: string;
  readonly occurrence: number;
  readonly date: IsoDate;
  readonly amount: Money;
  readonly normDesc: string;
  readonly rawDesc: string;
  readonly descVariants: readonly string[];
  readonly status: TxnStatus;
  readonly installments: string | null;
  readonly lmTxnId: number | null;
  readonly flagged: string | null;
}

/** 40-hex content hash over the stable fields + normalized description. */
export function contentHash(accountId: string, txn: CanonicalTxn): string {
  const input = [
    accountId,
    txn.date,
    txn.amount.minor.toString(),
    txn.amount.currency,
    txn.normDescription,
    txn.meta.installments ?? "",
  ].join("|");
  return new Bun.CryptoHasher("sha256").update(input).digest("hex").slice(0, 40);
}

/** external_id: "<40-hex>-NN" — 43 chars, well under LM's 75-char limit. */
export function formatExternalId(bucketHash: string, occurrence: number): string {
  invariant(occurrence >= 0 && occurrence < 100, `occurrence out of range: ${occurrence}`);
  return `${bucketHash}-${String(occurrence).padStart(2, "0")}`;
}

export interface MatchedPair {
  readonly identity: StoredIdentity;
  readonly txn: CanonicalTxn;
  readonly score: number;
  /** Set when this run observed a description variant not yet recorded. */
  readonly newVariant?: string;
}

export interface MintPlan {
  readonly txn: CanonicalTxn;
  readonly bucketHash: string;
  readonly occurrence: number;
  readonly externalId: string;
  /** Non-null when the mint happened under ambiguity worth human eyes. */
  readonly flagged: string | null;
}

export interface MatchOutcome {
  readonly matched: readonly MatchedPair[];
  readonly toMint: readonly MintPlan[];
  /** Stored identities in the window that no incoming txn matched (Phase 2: vanish candidates). */
  readonly unmatchedExisting: readonly StoredIdentity[];
}

function bucketKey(date: IsoDate, amount: Money): string {
  return `${date}|${amount.minor}|${amount.currency}`;
}

/** Best similarity of a txn description against an identity (normDesc + variants). */
function identityScore(txn: CanonicalTxn, identity: StoredIdentity): number {
  let best = descriptionSimilarity(txn.normDescription, identity.normDesc);
  for (const variant of identity.descVariants) {
    const score = descriptionSimilarity(txn.normDescription, variant);
    if (score > best) best = score;
  }
  return best;
}

/**
 * Reconcile incoming transactions against stored identities. Pure and deterministic:
 * same inputs ⇒ same outcome, regardless of input ordering quirks.
 */
export function matchTransactions(
  accountId: string,
  incoming: readonly CanonicalTxn[],
  existing: readonly StoredIdentity[],
): MatchOutcome {
  // Deterministic base order regardless of scrape order.
  const sortedIncoming = [...incoming].sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      (a.amount.minor < b.amount.minor ? -1 : a.amount.minor > b.amount.minor ? 1 : 0) ||
      a.normDescription.localeCompare(b.normDescription),
  );

  const byBucket = new Map<string, { txns: CanonicalTxn[]; identities: StoredIdentity[] }>();
  for (const txn of sortedIncoming) {
    const key = bucketKey(txn.date, txn.amount);
    const bucket = byBucket.get(key) ?? { txns: [], identities: [] };
    bucket.txns.push(txn);
    byBucket.set(key, bucket);
  }
  for (const identity of existing) {
    invariant(identity.accountId === accountId, "identity from another account in match set");
    const key = bucketKey(identity.date, identity.amount);
    const bucket = byBucket.get(key);
    if (bucket) bucket.identities.push(identity);
    // Identities in buckets with no incoming txns are handled below as unmatched.
  }

  const matched: MatchedPair[] = [];
  const toMint: MintPlan[] = [];
  const usedIdentityIds = new Set<number>();
  // Occurrence assignment must account for identities minted earlier in this same call.
  const mintedPerHash = new Map<string, number>();
  const existingPerHash = new Map<string, number>();
  for (const identity of existing) {
    existingPerHash.set(identity.bucketHash, (existingPerHash.get(identity.bucketHash) ?? 0) + 1);
  }

  for (const bucket of byBucket.values()) {
    const candidates: Array<{ txnIdx: number; identity: StoredIdentity; score: number }> = [];
    for (let txnIdx = 0; txnIdx < bucket.txns.length; txnIdx++) {
      const txn = bucket.txns[txnIdx];
      invariant(txn, "bucket index out of range");
      for (const identity of bucket.identities) {
        const score = identityScore(txn, identity);
        if (score >= SIMILARITY_THRESHOLD) candidates.push({ txnIdx, identity, score });
      }
    }
    // Greedy best-first; ties broken by identity age (older id first), then txn order.
    candidates.sort(
      (a, b) => b.score - a.score || a.identity.id - b.identity.id || a.txnIdx - b.txnIdx,
    );

    const usedTxnIdx = new Set<number>();
    for (const candidate of candidates) {
      if (usedTxnIdx.has(candidate.txnIdx) || usedIdentityIds.has(candidate.identity.id)) {
        continue;
      }
      usedTxnIdx.add(candidate.txnIdx);
      usedIdentityIds.add(candidate.identity.id);
      const txn = bucket.txns[candidate.txnIdx];
      invariant(txn, "bucket index out of range");
      const isKnownVariant =
        txn.normDescription === candidate.identity.normDesc ||
        candidate.identity.descVariants.includes(txn.normDescription);
      matched.push({
        identity: candidate.identity,
        txn,
        score: candidate.score,
        ...(isKnownVariant ? {} : { newVariant: txn.normDescription }),
      });
    }

    // Leftover incoming transactions mint new identities.
    for (let txnIdx = 0; txnIdx < bucket.txns.length; txnIdx++) {
      if (usedTxnIdx.has(txnIdx)) continue;
      const txn = bucket.txns[txnIdx];
      invariant(txn, "bucket index out of range");
      const hash = contentHash(accountId, txn);
      const occurrence = (existingPerHash.get(hash) ?? 0) + (mintedPerHash.get(hash) ?? 0);
      mintedPerHash.set(hash, (mintedPerHash.get(hash) ?? 0) + 1);
      // Ambiguity flag: unmatched txn in a bucket that still had unmatched identities
      // below threshold means a near-miss — worth surfacing, not guessing.
      const nearMiss = bucket.identities.some(
        (identity) => !usedIdentityIds.has(identity.id) && identityScore(txn, identity) > 0.3,
      );
      toMint.push({
        txn,
        bucketHash: hash,
        occurrence,
        externalId: formatExternalId(hash, occurrence),
        flagged: nearMiss
          ? `minted despite near-miss candidates in bucket ${bucketKey(txn.date, txn.amount)}`
          : null,
      });
    }
  }

  const unmatchedExisting = existing.filter((identity) => !usedIdentityIds.has(identity.id));

  return { matched, toMint, unmatchedExisting };
}

/**
 * Same-run cross-status dedupe for credit cards: around statement close, the same
 * purchase can momentarily appear in BOTH the unbilled and billed lists. When an
 * unbilled and a billed incoming txn share a bucket and read as the same merchant,
 * the billed one wins (it is the more settled observation).
 */
export function dedupeCrossStatus(incoming: readonly CanonicalTxn[]): CanonicalTxn[] {
  const billedByBucket = new Map<string, CanonicalTxn[]>();
  for (const txn of incoming) {
    if (txn.status !== "billed") continue;
    const key = bucketKey(txn.date, txn.amount);
    billedByBucket.set(key, [...(billedByBucket.get(key) ?? []), txn]);
  }
  const consumed = new Set<CanonicalTxn>();
  const kept: CanonicalTxn[] = [];
  for (const txn of incoming) {
    if (txn.status !== "unbilled") {
      kept.push(txn);
      continue;
    }
    const twin = (billedByBucket.get(bucketKey(txn.date, txn.amount)) ?? []).find(
      (billed) =>
        !consumed.has(billed) &&
        descriptionSimilarity(txn.normDescription, billed.normDescription) >= SIMILARITY_THRESHOLD,
    );
    if (twin) consumed.add(twin);
    else kept.push(txn);
  }
  return kept;
}

export interface TransitionMatch {
  readonly identity: StoredIdentity;
  readonly txn: CanonicalTxn;
  readonly score: number;
  /** Amounts differ (FX settlement candidate) — review, never auto-apply. */
  readonly amountMismatch: boolean;
}

/** Max posting-date drift between an unbilled purchase and its billed appearance. */
const TRANSITION_DATE_WINDOW_DAYS = 5;

/**
 * Wider matching pass for billed txns that missed the exact bucket: an open unbilled
 * identity with the SAME amount within a small date window is the same purchase whose
 * posting date drifted. Installment indexes must agree when both sides carry one.
 * Deterministic; ambiguity resolves to the older identity and gets a low score.
 */
export function matchBilledTransitions(
  unmatchedBilled: readonly CanonicalTxn[],
  openUnbilled: readonly StoredIdentity[],
  daysApart: (a: IsoDate, b: IsoDate) => number,
): TransitionMatch[] {
  const matches: TransitionMatch[] = [];
  const usedIdentityIds = new Set<number>();

  const sortedBilled = [...unmatchedBilled].sort(
    (a, b) => a.date.localeCompare(b.date) || a.normDescription.localeCompare(b.normDescription),
  );

  for (const txn of sortedBilled) {
    if (txn.status !== "billed") continue;
    const candidates = openUnbilled
      .filter((identity) => {
        if (usedIdentityIds.has(identity.id)) return false;
        if (identity.status !== "unbilled") return false;
        if (!identity.amount.equals(txn.amount)) return false;
        if (Math.abs(daysApart(identity.date, txn.date)) > TRANSITION_DATE_WINDOW_DAYS) {
          return false;
        }
        if (
          identity.installments &&
          txn.meta.installments &&
          identity.installments !== txn.meta.installments
        ) {
          return false;
        }
        return true;
      })
      .map((identity) => ({
        identity,
        score: descriptionSimilarity(txn.normDescription, identity.normDesc),
      }))
      .sort((a, b) => b.score - a.score || a.identity.id - b.identity.id);

    const best = candidates[0];
    if (best && best.score >= SIMILARITY_THRESHOLD) {
      usedIdentityIds.add(best.identity.id);
      matches.push({
        identity: best.identity,
        txn,
        score: best.score,
        amountMismatch: false, // amount equality is a filter above; FX arrives separately
      });
    }
  }
  return matches;
}
