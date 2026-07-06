// Santander token manager: fully offline. The browser harvester and HTTP fetch are both
// injected, so every path (cache fast-path, HTTP refresh, fail-soft fallback to harvest,
// creds-rotation re-bootstrap, exclusive-lock re-check) is exercised without a network or a
// real browser.
import { describe, expect, test } from "bun:test";
import {
  accessTokenExpiry,
  type BrowserHarvester,
  credsFingerprint,
  type HarvestedToken,
  resolveAccessToken,
  type SantanderAuthDeps,
} from "../src/adapters/santander/auth.ts";
import type { TokenStore } from "../src/adapters/betterplan-auth.ts";
import { AuthError, SourceUnavailableError, TwoFactorTimeoutError } from "../src/core/errors.ts";
import type { ConnectionSecret } from "../src/state/repo.ts";

const MINUTE = 60_000;
const HOUR = 3_600_000;
const FP = credsFingerprint("0012345678", "hunter2");

/** A minimal unsigned JWT carrying only an `exp` claim, `deltaMs` from now. */
function jwt(deltaMs: number): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const exp = Math.floor((Date.now() + deltaMs) / 1000);
  const payload = Buffer.from(JSON.stringify({ exp, sub: "test" })).toString("base64url");
  return `${header}.${payload}.sig`;
}

interface FakeStore extends TokenStore {
  value: ConnectionSecret | null;
  sets: ConnectionSecret[];
  locks: number;
}

function makeStore(initial: ConnectionSecret | null): FakeStore {
  const store: FakeStore = {
    value: initial,
    sets: [],
    locks: 0,
    get: () => store.value,
    set: (s) => {
      store.value = s;
      store.sets.push(s);
    },
    withLock: (fn) => {
      store.locks++;
      return fn();
    },
  };
  return store;
}

interface FakeHarvest {
  harvest: BrowserHarvester;
  calls: number;
}

/** A harvester returning a token, or throwing a supplied error. */
function makeHarvest(result: HarvestedToken | Error): FakeHarvest {
  const state = { calls: 0 };
  const harvest = (async () => {
    state.calls++;
    if (result instanceof Error) throw result;
    return result;
  }) as BrowserHarvester;
  return {
    harvest,
    get calls() {
      return state.calls;
    },
  };
}

function harvested(accessDeltaMs: number, refreshToken: string | null = "HRT"): HarvestedToken {
  const access = jwt(accessDeltaMs);
  return { accessToken: access, refreshToken, accessTokenExpiresAt: accessTokenExpiry(access)! };
}

function makeFetch(outcomes: Array<Response | "network">) {
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

function refreshOk(accessDeltaMs = HOUR, refresh?: string): Response {
  const body: Record<string, string> = { access_token: jwt(accessDeltaMs) };
  if (refresh !== undefined) body["refresh_token"] = refresh;
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function deps(
  overrides: Partial<SantanderAuthDeps> & Pick<SantanderAuthDeps, "fetchImpl" | "harvest">,
): SantanderAuthDeps {
  return { credsFingerprint: FP, ...overrides };
}

function secret(over: Partial<ConnectionSecret>): ConnectionSecret {
  return {
    refreshToken: "SRT",
    accessToken: jwt(HOUR),
    accessTokenExpiresAt: new Date(Date.now() + HOUR).toISOString(),
    seedFingerprint: FP,
    ...over,
  };
}

describe("resolveAccessToken", () => {
  test("fast path: a fresh cached token needs no lock, no fetch, no harvest", async () => {
    const store = makeStore(secret({ accessToken: "AT_CACHED" }));
    const fetch = makeFetch([]);
    const harvest = makeHarvest(harvested(HOUR));
    const token = await resolveAccessToken(
      store,
      deps({ fetchImpl: fetch.fetchImpl, harvest: harvest.harvest }),
    );
    expect(token).toBe("AT_CACHED");
    expect(store.locks).toBe(0);
    expect(fetch.calls).toBe(0);
    expect(harvest.calls).toBe(0);
  });

  test("first run (no row) harvests via browser and persists before returning", async () => {
    const store = makeStore(null);
    const fetch = makeFetch([]);
    const token = harvested(HOUR, "HRT1");
    const harvest = makeHarvest(token);
    const got = await resolveAccessToken(
      store,
      deps({ fetchImpl: fetch.fetchImpl, harvest: harvest.harvest }),
    );
    expect(got).toBe(token.accessToken);
    expect(harvest.calls).toBe(1);
    expect(fetch.calls).toBe(0); // no refresh token to try
    expect(store.locks).toBe(1);
    expect(store.sets).toHaveLength(1);
    expect(store.value?.refreshToken).toBe("HRT1");
    expect(store.value?.seedFingerprint).toBe(FP);
  });

  test("stale token with a usable refresh: HTTP refresh succeeds, no browser", async () => {
    const store = makeStore(
      secret({ accessTokenExpiresAt: new Date(Date.now() - MINUTE).toISOString() }),
    );
    const fetch = makeFetch([refreshOk(HOUR, "ROTATED")]);
    const harvest = makeHarvest(harvested(HOUR));
    const token = await resolveAccessToken(
      store,
      deps({ fetchImpl: fetch.fetchImpl, harvest: harvest.harvest }),
    );
    expect(fetch.calls).toBe(1);
    expect(harvest.calls).toBe(0);
    expect(token).toBe(store.value?.accessToken ?? "");
    expect(store.value?.refreshToken).toBe("ROTATED");
  });

  test("refresh that omits a new refresh_token keeps the presented one", async () => {
    const store = makeStore(
      secret({
        refreshToken: "KEEP",
        accessTokenExpiresAt: new Date(Date.now() - MINUTE).toISOString(),
      }),
    );
    const fetch = makeFetch([refreshOk(HOUR)]); // no refresh_token in body
    const harvest = makeHarvest(harvested(HOUR));
    await resolveAccessToken(store, deps({ fetchImpl: fetch.fetchImpl, harvest: harvest.harvest }));
    expect(store.value?.refreshToken).toBe("KEEP");
    expect(harvest.calls).toBe(0);
  });

  test("refresh rejected (400/invalid grant) falls back to a browser harvest", async () => {
    const store = makeStore(
      secret({ accessTokenExpiresAt: new Date(Date.now() - MINUTE).toISOString() }),
    );
    const fetch = makeFetch([new Response("{}", { status: 400 })]);
    const token = harvested(HOUR, "HRT2");
    const harvest = makeHarvest(token);
    const logs: string[] = [];
    const got = await resolveAccessToken(
      store,
      deps({ fetchImpl: fetch.fetchImpl, harvest: harvest.harvest, log: (m) => logs.push(m) }),
    );
    expect(fetch.calls).toBe(1);
    expect(harvest.calls).toBe(1);
    expect(got).toBe(token.accessToken);
    expect(store.value?.refreshToken).toBe("HRT2");
    expect(logs.some((l) => /HTTP refresh unavailable/.test(l))).toBe(true);
  });

  test("refresh network error also falls back to a harvest (never fatal)", async () => {
    const store = makeStore(
      secret({ accessTokenExpiresAt: new Date(Date.now() - MINUTE).toISOString() }),
    );
    const fetch = makeFetch(["network"]);
    const harvest = makeHarvest(harvested(HOUR));
    await resolveAccessToken(store, deps({ fetchImpl: fetch.fetchImpl, harvest: harvest.harvest }));
    expect(harvest.calls).toBe(1);
  });

  test("creds fingerprint mismatch abandons the stored chain and harvests", async () => {
    const store = makeStore(secret({ seedFingerprint: "OLD_FP" }));
    const fetch = makeFetch([refreshOk()]);
    const token = harvested(HOUR, "HRT3");
    const harvest = makeHarvest(token);
    const got = await resolveAccessToken(
      store,
      deps({ fetchImpl: fetch.fetchImpl, harvest: harvest.harvest }),
    );
    // The stored token is fresh but was minted under other creds → not trusted.
    expect(fetch.calls).toBe(0); // stored refresh not usable under new creds
    expect(harvest.calls).toBe(1);
    expect(got).toBe(token.accessToken);
    expect(store.value?.seedFingerprint).toBe(FP);
  });

  test("force bypasses a fresh cache and refreshes", async () => {
    const store = makeStore(secret({ accessToken: "AT_FRESH" }));
    const fetch = makeFetch([refreshOk(HOUR, "R2")]);
    const harvest = makeHarvest(harvested(HOUR));
    const token = await resolveAccessToken(
      store,
      deps({ fetchImpl: fetch.fetchImpl, harvest: harvest.harvest }),
      { force: true },
    );
    expect(store.locks).toBe(1);
    expect(fetch.calls).toBe(1);
    expect(token).not.toBe("AT_FRESH");
  });

  test("a harvested null refresh_token stores as no-usable-refresh (next stale run re-harvests)", async () => {
    const store = makeStore(null);
    const fetch = makeFetch([refreshOk()]);
    const harvest = makeHarvest(harvested(-MINUTE, null)); // already-stale access, no refresh
    await resolveAccessToken(store, deps({ fetchImpl: fetch.fetchImpl, harvest: harvest.harvest }));
    expect(store.value?.refreshToken).toBe("");

    // Second call: token is stale and there is no usable refresh → straight to harvest.
    const harvest2 = makeHarvest(harvested(HOUR, null));
    await resolveAccessToken(
      store,
      deps({ fetchImpl: fetch.fetchImpl, harvest: harvest2.harvest }),
    );
    expect(fetch.calls).toBe(0);
    expect(harvest2.calls).toBe(1);
  });

  test("harvest failures propagate with their taxonomy (engine failover applies)", async () => {
    const store = makeStore(null);
    const fetch = makeFetch([]);
    for (const err of [
      new AuthError("clave incorrecta"),
      new TwoFactorTimeoutError("2fa timeout"),
      new SourceUnavailableError("site down"),
    ]) {
      const harvest = makeHarvest(err);
      expect(
        resolveAccessToken(store, deps({ fetchImpl: fetch.fetchImpl, harvest: harvest.harvest })),
      ).rejects.toThrow(err.constructor as new (...args: never[]) => Error);
    }
  });

  test("persist happens before the token is returned (crash-safe cache)", async () => {
    const store = makeStore(null);
    const fetch = makeFetch([]);
    const token = harvested(HOUR);
    let setBeforeReturn = false;
    const harvest = (async () => {
      // At harvest time nothing is persisted yet.
      expect(store.sets).toHaveLength(0);
      return token;
    }) as BrowserHarvester;
    const got = await resolveAccessToken(store, deps({ fetchImpl: fetch.fetchImpl, harvest }));
    setBeforeReturn = store.sets.length === 1;
    expect(setBeforeReturn).toBe(true);
    expect(got).toBe(token.accessToken);
  });
});

describe("accessTokenExpiry", () => {
  test("decodes a JWT exp claim to ISO", () => {
    const exp = Math.floor((Date.now() + HOUR) / 1000);
    const payload = Buffer.from(JSON.stringify({ exp })).toString("base64url");
    expect(accessTokenExpiry(`h.${payload}.s`)).toBe(new Date(exp * 1000).toISOString());
  });

  test("returns null for a non-JWT or an exp-less token", () => {
    expect(accessTokenExpiry("not-a-jwt")).toBeNull();
    expect(accessTokenExpiry("a.b")).toBeNull();
    const noExp = Buffer.from(JSON.stringify({ sub: "x" })).toString("base64url");
    expect(accessTokenExpiry(`h.${noExp}.s`)).toBeNull();
    const badExp = Buffer.from(JSON.stringify({ exp: "soon" })).toString("base64url");
    expect(accessTokenExpiry(`h.${badExp}.s`)).toBeNull();
  });
});

describe("credsFingerprint", () => {
  test("is stable per creds and changes when either field changes", () => {
    expect(credsFingerprint("rut", "pass")).toBe(credsFingerprint("rut", "pass"));
    expect(credsFingerprint("rut", "pass")).not.toBe(credsFingerprint("rut", "pass2"));
    expect(credsFingerprint("rut", "pass")).not.toBe(credsFingerprint("rut2", "pass"));
  });
});
