// Racional source adapter: Firebase email+password auth → two REST reads → balance
// FetchResults. Stateless per run (fresh sign-in each time; no persisted refresh token).
// Full protocol notes in docs/racional-api.md.
//
// Requests carry a uniform, browser-realistic header set matching the captured web session
// (Firefox/macOS) so traffic is indistinguishable from the real app and does not trip
// anti-automation heuristics. We deliberately never call the app's NotifySuccessfulLogin
// cloud function, which is what keeps scheduled syncs silent.

import { z } from "zod";
import type { RacionalConnectionConfig } from "../config.ts";
import { requireEnv } from "../config.ts";
import { todayInSantiago } from "../core/dates.ts";
import {
  AuthError,
  SchemaDriftError,
  SourceUnavailableError,
  TwoFactorTimeoutError,
} from "../core/errors.ts";
import type { FetchResult } from "../core/model.ts";
import { parseRacionalPayload } from "./racional-payload.ts";
import { persistRawPayload } from "./raw-payload.ts";

// Public Firebase web API key shipped in Racional's client bundle — an app identifier, not a
// secret; safe to commit.
const FIREBASE_KEY = "AIzaSyCHCBAaUWhTc8mGtyqfahJ4cYpeVACoCJk";
const MFA_START_URL = "https://us-central1-racional-prod.cloudfunctions.net/authMfaStart";
const VERIFY_PASSWORD_URL = `https://www.googleapis.com/identitytoolkit/v3/relyingparty/verifyPassword?key=${FIREBASE_KEY}`;
const API_BASE = "https://api.racional.cl";

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:153.0) Gecko/20100101 Firefox/153.0";

const REQUEST_TIMEOUT_MS = 30_000;
const RETRY_BACKOFF_MS = 2_000;

// Firebase verifyPassword error codes that mean "credentials/account problem" — fatal, never
// retried (bank/lockout hygiene). Google may suffix the code, so match by prefix.
const AUTH_ERROR_CODES = [
  "INVALID_PASSWORD",
  "EMAIL_NOT_FOUND",
  "INVALID_LOGIN_CREDENTIALS",
  "USER_DISABLED",
  "TOO_MANY_ATTEMPTS_TRY_LATER",
];

export interface RacionalHooks {
  onProgress?: (step: string) => void;
  /** Present for signature parity with other adapters; racional never waits on an approval. */
  onTwoFactorWait?: () => void;
}

// Auth responses are third-party surfaces that grow fields and carry no money — parse loosely,
// requiring only what we act on (cf. the LM sink's loose response schemas).
const MfaStartSchema = z
  .object({ success: z.boolean().optional(), showMfaModal: z.boolean().optional() })
  .loose();
const VerifyPasswordSchema = z.object({ idToken: z.string().min(1) }).loose();
const VerifyErrorSchema = z.object({ error: z.object({ message: z.string() }).loose() }).loose();

interface HttpResult {
  readonly status: number;
  readonly text: string;
}

/**
 * One HTTP request with a 30s timeout and a single retry (after 2s) on 429, 5xx, or a network
 * error. Never retries other 4xx. Returns the final response for the caller to classify;
 * throws SourceUnavailableError only if every attempt was a network/timeout failure.
 */
async function httpRequest(opts: {
  method: string;
  url: string;
  label: string;
  headers: Record<string, string>;
  body?: string;
  fetchImpl: typeof fetch;
}): Promise<HttpResult> {
  const doFetch = () =>
    opts.fetchImpl(opts.url, {
      method: opts.method,
      headers: opts.headers,
      ...(opts.body === undefined ? {} : { body: opts.body }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

  let response: Response | undefined;
  let networkErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await Bun.sleep(RETRY_BACKOFF_MS);
    try {
      response = await doFetch();
      networkErr = undefined;
    } catch (err) {
      response = undefined;
      networkErr = err;
      continue;
    }
    if (attempt === 0 && (response.status === 429 || response.status >= 500)) continue;
    break;
  }

  if (!response) {
    throw new SourceUnavailableError(`racional ${opts.label} network error`, networkErr);
  }
  return { status: response.status, text: await response.text() };
}

/** Base browser headers shared by every request; per-call headers layer on top. */
function browserHeaders(secFetchSite: "cross-site" | "same-site"): Record<string, string> {
  return {
    "User-Agent": USER_AGENT,
    "Accept-Language": "en-US,en;q=0.9",
    Origin: "https://app.racional.cl",
    Referer: "https://app.racional.cl/",
    DNT: "1",
    "Sec-GPC": "1",
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": secFetchSite,
  };
}

function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new SourceUnavailableError(`racional ${label} returned non-JSON: ${text.slice(0, 200)}`);
  }
}

/** Classify a Bearer-authed data read: 200 → JSON, 401/403 → AuthError, else unavailable. */
function readAuthedJson(res: HttpResult, label: string): unknown {
  if (res.status === 401 || res.status === 403) {
    throw new AuthError(`racional ${label} rejected the session token (HTTP ${res.status})`);
  }
  if (res.status !== 200) {
    throw new SourceUnavailableError(
      `racional ${label} HTTP ${res.status}: ${res.text.slice(0, 300)}`,
    );
  }
  return parseJson(res.text, label);
}

async function signIn(
  email: string,
  password: string,
  deviceId: string,
  hooks: RacionalHooks,
  fetchImpl: typeof fetch,
): Promise<string> {
  // 1. Device-trust gate — run before verifyPassword so an untrusted device does not burn a
  //    password attempt. An untrusted device is expected to demand an emailed MFA code we
  //    cannot answer headlessly.
  hooks.onProgress?.("checking device trust");
  const mfaRes = await httpRequest({
    method: "POST",
    url: MFA_START_URL,
    label: "authMfaStart",
    headers: {
      ...browserHeaders("cross-site"),
      Accept: "application/json, text/plain, */*",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email, deviceId, method: "email" }),
    fetchImpl,
  });
  if (mfaRes.status !== 200) {
    throw new SourceUnavailableError(
      `racional authMfaStart HTTP ${mfaRes.status}: ${mfaRes.text.slice(0, 300)}`,
    );
  }
  const mfa = MfaStartSchema.parse(parseJson(mfaRes.text, "authMfaStart"));
  if (mfa.showMfaModal === true) {
    throw new TwoFactorTimeoutError(
      "racional requires an MFA code (showMfaModal=true) — this device is not trusted; " +
        "re-capture a trusted deviceId from an authenticated web session (see docs/racional-api.md)",
    );
  }
  if (mfa.success !== true) {
    throw new SourceUnavailableError(
      `racional authMfaStart returned success!=true: ${mfaRes.text.slice(0, 200)}`,
    );
  }

  // 2. Firebase sign-in.
  hooks.onProgress?.("signing in");
  const vpRes = await httpRequest({
    method: "POST",
    url: VERIFY_PASSWORD_URL,
    label: "verifyPassword",
    headers: {
      ...browserHeaders("cross-site"),
      Accept: "*/*",
      "Content-Type": "application/json",
      "X-Client-Version": "Firefox/JsCore/8.10.1/FirebaseCore-web",
    },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
    fetchImpl,
  });
  if (vpRes.status === 400) {
    const parsed = VerifyErrorSchema.safeParse(parseJson(vpRes.text, "verifyPassword"));
    const code = parsed.success ? parsed.data.error.message : vpRes.text.slice(0, 120);
    if (AUTH_ERROR_CODES.some((c) => code.startsWith(c))) {
      throw new AuthError(`racional sign-in rejected: ${code}`);
    }
    throw new SourceUnavailableError(`racional verifyPassword 400: ${code}`);
  }
  if (vpRes.status !== 200) {
    throw new SourceUnavailableError(
      `racional verifyPassword HTTP ${vpRes.status}: ${vpRes.text.slice(0, 300)}`,
    );
  }
  return VerifyPasswordSchema.parse(parseJson(vpRes.text, "verifyPassword")).idToken;
}

/**
 * Fetch balances for a Racional connection: sign in, read positions + buying-power, parse
 * into per-sub-account FetchResults ("investment", "investment:stocks", "investment:cash").
 * Throws classified SyncErrors; persists the raw payload on schema drift.
 */
export async function fetchRacionalConnection(
  connection: RacionalConnectionConfig,
  hooks: RacionalHooks = {},
  fetchImpl: typeof fetch = fetch,
): Promise<Map<string, FetchResult>> {
  // Fail fast on missing secrets before any network I/O.
  const email = requireEnv(connection.email_env);
  const password = requireEnv(connection.password_env);
  const deviceId = requireEnv(connection.device_id_env);

  const idToken = await signIn(email, password, deviceId, hooks, fetchImpl);

  hooks.onProgress?.("fetching positions");
  const authedGet = (path: string, label: string) =>
    httpRequest({
      method: "GET",
      url: `${API_BASE}${path}`,
      label,
      headers: {
        ...browserHeaders("same-site"),
        Accept: "application/json",
        Authorization: `Bearer ${idToken}`,
      },
      fetchImpl,
    });

  const [positionsRes, buyingPowerRes] = await Promise.all([
    authedGet("/positions", "positions"),
    authedGet("/positions/buying-power", "buying-power"),
  ]);
  const positionsRaw = readAuthedJson(positionsRes, "positions");
  const buyingPowerRaw = readAuthedJson(buyingPowerRes, "buying-power");

  try {
    return parseRacionalPayload(
      positionsRaw,
      buyingPowerRaw,
      todayInSantiago(),
      new Date().toISOString(),
    );
  } catch (err) {
    if (err instanceof SchemaDriftError) {
      const path = await persistRawPayload("racional", {
        positions: positionsRaw,
        buyingPower: buyingPowerRaw,
      });
      throw new SchemaDriftError(`${err.message} (raw payload: ${path})`, path, err);
    }
    throw err;
  }
}
