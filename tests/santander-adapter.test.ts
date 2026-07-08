// Santander adapter + client tests with an injected fetch — no network. Cover request
// construction (the exact bodies/headers the bank's API expects), sub-account fan-out,
// balance facets, error classification, and adapter-level drift guards.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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

/** ultCartolaHistorica response: a listing (CODERR 00) or "none this month" (CODERR 16). */
function cartolaListing(present: { closeDate: string; account: string } | null): unknown {
  const consulta: Record<string, unknown> = {
    INFO: {
      CODERR: present ? "00" : "16",
      DESERR: present ? "OK" : "sin datos",
      MSGUSUARIO: "",
    },
  };
  if (present) {
    consulta["OUTPUT"] = {
      Escalares: { ESTADORESULTADO: "0" },
      MATRIZ: [
        { NUMEROCARTOLA: " 42", NUMEROCUENTA: present.account, FECHADESDE: present.closeDate },
      ],
    };
  }
  return {
    METADATA: { STATUS: "0", DESCRIPCION: "OK" },
    DATA: { AS_TIB_ConsultaUltCartolaHistorica: consulta },
  };
}

/** buzonVirtual response: a base64 %PDF- wrapper (the bytes are decoded by pdftotext, stubbed). */
function cartolaPdf(): unknown {
  return {
    METADATA: { STATUS: "0", DESCRIPCION: "OK" },
    DATA: {
      OUTPUT: {
        INFO: { CODERR: "00", DESERR: "Operación exitosa." },
        FILE: Buffer.from("%PDF-1.4\nstub\n%%EOF").toString("base64"),
      },
    },
  };
}

interface CartolaStub {
  /** ultCartolaHistorica response per MESCONSULTA; default: absent (CODERR 16) every month. */
  list?: (month: string) => unknown;
  /** buzonVirtual response; "error"/"auth" force HTTP 503/401. Default: a valid PDF wrapper. */
  pdf?: unknown | "error" | "auth";
}

/** Fetch stub speaking the fixture set, recording every call for request assertions. */
function makeFetch(
  inventory: unknown = fixtures.inventory,
  billedResponse?: unknown | "error",
  cartola?: CartolaStub,
) {
  const calls: RecordedCall[] = [];
  const impl = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === "string" ? input : input.toString();
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string>, body });

    const json = (payload: unknown) => new Response(JSON.stringify(payload), { status: 200 });
    if (url.includes("ultCartolaHistorica")) {
      const month = String((body["INPUT"] as Record<string, unknown>)["MESCONSULTA"]);
      return json(cartola?.list ? cartola.list(month) : cartolaListing(null));
    }
    if (url.includes("buzonVirtual")) {
      if (cartola?.pdf === "error") return new Response("nope", { status: 503 });
      if (cartola?.pdf === "auth") return new Response("nope", { status: 401 });
      return json(cartola?.pdf ?? cartolaPdf());
    }
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

describe("cartola backfill (SANTANDER_CARTOLA_MONTHS)", () => {
  // A stub `pdftotext` (via SANTANDER_PDFTOTEXT) emits a fixed cartola text so the parse+filter+
  // merge path runs without poppler. The statement is June 2026 with rows straddling the live
  // feed's oldest date (2026-06-29 PAYROLL) — the overlap filter must drop rows on/after it.
  const STUB_DIR = `${process.env["TMPDIR"] ?? "/tmp"}/santander-cartola-stub`;
  const W = 210;
  const place = (parts: Array<[number, string]>): string => {
    const b = Array<string>(W).fill(" ");
    for (const [c, s] of parts) for (let i = 0; i < s.length; i++) b[c + i] = s[i] as string;
    return b.join("").replace(/\s+$/, "");
  };
  const rt = (end: number, s: string): [number, string] => [end - s.length, s];
  const JUNE_CARTOLA =
    [
      place([
        [16, "42"],
        [117, "01/06/2026"],
        [139, "30/06/2026"],
        [166, "1 de 1"],
      ]),
      place([
        [0, "FECHA"],
        [11, "SUCURSAL"],
        [54, "DESCRIPCION"],
        [98, "Nº DCTO"],
        [117, "CHEQUES Y OTROS"],
        [151, "DEPOSITOS Y OTROS"],
        [195, "SALDO"],
      ]),
      place([[0, "15/06"], [6, "Agustinas"], [16, "Pago Servicio A"], rt(136, "100.000")]),
      place([[0, "20/06"], [6, "Agustinas"], [16, "Deposito B"], rt(175, "300.000")]),
      place([[0, "29/06"], [6, "Agustinas"], [16, "Pago Servicio C"], rt(136, "50.000")]),
      place([[0, "30/06"], [6, "Agustinas"], [16, "Pago Servicio D"], rt(136, "25.000")]),
      place([[1, "INFORMACION DE CUENTA CORRIENTE"]]),
      place([
        [8, "SALDO INICIAL"],
        [36, "DEPOSITOS"],
        [56, "OTROS ABONOS"],
        [77, "CHEQUES"],
        [98, "OTROS CARGOS"],
        [131, "IMPUESTOS"],
        [163, "SALDO FINAL"],
      ]),
      place([
        rt(21, "1.000.000"),
        rt(45, "0"),
        rt(74, "300.000"),
        rt(95, "0"),
        rt(122, "175.000"),
        rt(151, "0"),
        rt(184, "1.125.000"),
      ]),
    ].join("\n") + "\n";

  beforeAll(() => {
    mkdirSync(STUB_DIR, { recursive: true });
    const textPath = `${STUB_DIR}/cartola.txt`;
    writeFileSync(textPath, JUNE_CARTOLA);
    const stubPath = `${STUB_DIR}/pdftotext`;
    writeFileSync(stubPath, `#!/bin/sh\ncat "${textPath}"\n`); // ignore stdin/args, emit the text
    chmodSync(stubPath, 0o755);
    process.env["SANTANDER_PDFTOTEXT"] = stubPath;
  });

  afterAll(() => {
    delete process.env["SANTANDER_PDFTOTEXT"];
    rmSync(STUB_DIR, { recursive: true, force: true });
  });

  test("off by default: no cartola endpoints are called when the knob is unset", async () => {
    const { impl, calls } = makeFetch();
    await fetchSantanderData(CREDENTIALS, {}, { fetchImpl: impl, today: TODAY });
    expect(calls.some((c) => c.url.includes("ultCartolaHistorica"))).toBe(false);
    expect(calls.some((c) => c.url.includes("buzonVirtual"))).toBe(false);
  });

  test("merges statement rows OLDER than the live feed's reach, excluding the overlap", async () => {
    // June statement exists; other probed months don't → exactly one PDF fetched.
    const { impl, calls } = makeFetch(fixtures.inventory, undefined, {
      list: (month) =>
        month === "06"
          ? cartolaListing({ closeDate: "2026-06-30", account: "000012345678" })
          : cartolaListing(null),
    });
    const results = await fetchSantanderData(
      CREDENTIALS,
      {},
      { fetchImpl: impl, today: TODAY, cartolaMonths: 3 },
    );

    expect(calls.filter((c) => c.url.includes("ultCartolaHistorica"))).toHaveLength(3);
    expect(calls.filter((c) => c.url.includes("buzonVirtual"))).toHaveLength(1);

    const checkingClp = results.get("checking:CLP");
    const dates = (checkingClp?.facets.transactions ?? []).map((t) => String(t.date)).sort();
    // 3 live (06-29, 07-01, 07-02) + 2 cartola BEFORE the boundary (06-15, 06-20). The cartola
    // 06-29 and 06-30 rows are dropped (on/after the live feed's oldest date 2026-06-29).
    expect(dates).toEqual(["2026-06-15", "2026-06-20", "2026-06-29", "2026-07-01", "2026-07-02"]);
    expect(dates.filter((d) => d === "2026-06-29")).toHaveLength(1); // no double-count
    expect(dates.includes("2026-06-30")).toBe(false); // overlap row excluded

    // buzonVirtual request: dash-formatted contract + YYYYMMDD close date + CUENTAS_AR doc type.
    const pdfCall = calls.find((c) => c.url.includes("buzonVirtual"));
    const pdfInput = pdfCall?.body["INPUT"] as Record<string, unknown>;
    expect(pdfInput["contrato"]).toBe("0-000-12-34567-8");
    expect(pdfInput["fechaInicio"]).toBe("20260630");
    expect(pdfInput["tipoDocumento"]).toBe("CUENTAS_AR");
  });

  test("a month with no statement (CODERR 16) fetches no PDF; checking stays live-only", async () => {
    const { impl, calls } = makeFetch(fixtures.inventory, undefined, {
      list: () => cartolaListing(null), // every month absent
    });
    const results = await fetchSantanderData(
      CREDENTIALS,
      {},
      { fetchImpl: impl, today: TODAY, cartolaMonths: 3 },
    );
    expect(calls.some((c) => c.url.includes("buzonVirtual"))).toBe(false);
    expect(results.get("checking:CLP")?.facets.transactions).toHaveLength(3);
  });

  test("a failing cartola PDF degrades to live-only (no regression)", async () => {
    const { impl } = makeFetch(fixtures.inventory, undefined, {
      list: (month) =>
        month === "06"
          ? cartolaListing({ closeDate: "2026-06-30", account: "000012345678" })
          : cartolaListing(null),
      pdf: "error", // buzonVirtual → HTTP 503
    });
    const results = await fetchSantanderData(
      CREDENTIALS,
      {},
      { fetchImpl: impl, today: TODAY, cartolaMonths: 3 },
    );
    expect(results.get("checking:CLP")?.facets.transactions).toHaveLength(3); // live only
  });

  test("AuthError from a cartola endpoint propagates (token manager must re-harvest)", async () => {
    const { impl } = makeFetch(fixtures.inventory, undefined, {
      list: (month) =>
        month === "06"
          ? cartolaListing({ closeDate: "2026-06-30", account: "000012345678" })
          : cartolaListing(null),
      pdf: "auth", // buzonVirtual → HTTP 401
    });
    expect(
      fetchSantanderData(CREDENTIALS, {}, { fetchImpl: impl, today: TODAY, cartolaMonths: 3 }),
    ).rejects.toThrow(AuthError);
  });

  test("checking:CLP only — the USD checking leg does not fetch cartolas", async () => {
    const { impl, calls } = makeFetch(fixtures.inventory, undefined, {
      list: (month) =>
        month === "06"
          ? cartolaListing({ closeDate: "2026-06-30", account: "000012345678" })
          : cartolaListing(null),
    });
    await fetchSantanderData(CREDENTIALS, {}, { fetchImpl: impl, today: TODAY, cartolaMonths: 3 });
    // One CONTRATO (the CLP checking contract) is probed — the USD leg is skipped entirely.
    const contratos = new Set(
      calls
        .filter((c) => c.url.includes("ultCartolaHistorica"))
        .map((c) => (c.body["INPUT"] as Record<string, unknown>)["CONTRATO"]),
    );
    expect(contratos).toEqual(new Set(["000012345678"]));
  });
});
