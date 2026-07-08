// Betterplan OAuth: refresh-token grant with rotation, against IdentityServer4 at
// id.betterplan.cl (public PKCE client `portal-ts-code`, no secret). See docs/betterplan-api.md.
//
// Reliability rules (an architecture review drove these — a slip means a manual browser
// re-bootstrap, so they are load-bearing, not defensive niceties):
//   - The refresh token ROTATES on every use and the identity provider revokes the whole token
//     family on reuse. So: single-flight the refresh under an exclusive lock, and persist the
//     new refresh token BEFORE any data call.
//   - NEVER retry the rotating token POST: a lost response after the server already rotated,
//     replayed, is a reuse → family revocation. A network failure there is source_unavailable
//     (next run retries with the still-valid stored token iff the request never landed).
//   - Cache the 30-day access token to its expiry so most runs make zero token calls.
//   - A missing rotated refresh token in the response, or `invalid_grant`, fails closed.

import { openSync, closeSync, unlinkSync, statSync } from "node:fs";
import { z } from "zod";
import { AuthError, SourceUnavailableError } from "../core/errors.ts";
import type { ConnectionSecret } from "../state/repo.ts";
import { getConnectionSecret, setConnectionSecret } from "../state/repo.ts";
import type { Db } from "../state/db.ts";

const TOKEN_URL = "https://id.betterplan.cl/connect/token";
const CLIENT_ID = "portal-ts-code";
const SCOPE = "openid profile email apiv1 apiv2 offline_access IdentityServerApi";
const REFRESH_TIMEOUT_MS = 30_000;
// Refresh this far before the access token's own expiry (30-day token, so a 24h skew margin
// is generous and keeps refreshes to ~monthly).
const REFRESH_SKEW_MS = 24 * 60 * 60 * 1000;

/**
 * Per-connection persistence + exclusive lock for the rotating secret. Prod is db-backed
 * (`makeDbTokenStore`); tests inject a fake. `withLock` must serialize the whole
 * read-decide-refresh-write across processes on one host.
 */
export interface TokenStore {
  get(): ConnectionSecret | null;
  set(secret: ConnectionSecret): void;
  withLock<T>(fn: () => Promise<T>): Promise<T>;
}

export interface AuthDeps {
  /** Bootstrap seed: the env refresh token. undefined once the DB row is authoritative. */
  readonly envSeed: string | undefined;
  readonly fetchImpl: typeof fetch;
  readonly log?: (message: string) => void;
}

const TokenResponseSchema = z
  .object({
    access_token: z.string().min(1),
    // A rotated refresh token is mandatory — its absence means we'd be left with a spent token.
    refresh_token: z.string().min(1),
    expires_in: z.number().finite().positive(),
  })
  .loose();

function sha256Hex(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

function isFresh(secret: ConnectionSecret): boolean {
  if (!secret.accessToken || !secret.accessTokenExpiresAt) return false;
  const exp = Date.parse(secret.accessTokenExpiresAt);
  return Number.isFinite(exp) && exp - Date.now() > REFRESH_SKEW_MS;
}

/** POST the refresh grant. NO RETRY (see file header). Returns the rotated tokens. */
async function refreshGrant(
  refreshToken: string,
  fetchImpl: typeof fetch,
): Promise<ConnectionSecret> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    scope: SCOPE,
    client_id: CLIENT_ID,
  });
  let res: Response;
  try {
    res = await fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        Origin: "https://portal.betterplan.cl",
        Referer: "https://portal.betterplan.cl/",
      },
      body: body.toString(),
      signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
    });
  } catch (err) {
    // Do not retry: the request may have reached the server and rotated the token already.
    throw new SourceUnavailableError("betterplan token refresh network error", err);
  }
  const text = await res.text();
  if (res.status === 400 || res.status === 401) {
    let code = text.slice(0, 120);
    try {
      code = (JSON.parse(text) as { error?: string }).error ?? code;
    } catch {
      // non-JSON error body; keep the snippet
    }
    if (code === "invalid_grant") {
      throw new AuthError(
        "betterplan refresh token rejected (invalid_grant) — the token chain is dead; " +
          "re-bootstrap: capture a fresh refresh token from a browser login and update the seed env var",
      );
    }
    throw new AuthError(`betterplan token refresh failed: ${code}`);
  }
  if (res.status !== 200) {
    throw new SourceUnavailableError(`betterplan token endpoint HTTP ${res.status}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new SourceUnavailableError("betterplan token endpoint returned non-JSON");
  }
  const parsed = TokenResponseSchema.safeParse(json);
  if (!parsed.success) {
    // Fail closed: no rotated refresh token means the next run would present a spent token.
    throw new AuthError(
      "betterplan token response missing a rotated refresh token — failing closed",
    );
  }
  return {
    accessToken: parsed.data.access_token,
    refreshToken: parsed.data.refresh_token,
    accessTokenExpiresAt: new Date(Date.now() + parsed.data.expires_in * 1000).toISOString(),
    seedFingerprint: null, // set by the caller (carries the current seed's fingerprint)
  };
}

/**
 * Resolve a usable access token: fast path returns a fresh cached token with no token call;
 * otherwise refresh under the store's exclusive lock, persisting the rotated tokens before
 * returning. Bootstrap precedence: no DB row → adopt env seed; DB row whose seed fingerprint
 * still matches the env (or env unset) → DB authoritative; fingerprint mismatch → the operator
 * deliberately changed the seed → re-bootstrap from env. Never replays the env seed on
 * invalid_grant (that would risk a reuse revocation of a live chain).
 */
export async function resolveAccessToken(
  store: TokenStore,
  deps: AuthDeps,
  opts: { force?: boolean } = {},
): Promise<string> {
  const envFp = deps.envSeed ? sha256Hex(deps.envSeed) : null;

  // Fast path: a fresh cached token whose seed fingerprint is consistent with the env — no lock.
  // Skipped when `force` (the caller saw the cached token rejected and wants a fresh one).
  const current = store.get();
  if (
    !opts.force &&
    current &&
    isFresh(current) &&
    (deps.envSeed === undefined || current.seedFingerprint === envFp)
  ) {
    return current.accessToken as string;
  }

  return store.withLock(async () => {
    const row = store.get();
    let refreshToken: string;
    let fingerprint: string | null;
    let cached: ConnectionSecret | null = null;

    if (!row) {
      if (!deps.envSeed) {
        throw new AuthError(
          "betterplan: no stored refresh token and no bootstrap seed — set the refresh_token_env " +
            "to a refresh token captured from a browser login (see docs/betterplan-api.md)",
        );
      }
      refreshToken = deps.envSeed;
      fingerprint = envFp;
    } else if (deps.envSeed !== undefined && row.seedFingerprint !== envFp) {
      deps.log?.("betterplan: bootstrap seed changed — re-bootstrapping token chain from env");
      refreshToken = deps.envSeed;
      fingerprint = envFp;
    } else {
      refreshToken = row.refreshToken;
      fingerprint = row.seedFingerprint;
      cached = row;
    }

    // Re-check freshness inside the lock (a concurrent holder may have just refreshed), unless
    // the caller forced a refresh because the cached token was rejected mid-run.
    if (!opts.force && cached && isFresh(cached)) return cached.accessToken as string;

    const refreshed = await refreshGrant(refreshToken, deps.fetchImpl);
    const toStore: ConnectionSecret = { ...refreshed, seedFingerprint: fingerprint };
    store.set(toStore); // persist BEFORE the caller makes any data call
    return toStore.accessToken as string;
  });
}

// ---------- db-backed store with a cross-process advisory lock ----------

const LOCK_STALE_MS = 120_000;
const LOCK_WAIT_TIMEOUT_MS = 60_000;
const LOCK_POLL_MS = 200;

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Advisory lockfile (O_EXCL create) with a stale-age override, adequate for the single-host
 * deployment where the only real contention is a manual run overlapping the daily timer. Not a
 * distributed lock; the blast radius of a slip is a re-bootstrap, and the stale override stops a
 * crashed holder from wedging the connection forever.
 */
async function withFileLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS;
  for (;;) {
    try {
      closeSync(openSync(lockPath, "wx"));
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
          unlinkSync(lockPath);
          continue;
        }
      } catch {
        // lock vanished between stat and now — retry the create
      }
      if (Date.now() > deadline) {
        throw new SourceUnavailableError(
          `betterplan: timed out waiting for token lock ${lockPath} (another sync running?)`,
        );
      }
      await sleep(LOCK_POLL_MS);
    }
  }
  try {
    return await fn();
  } finally {
    try {
      unlinkSync(lockPath);
    } catch {
      // already gone (stale-cleared by another process)
    }
  }
}

export function makeDbTokenStore(db: Db, connectionId: string, lockDir: string): TokenStore {
  const lockPath = `${lockDir}/.betterplan-token-${connectionId}.lock`;
  return {
    get: () => getConnectionSecret(db, connectionId),
    set: (secret) => setConnectionSecret(db, connectionId, secret),
    withLock: (fn) => withFileLock(lockPath, fn),
  };
}
