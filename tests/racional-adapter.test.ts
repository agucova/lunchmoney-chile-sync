// Racional adapter tests with an injected fetch — no network. Cover the auth flow, the MFA
// gate, error classification, the single retry, and the fail-closed drift path.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { RacionalConnectionConfig } from "../src/config.ts";
import {
  AuthError,
  SchemaDriftError,
  SourceUnavailableError,
  TwoFactorTimeoutError,
} from "../src/core/errors.ts";
import { fetchRacionalConnection } from "../src/adapters/racional.ts";
import racionalFixture from "./fixtures/racional.json";

const CONNECTION: RacionalConnectionConfig = {
  type: "racional",
  email_env: "TEST_RACIONAL_EMAIL",
  password_env: "TEST_RACIONAL_PASS",
  device_id_env: "TEST_RACIONAL_DEVICE_ID",
};

beforeAll(() => {
  process.env["TEST_RACIONAL_EMAIL"] = "test@example.com";
  process.env["TEST_RACIONAL_PASS"] = "hunter2";
  process.env["TEST_RACIONAL_DEVICE_ID"] = "device-uuid";
  // Keep the drift-payload persistence out of the repo's fixtures/raw during tests.
  process.env["SYNC_DRIFT_DIR"] = `${process.env["TMPDIR"] ?? "/tmp"}/racional-test-drift`;
});

afterAll(() => {
  delete process.env["TEST_RACIONAL_EMAIL"];
  delete process.env["TEST_RACIONAL_PASS"];
  delete process.env["TEST_RACIONAL_DEVICE_ID"];
  delete process.env["SYNC_DRIFT_DIR"];
});

type Outcome = { status: number; body: unknown } | "network";
type Route = "mfa" | "verify" | "positions" | "buyingPower";

function routeOf(url: string): Route {
  if (url.includes("authMfaStart")) return "mfa";
  if (url.includes("verifyPassword")) return "verify";
  if (url.endsWith("/positions/buying-power")) return "buyingPower";
  if (url.endsWith("/positions")) return "positions";
  throw new Error(`unexpected fetch url: ${url}`);
}

/** Build a fetch stub. Each route is a sequence consumed per call (last entry repeats). */
function makeFetch(routes: Partial<Record<Route, Outcome[]>>) {
  const calls: Record<Route, Array<{ headers: Record<string, string> }>> = {
    mfa: [],
    verify: [],
    positions: [],
    buyingPower: [],
  };
  const impl = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === "string" ? input : input.toString();
    const route = routeOf(url);
    const idx = calls[route].length;
    calls[route].push({ headers: (init?.headers ?? {}) as Record<string, string> });
    const seq = routes[route];
    const outcome = seq?.[Math.min(idx, seq.length - 1)];
    if (!outcome) throw new Error(`no route configured for ${route}`);
    if (outcome === "network") throw new TypeError("network down");
    return new Response(JSON.stringify(outcome.body), {
      status: outcome.status,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const okMfa: Outcome = {
  status: 200,
  body: { success: true, showMfaModal: false, statusCode: 200 },
};
const okVerify: Outcome = {
  status: 200,
  body: { idToken: "tok_123", refreshToken: "r", expiresIn: "3600" },
};
// Stamp pricing to "yesterday" relative to the run, mirroring a live fetch — otherwise the
// fixture's fixed date eventually crosses the adapter's 7-day staleness guard and these
// (staleness-agnostic) tests rot. The guard itself is covered in racional-payload.test.ts
// with explicit past/future dates.
const recentlyPricedPositions = racionalFixture.positions.map((p) => ({
  ...p,
  lastUpdated: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
}));
const okPositions: Outcome = { status: 200, body: recentlyPricedPositions };
const okBuyingPower: Outcome = { status: 200, body: racionalFixture.buyingPower };

describe("racional adapter", () => {
  test("happy path: signs in, reads both endpoints, returns balances", async () => {
    const { impl, calls } = makeFetch({
      mfa: [okMfa],
      verify: [okVerify],
      positions: [okPositions],
      buyingPower: [okBuyingPower],
    });

    const results = await fetchRacionalConnection(CONNECTION, {}, impl);
    expect([...results.keys()].sort()).toEqual(["cash", "investment", "investment:stocks"]);
    expect(results.get("investment:stocks")?.facets.balance?.amount.minor).toBe(338408n);
    expect(results.get("cash")?.facets.balance?.amount.minor).toBe(250000n);

    // Exactly one sign-in; data reads carry the Bearer token; NotifySuccessfulLogin untouched.
    expect(calls.mfa).toHaveLength(1);
    expect(calls.verify).toHaveLength(1);
    expect(calls.positions[0]?.headers["Authorization"]).toBe("Bearer tok_123");
    expect(calls.buyingPower[0]?.headers["Authorization"]).toBe("Bearer tok_123");
  });

  test("untrusted device (showMfaModal) is a two-factor failure, no sign-in attempt", async () => {
    const { impl, calls } = makeFetch({
      mfa: [{ status: 200, body: { success: true, showMfaModal: true } }],
    });
    await expect(fetchRacionalConnection(CONNECTION, {}, impl)).rejects.toBeInstanceOf(
      TwoFactorTimeoutError,
    );
    expect(calls.verify).toHaveLength(0);
  });

  test("bad credentials → AuthError with no second password attempt", async () => {
    const { impl, calls } = makeFetch({
      mfa: [okMfa],
      verify: [{ status: 400, body: { error: { message: "INVALID_PASSWORD" } } }],
    });
    await expect(fetchRacionalConnection(CONNECTION, {}, impl)).rejects.toBeInstanceOf(AuthError);
    expect(calls.verify).toHaveLength(1); // 400 is not retried
  });

  test("a data endpoint 401 is an AuthError", async () => {
    const { impl } = makeFetch({
      mfa: [okMfa],
      verify: [okVerify],
      positions: [{ status: 401, body: { error: "unauthorized" } }],
      buyingPower: [okBuyingPower],
    });
    await expect(fetchRacionalConnection(CONNECTION, {}, impl)).rejects.toBeInstanceOf(AuthError);
  });

  test("transient 5xx is retried once and can succeed", async () => {
    const { impl, calls } = makeFetch({
      mfa: [okMfa],
      verify: [okVerify],
      positions: [{ status: 503, body: {} }, okPositions],
      buyingPower: [okBuyingPower],
    });
    const results = await fetchRacionalConnection(CONNECTION, {}, impl);
    expect(results.get("investment:stocks")?.facets.balance?.amount.minor).toBe(338408n);
    expect(calls.positions).toHaveLength(2); // retried
  });

  test("persistent 5xx → SourceUnavailableError after the retry", async () => {
    const { impl, calls } = makeFetch({
      mfa: [okMfa],
      verify: [okVerify],
      positions: [{ status: 500, body: {} }],
      buyingPower: [okBuyingPower],
    });
    await expect(fetchRacionalConnection(CONNECTION, {}, impl)).rejects.toBeInstanceOf(
      SourceUnavailableError,
    );
    expect(calls.positions).toHaveLength(2); // one retry, then gives up
  });

  test("one endpoint down (network error) fails the whole connection", async () => {
    const { impl } = makeFetch({
      mfa: [okMfa],
      verify: [okVerify],
      positions: ["network", "network"],
      buyingPower: [okBuyingPower],
    });
    await expect(fetchRacionalConnection(CONNECTION, {}, impl)).rejects.toBeInstanceOf(
      SourceUnavailableError,
    );
  });

  test("malformed positions payload → SchemaDriftError (fail closed)", async () => {
    const { impl } = makeFetch({
      mfa: [okMfa],
      verify: [okVerify],
      positions: [{ status: 200, body: [{ assetId: "AAPL" }] }], // missing required fields
      buyingPower: [okBuyingPower],
    });
    await expect(fetchRacionalConnection(CONNECTION, {}, impl)).rejects.toBeInstanceOf(
      SchemaDriftError,
    );
  });
});
