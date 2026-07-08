// Composition of the Santander source for the engine: resolve an access token (cached →
// browser harvest), then fetch all sub-accounts over pure HTTP. Mirrors the betterplan
// connection wiring — the token store is injected by the composition root (main.ts), so this
// stays db-agnostic.

import type { SantanderConnectionConfig } from "../../config.ts";
import { requireEnv } from "../../config.ts";
import { AuthError } from "../../core/errors.ts";
import type { FetchResult } from "../../core/model.ts";
import type { TokenStore } from "../betterplan-auth.ts";
import { credsFingerprint, resolveAccessToken } from "./auth.ts";
import { formatRutCliente } from "./client.ts";
import { makeBrowserHarvester } from "./harvest.ts";
import { fetchSantanderData } from "./index.ts";

export interface SantanderConnectionHooks {
  onProgress?: (step: string) => void;
  onTwoFactorWait?: () => void;
  log?: (message: string) => void;
}

/**
 * Fetch one Santander connection's sub-accounts. Resolves an access token (harvesting via a
 * browser login when the cache is stale), then runs the pure-HTTP fetch. If a data call
 * rejects the token mid-fetch (AuthError), forces a single fresh resolve and retries once —
 * covering a token that expired between mint and use.
 */
export async function fetchSantanderConnection(
  connection: SantanderConnectionConfig,
  store: TokenStore,
  hooks: SantanderConnectionHooks = {},
): Promise<Map<string, FetchResult>> {
  const rut = requireEnv(connection.rut_env);
  const password = requireEnv(connection.password_env);
  const rutCliente = formatRutCliente(rut);

  // exactOptionalPropertyTypes: omit absent hooks rather than setting them to undefined.
  const progress = hooks.onProgress ? { onProgress: hooks.onProgress } : {};
  const twoFactor = hooks.onTwoFactorWait ? { onTwoFactorWait: hooks.onTwoFactorWait } : {};
  const log = hooks.log ? { log: hooks.log, onDebug: hooks.log } : {};

  const harvest = makeBrowserHarvester({ rut, password }, { ...progress, ...twoFactor, ...log });
  const deps = {
    fetchImpl: fetch,
    harvest,
    credsFingerprint: credsFingerprint(rut, password),
    ...(hooks.log ? { log: hooks.log } : {}),
  };

  // Optional backfill knobs (env): SANTANDER_WINDOW_DAYS widens the checking window,
  // SANTANDER_BILLED_STATEMENTS fetches more than the current billed statement per card,
  // SANTANDER_CARTOLA_MONTHS backfills N months of checking statements (cartola PDFs).
  const fetchOptions = {
    ...envInt("SANTANDER_WINDOW_DAYS", "windowDays"),
    ...envInt("SANTANDER_BILLED_STATEMENTS", "billedStatements"),
    ...envInt("SANTANDER_CARTOLA_MONTHS", "cartolaMonths"),
  };

  const run = async (force: boolean): Promise<Map<string, FetchResult>> => {
    const accessToken = await resolveAccessToken(store, deps, { force });
    return fetchSantanderData({ accessToken, rutCliente }, { ...progress }, fetchOptions);
  };

  try {
    return await run(false);
  } catch (err) {
    if (err instanceof AuthError) {
      hooks.log?.("santander: access token rejected mid-fetch — re-harvesting once");
      return run(true);
    }
    throw err;
  }
}

/** Read a positive-integer env var into a `{ [key]: n }` fragment, or `{}` if unset/invalid. */
function envInt(name: string, key: string): Record<string, number> {
  const raw = process.env[name];
  if (!raw) return {};
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? { [key]: n } : {};
}
