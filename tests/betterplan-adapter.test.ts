import { describe, expect, test } from "bun:test";
import { create, toBinary } from "@bufbuild/protobuf";
import {
  CurrencyModelSchema,
  FinancialEntityModelSchema,
  GetPatrimonyByFinancialEntityResponseSchema,
  GoalModelSchema,
  ListGoalResponseSchema,
  PatrimonyEntitySchema,
} from "../src/adapters/betterplan/gen/betterplan_pb.ts";
import { fetchBetterplanConnection } from "../src/adapters/betterplan.ts";
import type { TokenStore } from "../src/adapters/betterplan-auth.ts";
import { grpcInvoke } from "../src/adapters/betterplan-grpc.ts";
import type { BetterplanConnectionConfig } from "../src/config.ts";
import { AuthError, SourceUnavailableError } from "../src/core/errors.ts";
import type { ConnectionSecret } from "../src/state/repo.ts";

const CONNECTION: BetterplanConnectionConfig = {
  type: "betterplan",
  refresh_token_env: "BP_RT_UNSET_FOR_TESTS",
};

// ---------- gRPC-web frame + response builders ----------

function frame(flags: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(5 + payload.length);
  out[0] = flags;
  new DataView(out.buffer).setUint32(1, payload.length, false);
  out.set(payload, 5);
  return out;
}

function grpcResponse(message: Uint8Array, grpcStatus = 0): Response {
  const trailer = new TextEncoder().encode(`grpc-status:${grpcStatus}\r\n`);
  const msg = frame(0x00, message);
  const tr = frame(0x80, trailer);
  const body = new Uint8Array(msg.length + tr.length);
  body.set(msg, 0);
  body.set(tr, msg.length);
  return new Response(body, {
    status: 200,
    headers: { "content-type": "application/grpc-web+proto" },
  });
}

const USD = { id: 2, name: "Dólares", currencyCode: "USD" };
const CLP = { id: 1, name: "Pesos", currencyCode: "CLP" };

const LIST_BYTES = toBinary(
  ListGoalResponseSchema,
  create(ListGoalResponseSchema, {
    values: [
      create(GoalModelSchema, {
        id: 34876,
        title: "Inversiones generales 3",
        currentCapital: 12345.891,
        currency: create(CurrencyModelSchema, USD),
        financialEntity: create(FinancialEntityModelSchema, {
          id: 1,
          shortTitle: "BetterplanUS",
          uuid: "bp-us",
        }),
      }),
      create(GoalModelSchema, {
        id: 31502,
        title: "Billetera Pesos",
        currentCapital: 150000,
        currency: create(CurrencyModelSchema, CLP),
        financialEntity: create(FinancialEntityModelSchema, {
          id: 1,
          shortTitle: "Betterplan",
          uuid: "vector",
        }),
      }),
    ],
  }),
);

const PATRIMONY_BYTES = toBinary(
  GetPatrimonyByFinancialEntityResponseSchema,
  create(GetPatrimonyByFinancialEntityResponseSchema, {
    totalBalance: 0,
    totalCurrency: create(CurrencyModelSchema, CLP),
    entities: [
      create(PatrimonyEntitySchema, {
        financialEntityUuid: "bp-us",
        financialEntityName: "bp-us",
        balance: 12345.89,
        currency: create(CurrencyModelSchema, USD),
      }),
      create(PatrimonyEntitySchema, {
        financialEntityUuid: "vector",
        financialEntityName: "vector",
        balance: 150000,
        currency: create(CurrencyModelSchema, CLP),
      }),
    ],
  }),
);

function freshStore(): TokenStore {
  const secret: ConnectionSecret = {
    refreshToken: "RT1",
    accessToken: "AT1",
    accessTokenExpiresAt: new Date(Date.now() + 10 * 86_400_000).toISOString(),
    seedFingerprint: null,
  };
  let value: ConnectionSecret | null = secret;
  return {
    get: () => value,
    set: (s) => {
      value = s;
    },
    withLock: (fn) => fn(),
  };
}

function routedFetch(routes: Array<{ match: string; respond: () => Response | "network" }>): {
  fetchImpl: typeof fetch;
  calls: string[];
} {
  const calls: string[] = [];
  const fetchImpl = (async (url: string) => {
    calls.push(url);
    const route = routes.find((r) => url.includes(r.match));
    if (!route) throw new Error(`unrouted fetch: ${url}`);
    const out = route.respond();
    if (out === "network") throw new TypeError("network down");
    return out;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

// ---------- transport classification (grpcInvoke) ----------

describe("grpcInvoke classification", () => {
  const deps = (respond: () => Response | "network") => ({
    accessToken: "AT",
    fetchImpl: (async () => {
      const r = respond();
      if (r === "network") throw new TypeError("net");
      return r;
    }) as unknown as typeof fetch,
  });

  test("Cloudflare 403 HTML → SourceUnavailable, never decoded", async () => {
    await expect(
      grpcInvoke(
        "x/Y",
        new Uint8Array(0),
        deps(
          () =>
            new Response("<html>Access denied</html>", {
              status: 403,
              headers: { "content-type": "text/html" },
            }),
        ),
      ),
    ).rejects.toBeInstanceOf(SourceUnavailableError);
  });

  test("HTTP 401 → AuthError", async () => {
    await expect(
      grpcInvoke(
        "x/Y",
        new Uint8Array(0),
        deps(() => new Response("", { status: 401 })),
      ),
    ).rejects.toBeInstanceOf(AuthError);
  });

  test("trailer grpc-status 16 → AuthError", async () => {
    await expect(
      grpcInvoke(
        "x/Y",
        new Uint8Array(0),
        deps(() => grpcResponse(new Uint8Array(0), 16)),
      ),
    ).rejects.toBeInstanceOf(AuthError);
  });

  test("trailer grpc-status 14 → SourceUnavailable", async () => {
    await expect(
      grpcInvoke(
        "x/Y",
        new Uint8Array(0),
        deps(() => grpcResponse(new Uint8Array(0), 14)),
      ),
    ).rejects.toBeInstanceOf(SourceUnavailableError);
  });

  test("grpc-status 0 → returns message bytes", async () => {
    const bytes = await grpcInvoke(
      "x/Y",
      new Uint8Array(0),
      deps(() => grpcResponse(LIST_BYTES, 0)),
    );
    expect(bytes.length).toBe(LIST_BYTES.length);
  });
});

// ---------- orchestrator ----------

describe("fetchBetterplanConnection", () => {
  test("happy path → one FetchResult per goal, no token call (cached token)", async () => {
    const { fetchImpl, calls } = routedFetch([
      { match: "ListMe", respond: () => grpcResponse(LIST_BYTES) },
      { match: "GetPatrimony", respond: () => grpcResponse(PATRIMONY_BYTES) },
    ]);
    const results = await fetchBetterplanConnection(CONNECTION, freshStore(), {}, fetchImpl);
    expect(results.get("investment:34876")?.facets.balance?.amount.minor).toBe(1234589n);
    expect(results.get("investment:31502")?.facets.balance?.amount.minor).toBe(150000n);
    expect(calls.some((u) => u.includes("connect/token"))).toBe(false);
  });

  test("grpc-status 16 on a data call → one forced refresh, then retry succeeds", async () => {
    let listAttempts = 0;
    const { fetchImpl, calls } = routedFetch([
      {
        match: "ListMe",
        respond: () => {
          listAttempts++;
          return listAttempts === 1
            ? grpcResponse(new Uint8Array(0), 16)
            : grpcResponse(LIST_BYTES);
        },
      },
      { match: "GetPatrimony", respond: () => grpcResponse(PATRIMONY_BYTES) },
      {
        match: "connect/token",
        respond: () =>
          new Response(
            JSON.stringify({ access_token: "AT2", refresh_token: "RT2", expires_in: 2592000 }),
            { status: 200 },
          ),
      },
    ]);
    const results = await fetchBetterplanConnection(CONNECTION, freshStore(), {}, fetchImpl);
    expect(results.get("investment:34876")?.facets.balance?.amount.minor).toBe(1234589n);
    expect(calls.filter((u) => u.includes("connect/token")).length).toBe(1);
  });
});
