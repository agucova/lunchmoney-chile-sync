// Santander adapter + client tests with an injected fetch — no network. Cover request
// construction (the exact bodies/headers the bank's API expects), sub-account fan-out,
// balance facets, error classification, and adapter-level drift guards.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { fetchSantanderData } from "../src/adapters/santander/index.ts";
import { formatRutCliente, SantanderClient } from "../src/adapters/santander/client.ts";
import { assertIsoDate } from "../src/core/dates.ts";
import {
  AuthError,
  InvariantViolation,
  SchemaDriftError,
  SourceUnavailableError,
} from "../src/core/errors.ts";
import fixtures from "./fixtures/santander-http.json";

const TODAY = assertIsoDate("2026-07-06");
const CREDENTIALS = { accessToken: "test-token", rutCliente: "00012345678" };

beforeAll(() => {
  // Keep the drift-payload persistence out of the repo's fixtures/raw during tests.
  process.env["SYNC_DRIFT_DIR"] = `${process.env["TMPDIR"] ?? "/tmp"}/santander-test-drift`;
});

afterAll(() => {
  delete process.env["SYNC_DRIFT_DIR"];
});

interface RecordedCall {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** Fetch stub speaking the fixture set, recording every call for request assertions. */
function makeFetch(inventory: unknown = fixtures.inventory, billedResponse?: unknown | "error") {
  const calls: RecordedCall[] = [];
  const impl = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === "string" ? input : input.toString();
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string>, body });

    const json = (payload: unknown) => new Response(JSON.stringify(payload), { status: 200 });
    if (url.includes("cruceProductosOnline")) return json(inventory);
    if (url.includes("current-accounts/transactions")) {
      if (body["currency"] === "USD") return json(fixtures.checkingNoData);
      // Only the real CLP checking account has movements; anything else is empty.
      return json(
        body["accountId"] === "0123000012345678"
          ? fixtures.checkingWithMovements
          : fixtures.checkingEmptyOk,
      );
    }
    if (url.includes("consultaUltimosMovimientos")) {
      const entrada = body["Entrada"] as Record<string, unknown>;
      return json(entrada["Moneda"] === "USD" ? fixtures.cardUsd : fixtures.cardClp);
    }
    if (url.includes("cuentasDisponibles")) return json(fixtures.cardStatements);
    if (url.includes("estadoCuentaNacional")) {
      if (billedResponse === "error") return new Response("nope", { status: 503 });
      return json(billedResponse ?? fixtures.billedStatement);
    }
    // USD statement (estadoDeCuenta) → PDF path. Return 503 so the adapter degrades to
    // USD-unbilled-only without needing pdftotext in the unit test (the PDF parse is covered
    // by santander-usd-statement.test.ts + validated live).
    if (url.includes("estadoDeCuenta")) return new Response("pdf unavailable", { status: 503 });
    throw new Error(`unexpected fetch url: ${url}`);
  }) as typeof fetch;
  return { impl, calls };
}

describe("formatRutCliente", () => {
  test("normalizes separator styles to the 11-char zero-padded form", () => {
    expect(formatRutCliente("12.345.678-9")).toBe("00123456789");
    expect(formatRutCliente("12345678-9")).toBe("00123456789");
    expect(formatRutCliente("12345678-k")).toBe("0012345678K");
  });

  test("rejects implausible RUTs as our config error", () => {
    expect(() => formatRutCliente("not-a-rut")).toThrow(InvariantViolation);
    expect(() => formatRutCliente("123")).toThrow(InvariantViolation);
  });
});

describe("SantanderClient error classification", () => {
  const client = (status: number, body = "{}") =>
    new SantanderClient(
      CREDENTIALS,
      (async () => new Response(body, { status })) as unknown as typeof fetch,
    );

  test("401/403 → AuthError (token manager must re-harvest)", async () => {
    expect(client(401).fetchInventory()).rejects.toThrow(AuthError);
    expect(client(403).fetchInventory()).rejects.toThrow(AuthError);
  });

  test("5xx → SourceUnavailableError", async () => {
    expect(client(503).fetchInventory()).rejects.toThrow(SourceUnavailableError);
  });

  test("200 with a non-JSON body → SchemaDriftError", async () => {
    expect(client(200, "<html>maintenance</html>").fetchInventory()).rejects.toThrow(
      SchemaDriftError,
    );
  });

  test("network failure → SourceUnavailableError", async () => {
    const failing = new SantanderClient(CREDENTIALS, (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch);
    expect(failing.fetchInventory()).rejects.toThrow(SourceUnavailableError);
  });
});

describe("fetchSantanderData", () => {
  test("fans out into the four mapped sub-accounts with exact facets", async () => {
    const { impl, calls } = makeFetch();
    const progress: string[] = [];
    const results = await fetchSantanderData(
      CREDENTIALS,
      { onProgress: (step) => progress.push(step) },
      { fetchImpl: impl, today: TODAY },
    );

    expect([...results.keys()].sort()).toEqual([
      "checking:CLP",
      "checking:USD",
      "credit_card:CLP",
      "credit_card:USD",
    ]);

    const checkingClp = results.get("checking:CLP");
    expect(checkingClp?.facets.transactions).toHaveLength(3);
    expect(checkingClp?.facets.balance?.amount.minor).toBe(5324985n);
    expect(checkingClp?.coverage.posted).toEqual({
      from: assertIsoDate("2026-05-07"), // today − 60d
      to: TODAY,
    });
    expect(checkingClp?.sourceMeta.source).toBe("santander");

    // The dormant USD account: NO EXISTEN DATOS still yields a balance reading.
    const checkingUsd = results.get("checking:USD");
    expect(checkingUsd?.facets.transactions).toEqual([]);
    expect(checkingUsd?.facets.balance?.amount.minor).toBe(264335n);
    expect(checkingUsd?.facets.balance?.amount.currency).toBe("USD");

    // Card legs: unbilled txns + owed balance; NO unbilled coverage until the billed
    // feeds land (suppresses false vanish flags at statement close).
    // CLP card: 3 unbilled (últimos movimientos) + 3 billed (latest statement) = 6.
    const cardClp = results.get("credit_card:CLP");
    expect(cardClp?.facets.transactions).toHaveLength(6);
    const clpStatuses = new Set(cardClp?.facets.transactions?.map((t) => t.status));
    expect(clpStatuses).toEqual(new Set(["unbilled", "billed"]));
    expect(cardClp?.facets.balance?.amount.minor).toBe(2919265n);
    // Billed coverage is declared (from the statement window); unbilled is not.
    expect(cardClp?.coverage.billed).toBeDefined();
    expect(cardClp?.coverage.unbilled).toBeUndefined();

    // USD card: the USD billed statement (estadoDeCuenta PDF) was ATTEMPTED but returns 503
    // in this stub, so the leg degrades to unbilled-only — no regression.
    const cardUsd = results.get("credit_card:USD");
    expect(calls.some((c) => c.url.includes("estadoDeCuenta"))).toBe(true);
    expect(cardUsd?.facets.transactions).toHaveLength(2);
    expect(cardUsd?.facets.transactions?.every((t) => t.status === "unbilled")).toBe(true);
    expect(cardUsd?.coverage).toEqual({});
    expect(cardUsd?.facets.balance?.amount.minor).toBe(435665n);

    // The structured billed statement (estadoCuentaNacional) is fetched for the CLP leg only.
    const billedCalls = calls.filter((c) => c.url.includes("estadoCuentaNacional"));
    expect(billedCalls).toHaveLength(1);
    const billedCall = billedCalls[0];
    if (!billedCall) throw new Error("billed call missing");
    expect((billedCall.body["INPUT"] as Record<string, unknown>)["NumExtracto"]).toBe("025");

    // The credit line is reported, not silently dropped.
    expect(progress.some((step) => step.includes("línea de crédito"))).toBe(true);

    // Request construction: checking accountId = office + contract, window = 60 days.
    const checkingCall = calls.find((c) => c.url.includes("current-accounts/transactions"));
    expect(checkingCall?.body["accountId"]).toBe("0123000012345678");
    expect(checkingCall?.body["openingDate"]).toBe("2026-05-07");
    expect(checkingCall?.body["closingDate"]).toBe("2026-07-06");
    expect(checkingCall?.headers["X-Client-Code"]).toBe("STD-PER-FPP");
    expect(checkingCall?.headers["x-schema-id"]).toBe("GHOBP");

    // Card request: fixed entity, office as Centro, contract as Cuenta, per-leg Moneda.
    const cardCalls = calls.filter((c) => c.url.includes("consultaUltimosMovimientos"));
    expect(cardCalls.map((c) => (c.body["Entrada"] as Record<string, unknown>)["Moneda"])).toEqual([
      "CLP",
      "USD",
    ]);
    for (const call of cardCalls) {
      const entrada = call.body["Entrada"] as Record<string, unknown>;
      expect(entrada["Entidad"]).toBe("0035");
      expect(entrada["Centro"]).toBe("0123");
      expect(entrada["Cuenta"]).toBe("000098765432");
      expect((call.body["Cabecera"] as Record<string, unknown>)["RutCliente"]).toBe("00012345678");
    }

    // Every call authenticates with the bearer token + static app key.
    for (const call of calls) {
      expect(call.headers["Authorization"]).toBe("Bearer test-token");
      expect(call.headers["X-Santander-Client-Id"]).toBeString();
    }
  });

  test("two products resolving to the same sub-account key is SchemaDrift", async () => {
    const inventory = structuredClone(fixtures.inventory);
    const line = inventory.DATA.OUTPUT.MATRICES.MATRIZCAPTACIONES.e1[1];
    if (!line) throw new Error("fixture shape");
    line.AGRUPACIONCOMERCIAL = "CCC"; // second CLP checking → collides with checking:CLP
    const { impl } = makeFetch(inventory);
    expect(fetchSantanderData(CREDENTIALS, {}, { fetchImpl: impl, today: TODAY })).rejects.toThrow(
      SchemaDriftError,
    );
  });

  test("a card leg in an unobserved currency is SchemaDrift", async () => {
    const inventory = structuredClone(fixtures.inventory);
    const leg = inventory.DATA.OUTPUT.MATRICES.MATRIZCAPTACIONES.e1[4];
    if (!leg) throw new Error("fixture shape");
    leg.CODIGOMONEDA = "EUR"; // known currency, unobserved as a card leg
    const { impl } = makeFetch(inventory);
    expect(fetchSantanderData(CREDENTIALS, {}, { fetchImpl: impl, today: TODAY })).rejects.toThrow(
      SchemaDriftError,
    );
  });

  test("billedStatements > 1 backfills multiple CLP statements (each fetched + merged)", async () => {
    const { impl, calls } = makeFetch();
    const results = await fetchSantanderData(
      CREDENTIALS,
      {},
      { fetchImpl: impl, today: TODAY, billedStatements: 2 },
    );
    // Fixture cardStatements has two CLP statements (025, 024) → both fetched.
    const billedCalls = calls.filter((c) => c.url.includes("estadoCuentaNacional"));
    expect(billedCalls).toHaveLength(2);
    expect(
      billedCalls.map((c) => (c.body["INPUT"] as Record<string, unknown>)["NumExtracto"]),
    ).toEqual(["025", "024"]);
    // 3 unbilled + 3 billed × 2 statements = 9 CLP card transactions.
    const cardClp = results.get("credit_card:CLP");
    expect(cardClp?.facets.transactions).toHaveLength(9);
  });

  test("a failing billed statement degrades to unbilled-only (no regression, card still syncs)", async () => {
    const { impl } = makeFetch(fixtures.inventory, "error"); // estadoCuentaNacional → HTTP 503
    const results = await fetchSantanderData(CREDENTIALS, {}, { fetchImpl: impl, today: TODAY });
    const cardClp = results.get("credit_card:CLP");
    expect(cardClp?.facets.transactions).toHaveLength(3); // unbilled only
    expect(cardClp?.facets.transactions?.every((t) => t.status === "unbilled")).toBe(true);
    expect(cardClp?.coverage).toEqual({});
    // The rest of the connection is unaffected.
    expect([...results.keys()].sort()).toEqual([
      "checking:CLP",
      "checking:USD",
      "credit_card:CLP",
      "credit_card:USD",
    ]);
  });
});
