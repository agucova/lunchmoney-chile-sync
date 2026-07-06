import { describe, expect, test } from "bun:test";
import {
  type AuthDeps,
  resolveAccessToken,
  type TokenStore,
} from "../src/adapters/betterplan-auth.ts";
import { AuthError, SourceUnavailableError } from "../src/core/errors.ts";
import type { ConnectionSecret } from "../src/state/repo.ts";

const HOUR = 3_600_000;
const DAY = 86_400_000;

function iso(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

interface FakeStore extends TokenStore {
  value: ConnectionSecret | null;
  sets: number;
}

function makeStore(initial: ConnectionSecret | null): FakeStore {
  const store: FakeStore = {
    value: initial,
    sets: 0,
    get: () => store.value,
    set: (s) => {
      store.value = s;
      store.sets++;
    },
    withLock: (fn) => fn(),
  };
  return store;
}

interface FakeFetch {
  fetchImpl: typeof fetch;
  calls: number;
}

function makeFetch(outcomes: Array<Response | "network">): FakeFetch {
  const state = { calls: 0 };
  const fetchImpl = (async () => {
    const outcome = outcomes[Math.min(state.calls, outcomes.length - 1)];
    state.calls++;
    if (outcome === "network") throw new TypeError("network down");
    return outcome as Response;
  }) as unknown as typeof fetch;
  return {
    fetchImpl,
    get calls() {
      return state.calls;
    },
  };
}

function tokenOk(refresh = "RT2", access = "AT2"): Response {
  return new Response(
    JSON.stringify({ access_token: access, refresh_token: refresh, expires_in: 2592000 }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function deps(fetchImpl: typeof fetch, envSeed: string | undefined): AuthDeps {
  return { envSeed, fetchImpl };
}

describe("resolveAccessToken", () => {
  test("first run (no row) refreshes from the env seed and persists the rotated token", async () => {
    const store = makeStore(null);
    const fetch = makeFetch([tokenOk("RT2", "AT2")]);
    const token = await resolveAccessToken(store, deps(fetch.fetchImpl, "SEED_RT"));
    expect(token).toBe("AT2");
    expect(fetch.calls).toBe(1);
    // persisted before returning: the rotated refresh token + access token are in the store
    expect(store.value?.refreshToken).toBe("RT2");
    expect(store.value?.accessToken).toBe("AT2");
    expect(store.sets).toBe(1);
  });

  test("fresh cached access token → returned with no token call", async () => {
    const store = makeStore({
      refreshToken: "RT1",
      accessToken: "AT1",
      accessTokenExpiresAt: iso(10 * DAY),
      seedFingerprint: null,
    });
    const fetch = makeFetch([tokenOk()]);
    const token = await resolveAccessToken(store, deps(fetch.fetchImpl, undefined));
    expect(token).toBe("AT1");
    expect(fetch.calls).toBe(0);
    expect(store.sets).toBe(0);
  });

  test("near-expiry cached token → refreshes", async () => {
    const store = makeStore({
      refreshToken: "RT1",
      accessToken: "AT1",
      accessTokenExpiresAt: iso(HOUR), // inside the 24h skew
      seedFingerprint: null,
    });
    const fetch = makeFetch([tokenOk("RT2", "AT2")]);
    const token = await resolveAccessToken(store, deps(fetch.fetchImpl, undefined));
    expect(token).toBe("AT2");
    expect(fetch.calls).toBe(1);
    expect(store.value?.refreshToken).toBe("RT2");
  });

  test("refresh response missing a rotated refresh token → AuthError, store untouched", async () => {
    const store = makeStore({
      refreshToken: "RT1",
      accessToken: null,
      accessTokenExpiresAt: null,
      seedFingerprint: null,
    });
    const fetch = makeFetch([
      new Response(JSON.stringify({ access_token: "AT2", expires_in: 2592000 }), { status: 200 }),
    ]);
    await expect(
      resolveAccessToken(store, deps(fetch.fetchImpl, undefined)),
    ).rejects.toBeInstanceOf(AuthError);
    expect(store.sets).toBe(0);
  });

  test("invalid_grant → AuthError (dead chain, re-bootstrap)", async () => {
    const store = makeStore({
      refreshToken: "RT_DEAD",
      accessToken: null,
      accessTokenExpiresAt: null,
      seedFingerprint: null,
    });
    const fetch = makeFetch([
      new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }),
    ]);
    await expect(
      resolveAccessToken(store, deps(fetch.fetchImpl, undefined)),
    ).rejects.toBeInstanceOf(AuthError);
  });

  test("network error on the token POST is NOT retried → SourceUnavailable, one call", async () => {
    const store = makeStore({
      refreshToken: "RT1",
      accessToken: null,
      accessTokenExpiresAt: null,
      seedFingerprint: null,
    });
    const fetch = makeFetch(["network"]);
    await expect(
      resolveAccessToken(store, deps(fetch.fetchImpl, undefined)),
    ).rejects.toBeInstanceOf(SourceUnavailableError);
    expect(fetch.calls).toBe(1);
  });

  test("changed env seed (fingerprint mismatch) re-bootstraps from env even with a fresh cached token", async () => {
    // A cached, still-fresh token whose fingerprint belongs to an OLD seed.
    const store = makeStore({
      refreshToken: "RT_OLD",
      accessToken: "AT_OLD",
      accessTokenExpiresAt: iso(10 * DAY),
      seedFingerprint: "old-fingerprint",
    });
    const fetch = makeFetch([tokenOk("RT_NEW", "AT_NEW")]);
    const token = await resolveAccessToken(store, deps(fetch.fetchImpl, "BRAND_NEW_SEED"));
    expect(token).toBe("AT_NEW");
    expect(fetch.calls).toBe(1);
    expect(store.value?.refreshToken).toBe("RT_NEW");
  });
});
