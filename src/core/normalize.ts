// Description normalization for identity hashing and matching. VERSIONED: the version
// is recorded on every identity at mint time. Changing the algorithm requires bumping
// NORMALIZE_VERSION — existing identities keep their stored normalization forever (the
// DB is identity truth; hashes are never recomputed-and-trusted).

export const NORMALIZE_VERSION = 1;

/**
 * v1: uppercase, strip diacritics, collapse all whitespace runs to one space, trim.
 * Deliberately does NOT try to unify merchant-truncation variants ("UBER EA" vs
 * "UBER EATS") — that is the matcher's job (prefix-tolerant similarity), not the
 * hash's, because a hash must never depend on which truncation a run happened to see.
 */
export function normalizeDescription(raw: string): string {
  return raw.normalize("NFD").replace(/\p{M}/gu, "").toUpperCase().replace(/\s+/g, " ").trim();
}

/**
 * Similarity for bucket-internal matching where date+amount already agree.
 * Truncation-tolerant: if one normalized description is a prefix of the other
 * (ignoring a trailing partial token), they are considered the same merchant string.
 * Returns a score in [0, 1].
 */
export function descriptionSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  if (shorter.length === 0) return 0;
  if (longer.startsWith(shorter)) return 0.95;
  const prefixLen = commonPrefixLength(shorter, longer);
  return (prefixLen / longer.length) * 0.9;
}

function commonPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a[i] === b[i]) i++;
  return i;
}

/**
 * Match threshold used by the identity matcher: within a (account, date, amount)
 * bucket, candidates at or above this score are considered the same transaction.
 */
export const SIMILARITY_THRESHOLD = 0.55;
