// Santander token manager: a fresh access token for the pure-HTTP client, minting a new
// one as cheaply as possible.
//
// Santander's token endpoint is gated by Akamai Bot Manager (an `Akamai-BM-Telemetry`
// header only a real browser produces), so the FIRST token of a chain must come from a
// browser login — the injected `harvest` callback (a Puppeteer subprocess in prod). The
// response also carries a `refresh_token`; whether the refresh grant ALSO needs Akamai is
// untested (a live login answers it), so this manager tries the pure-HTTP refresh first
// and, on any failure, FALLS BACK to a browser harvest. It is therefore correct either
// way: if refresh is pure-HTTP the browser runs rarely; if it needs Akamai the refresh
// always fails and every stale-token run harvests. A once-daily sync harvesting each run
// is still well within the login throttle.
//
// Contrast with betterplan-auth.ts: there a dead refresh chain needs a MANUAL browser
// re-bootstrap, so reuse-revocation is catastrophic and the rules are load-bearing. Here
// the creds live in env and a dead chain SELF-HEALS via harvest, so the discipline is
// lighter — but the exclusive lock is still essential (two concurrent browser logins would
// trip Santander's ~3-logins/15-min throttle or its overnight lockout).

import { closeSync, openSync, statSync, unlinkSync } from "node:fs";
import { z } from "zod";
import { AuthError, SourceUnavailableError } from "../../core/errors.ts";
import type { Db } from "../../state/db.ts";
import type { ConnectionSecret } from "../../state/repo.ts";
import { getConnectionSecret, setConnectionSecret } from "../../state/repo.ts";
import type { TokenStore } from "../betterplan-auth.ts";

const TOKEN_URL =
  "https://apideveloper.santander.cl/sancl/privado/party_authentication_restricted/party_auth_dss/v1/oauth2/token";
/** Public app client id from the frontend bundle (not a secret). */
const CLIENT_ID = "4e9af62c-6563-42cd-aab6-0dd7d50a9131";
const SCOPE = "Completa";
const REFRESH_TIMEOUT_MS = 30_000;
/**
 * Treat a token as stale this long before its own expiry. Santander access tokens are
 * short-lived, so on a once-daily run the cache essentially never hits; this margin mainly
 * protects a manual re-run within the token's lifetime from presenting a token that expires
 * mid-fetch.
 */
const REFRESH_SKEW_MS = 60_000;

/** Tokens minted by a browser login (the Akamai-gated grant the harvester performs). */
export interface HarvestedToken {
  readonly accessToken: string;
  /** Santander returns one; null if a future login stops doing so. */
  readonly refreshToken: string | null;
  /** ISO expiry; derive from the access-token JWT when the login doesn't state one. */
  readonly accessTokenExpiresAt: string;
}

/**
 * Perform a browser login and return its freshly-minted tokens. Prod wires a Puppeteer
 * subprocess; tests inject a fake. MUST throw the typed taxonomy (AuthError on bad creds,
 * TwoFactorTimeoutError on an unmet second factor, SourceUnavailableError otherwise) so the
 * engine's failover policy applies unchanged.
 */
export type BrowserHarvester = () => Promise<HarvestedToken>;

export interface SantanderAuthDeps {
  readonly fetchImpl: typeof fetch;
  readonly harvest: BrowserHarvester;
  /**
   * sha256 of the current RUT+password. A change (operator rotated the bank password)
   * discards the stored refresh chain and forces a harvest with the new creds — the analog
   * of betterplan's seed-fingerprint re-bootstrap.
   */
  readonly credsFingerprint: string;
  readonly log?: (message: string) => void;
}

const RefreshResponseSchema = z
  .object({
    access_token: z.string().min(1),
    // Optional on refresh: if Santander doesn't re-issue one we keep the presented token.
    refresh_token: z.string().min(1).optional(),
  })
  .loose();

/**
 * Read a JWT's `exp` claim as an ISO string, WITHOUT verifying the signature — this is only
 * a cache-invalidation hint; the server's 401 is the real authority on expiry. Returns null
 * when the token isn't a decodable JWT or carries no numeric `exp`.
 */
export function accessTokenExpiry(accessToken: string): string | null {
  const segments = accessToken.split(".");
  if (segments.length !== 3) return null;
  const payloadSegment = segments[1];
  if (!payloadSegment) return null;
  try {
    const json = Buffer.from(payloadSegment, "base64url").toString("utf8");
    const exp = (JSON.parse(json) as { exp?: unknown }).exp;
    if (typeof exp !== "number" || !Number.isFinite(exp)) return null;
    return new Date(exp * 1000).toISOString();
  } catch {
    return null;
  }
}

function isFresh(secret: ConnectionSecret): boolean {
  if (!secret.accessToken || !secret.accessTokenExpiresAt) return false;
  const exp = Date.parse(secret.accessTokenExpiresAt);
  return Number.isFinite(exp) && exp - Date.now() > REFRESH_SKEW_MS;
}

/**
 * POST the refresh grant over pure HTTP. NO RETRY — a lost response may already have rotated
 * the token; here that's harmless (the fallback harvest self-heals), but retrying a rotated
 * grant is never useful. Any failure is surfaced so the caller falls back to a harvest.
 */
async function refreshGrant(
  refreshToken: string,
  fetchImpl: typeof fetch,
): Promise<HarvestedToken> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: CLIENT_ID,
    scope: SCOPE,
  });
  let res: Response;
  try {
    res = await fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        Origin: "https://mibanco.santander.cl",
        Referer: "https://mibanco.santander.cl/",
      },
      body: body.toString(),
      signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
    });
  } catch (err) {
    throw new SourceUnavailableError("santander token refresh network error", err);
  }
  const text = await res.text();
  if (res.status === 400 || res.status === 401 || res.status === 403) {
    // Includes the Akamai-gated case (a 400/403 with no valid telemetry): treat as "refresh
    // not usable" and let the caller harvest.
    throw new AuthError(`santander token refresh rejected (HTTP ${res.status})`);
  }
  if (res.status !== 200) {
    throw new SourceUnavailableError(`santander token endpoint HTTP ${res.status}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new SourceUnavailableError("santander token endpoint returned non-JSON");
  }
  const parsed = RefreshResponseSchema.safeParse(json);
  if (!parsed.success) {
    throw new SourceUnavailableError("santander token refresh response missing an access token");
  }
  const accessToken = parsed.data.access_token;
  const expiry = accessTokenExpiry(accessToken);
  if (!expiry) {
    throw new SourceUnavailableError("santander refresh access token is not a decodable JWT");
  }
  return {
    accessToken,
    refreshToken: parsed.data.refresh_token ?? refreshToken,
    accessTokenExpiresAt: expiry,
  };
}

function persist(store: TokenStore, token: HarvestedToken, credsFingerprint: string): string {
  store.set({
    // The schema's refresh_token column is NOT NULL; an absent one stores "" and reads back
    // as "no usable refresh" (see resolveAccessToken).
    refreshToken: token.refreshToken ?? "",
    accessToken: token.accessToken,
    accessTokenExpiresAt: token.accessTokenExpiresAt,
    seedFingerprint: credsFingerprint,
  });
  return token.accessToken;
}

/**
 * Resolve a usable access token. Fast path returns a fresh cached token with no network or
 * lock. Otherwise, under the store's exclusive lock: try a pure-HTTP refresh (if a usable
 * refresh token is stored under the current creds), and on ANY failure fall back to a browser
 * harvest. The minted tokens are persisted BEFORE returning, so a crash after a data call
 * still leaves a valid cached token.
 */
export async function resolveAccessToken(
  store: TokenStore,
  deps: SantanderAuthDeps,
  opts: { force?: boolean } = {},
): Promise<string> {
  // Fast path (no lock): a fresh cached token minted under the current creds. `force` skips it
  // when the caller saw the cached token rejected mid-run and wants a fresh one.
  const current = store.get();
  if (
    !opts.force &&
    current &&
    isFresh(current) &&
    current.seedFingerprint === deps.credsFingerprint
  ) {
    return current.accessToken as string;
  }

  return store.withLock(async () => {
    const row = store.get();
    // A refresh token is only usable if it was minted under the CURRENT creds; a fingerprint
    // mismatch means the operator changed the bank password, so the old chain is abandoned.
    const underCurrentCreds = row?.seedFingerprint === deps.credsFingerprint ? row : null;

    // Re-check freshness inside the lock: a concurrent holder may have just refreshed/harvested.
    if (!opts.force && underCurrentCreds && isFresh(underCurrentCreds)) {
      return underCurrentCreds.accessToken as string;
    }

    const usableRefresh =
      underCurrentCreds && underCurrentCreds.refreshToken.length > 0
        ? underCurrentCreds.refreshToken
        : null;

    if (usableRefresh) {
      try {
        const refreshed = await refreshGrant(usableRefresh, deps.fetchImpl);
        deps.log?.("santander: refreshed access token over HTTP (no browser needed)");
        return persist(store, refreshed, deps.credsFingerprint);
      } catch (err) {
        // Fail soft: the chain may be dead or the refresh grant may itself require Akamai.
        // Either way a browser harvest re-establishes it. Never fatal here.
        const reason = err instanceof Error ? err.message : String(err);
        deps.log?.(`santander: HTTP refresh unavailable (${reason}); harvesting via browser`);
      }
    }

    deps.log?.("santander: harvesting a fresh token via browser login");
    const harvested = await deps.harvest();
    return persist(store, harvested, deps.credsFingerprint);
  });
}

/** sha256 hex of the connection's bank creds; changes invalidate the stored refresh chain. */
export function credsFingerprint(rut: string, password: string): string {
  return new Bun.CryptoHasher("sha256").update(`${rut} ${password}`).digest("hex");
}

// ---------- db-backed store with a cross-process advisory lock ----------
//
// A local twin of betterplan-auth's lock: kept separate (rather than importing) so parallel
// work on that file can't perturb Santander's auth, and so the lock filename is Santander's.

const LOCK_STALE_MS = 120_000;
const LOCK_WAIT_TIMEOUT_MS = 60_000;
const LOCK_POLL_MS = 200;

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

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
          `santander: timed out waiting for token lock ${lockPath} (another sync running?)`,
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

export function makeSantanderTokenStore(db: Db, connectionId: string, lockDir: string): TokenStore {
  const lockPath = `${lockDir}/.santander-token-${connectionId}.lock`;
  return {
    get: () => getConnectionSecret(db, connectionId),
    set: (secret) => setConnectionSecret(db, connectionId, secret),
    withLock: (fn) => withFileLock(lockPath, fn),
  };
}
