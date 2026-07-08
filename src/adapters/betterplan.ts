// Betterplan source adapter: OAuth (rotating refresh token) → gRPC-web ListMe + GetPatrimony →
// reconcile + parse into one balance FetchResult per goal. Balance-only, no transactions.
// Protocol + field map in docs/betterplan-api.md; auth in betterplan-auth.ts; the fail-closed
// reconciliation in betterplan-payload.ts.

import { fromBinary } from "@bufbuild/protobuf";
import type { BetterplanConnectionConfig } from "../config.ts";
import { todayInSantiago } from "../core/dates.ts";
import { AuthError, SchemaDriftError } from "../core/errors.ts";
import type { FetchResult } from "../core/model.ts";
import { CURRENCY_EXPONENT, isCurrencyCode } from "../core/money.ts";
import { ListGoalResponseSchema } from "./betterplan/gen/betterplan_pb.ts";
import { type AuthDeps, resolveAccessToken, type TokenStore } from "./betterplan-auth.ts";
import { grpcInvoke } from "./betterplan-grpc.ts";
import { parseBetterplanPayload } from "./betterplan-payload.ts";
import { persistRawBytes } from "./raw-payload.ts";

const LIST_ME = "portal_goal.PortalGoalGrpcService/ListMe";
const GET_PATRIMONY = "portal_goal.PortalGoalGrpcService/GetPatrimonyByFinancialEntity";
const EMPTY = new Uint8Array(0);

export interface BetterplanHooks {
  onProgress?: (step: string) => void;
  /** Present for signature parity with other adapters; betterplan never waits on an approval. */
  onTwoFactorWait?: () => void;
}

/**
 * Authenticate and return a `call(method)` that invokes a no-arg gRPC-web method, refreshing the
 * access token once (shared across concurrent calls) if the cached one is rejected mid-run.
 */
async function connect(
  connection: BetterplanConnectionConfig,
  store: TokenStore,
  hooks: BetterplanHooks,
  fetchImpl: typeof fetch,
): Promise<(method: string) => Promise<Uint8Array>> {
  const envSeed = process.env[connection.refresh_token_env];
  const authDeps: AuthDeps = {
    envSeed,
    fetchImpl,
    ...(hooks.onProgress ? { log: hooks.onProgress } : {}),
  };
  hooks.onProgress?.("authenticating");
  let accessToken = await resolveAccessToken(store, authDeps);
  let forceRefresh: Promise<string> | null = null;

  return async (method) => {
    try {
      return await grpcInvoke(method, EMPTY, { accessToken, fetchImpl });
    } catch (err) {
      if (!(err instanceof AuthError)) throw err;
      // Cached token was rejected — force one shared refresh, then retry this call once.
      forceRefresh ??= resolveAccessToken(store, authDeps, { force: true });
      accessToken = await forceRefresh;
      return grpcInvoke(method, EMPTY, { accessToken, fetchImpl });
    }
  };
}

/**
 * Fetch balances for a Betterplan connection: one balance FetchResult per goal, keyed
 * "investment:<goalId>". Throws classified SyncErrors; persists raw response bytes on drift.
 */
export async function fetchBetterplanConnection(
  connection: BetterplanConnectionConfig,
  store: TokenStore,
  hooks: BetterplanHooks = {},
  fetchImpl: typeof fetch = fetch,
): Promise<Map<string, FetchResult>> {
  const call = await connect(connection, store, hooks, fetchImpl);
  hooks.onProgress?.("fetching goals");
  const [listMe, patrimony] = await Promise.all([call(LIST_ME), call(GET_PATRIMONY)]);

  try {
    return parseBetterplanPayload(listMe, patrimony, todayInSantiago(), new Date().toISOString());
  } catch (err) {
    if (err instanceof SchemaDriftError) {
      const path = await persistRawBytes("betterplan", { listme: listMe, patrimony });
      throw new SchemaDriftError(`${err.message} (raw payload: ${path})`, path, err);
    }
    throw err;
  }
}

export interface BetterplanGoalSummary {
  readonly id: number;
  readonly title: string;
  readonly currencyCode: string;
  readonly balance: string;
  readonly archived: boolean;
  readonly hidden: boolean;
}

/**
 * List all goals for a connection (id, title, currency, balance) for the `betterplan-goals`
 * discovery command — no reconciliation, no LM writes; just enough to fill match.sub in config.
 */
export async function listBetterplanGoals(
  connection: BetterplanConnectionConfig,
  store: TokenStore,
  hooks: BetterplanHooks = {},
  fetchImpl: typeof fetch = fetch,
): Promise<BetterplanGoalSummary[]> {
  const call = await connect(connection, store, hooks, fetchImpl);
  hooks.onProgress?.("fetching goals");
  const goals = fromBinary(ListGoalResponseSchema, await call(LIST_ME)).values;
  return goals.map((g) => {
    const code = g.currency?.currencyCode ?? "?";
    const balance = isCurrencyCode(code)
      ? g.currentCapital.toFixed(CURRENCY_EXPONENT[code])
      : String(g.currentCapital);
    return {
      id: g.id,
      title: g.title,
      currencyCode: code,
      balance,
      archived: g.archived,
      hidden: g.hidden,
    };
  });
}
