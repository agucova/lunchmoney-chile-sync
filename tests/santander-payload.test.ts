// Fail-closed parsing of Santander's native JSON API payloads, against sanitized
// format-faithful fixtures. Exactness assertions are on BigInt minor units.
import { describe, expect, test } from "bun:test";
import {
  parseCardMovements,
  parseCheckingTransactions,
  parseInventory,
} from "../src/adapters/santander/payload.ts";
import { SchemaDriftError } from "../src/core/errors.ts";
import fixtures from "./fixtures/santander-http.json";

function clone<T>(value: T): T {
  return structuredClone(value);
}

describe("parseInventory", () => {
  test("classifies the five observed products with exact balances", () => {
    const products = parseInventory(fixtures.inventory);
    expect(products.map((p) => [p.group, p.currency, p.glosa])).toEqual([
      ["CCC", "CLP", "CUENTA CORRIENTE"],
      ["LCR", "CLP", "LINEA CDTO PERSONAS"],
      ["CCC", "USD", "CTA CORRIENTE MX"],
      ["TCR", "CLP", "W. LIMITED VISA"],
      ["TCR", "USD", "W. LIMITED VISA"],
    ]);

    const [checkingClp, , checkingUsd, cardClp, cardUsd] = products;
    expect(checkingClp?.available.minor).toBe(5324985n);
    expect(checkingClp?.contract).toBe("000012345678");
    expect(checkingClp?.office).toBe("0123");
    expect(checkingUsd?.available.minor).toBe(264335n); // $2,643.35 in cents
    // Card legs: used + available = cupo, per currency.
    expect(cardClp?.used.minor).toBe(2919265n);
    expect(cardClp?.used.add(cardClp.available).equals(cardClp.cupo)).toBe(true);
    expect(cardUsd?.used.minor).toBe(435665n);
    expect(cardUsd?.used.add(cardUsd.available).equals(cardUsd.cupo)).toBe(true);
    // Both card legs share the contract (one card, two currency statements).
    expect(cardClp?.contract).toBe(cardUsd?.contract);
  });

  test("an unknown product group is SchemaDrift, not a guess", () => {
    const bad = clone(fixtures.inventory);
    const entry = bad.DATA.OUTPUT.MATRICES.MATRIZCAPTACIONES.e1[0];
    if (!entry) throw new Error("fixture shape");
    entry.AGRUPACIONCOMERCIAL = "DEP";
    expect(() => parseInventory(bad)).toThrow(SchemaDriftError);
  });

  test("an unknown currency is SchemaDrift", () => {
    const bad = clone(fixtures.inventory);
    const entry = bad.DATA.OUTPUT.MATRICES.MATRIZCAPTACIONES.e1[0];
    if (!entry) throw new Error("fixture shape");
    entry.CODIGOMONEDA = "UF";
    expect(() => parseInventory(bad)).toThrow(SchemaDriftError);
  });

  test("a product outside the observed active state is SchemaDrift", () => {
    const bad = clone(fixtures.inventory);
    const entry = bad.DATA.OUTPUT.MATRICES.MATRIZCAPTACIONES.e1[0];
    if (!entry) throw new Error("fixture shape");
    entry.ESTADOOPERACION = "B";
    expect(() => parseInventory(bad)).toThrow(SchemaDriftError);
  });

  test("a non-success CODERR is SchemaDrift", () => {
    const bad = clone(fixtures.inventory);
    bad.DATA.OUTPUT.INFO.CODERR = "91";
    expect(() => parseInventory(bad)).toThrow(SchemaDriftError);
  });

  test("an unexpected field on a product entry is SchemaDrift (strict schemas)", () => {
    const bad = clone(fixtures.inventory) as {
      DATA: { OUTPUT: { MATRICES: { MATRIZCAPTACIONES: { e1: Array<Record<string, unknown>> } } } };
    };
    const entry = bad.DATA.OUTPUT.MATRICES.MATRIZCAPTACIONES.e1[0];
    if (!entry) throw new Error("fixture shape");
    entry["MONTOBLOQUEADO"] = "000000000000000000";
    expect(() => parseInventory(bad)).toThrow(SchemaDriftError);
  });
});

describe("parseCheckingTransactions", () => {
  test("parses posted movements with exact amounts and OBC-compatible descriptions", () => {
    const txns = parseCheckingTransactions(fixtures.checkingWithMovements, "CLP");
    expect(txns).toHaveLength(3);

    const [payroll, transfer, fee] = txns;
    // transactionDate wins over accountingDate (mirrors open-banking-chile).
    expect(String(payroll?.date)).toBe("2026-06-29");
    expect(payroll?.amount.minor).toBe(1234567n);
    expect(payroll?.rawDescription).toBe("00775502738 JUNE 2026 PAYROLL");
    expect(payroll?.status).toBe("posted");
    expect(payroll?.meta.runningBalance?.minor).toBe(6082614n);

    expect(transfer?.amount.minor).toBe(-250000n);
    expect(transfer?.rawDescription).toBe("0105109725 TRANSF A JUAN PEREZ");

    // Blank observation falls back to the movement-type gloss.
    expect(fee?.amount.minor).toBe(-3560n);
    expect(fee?.rawDescription).toBe("Comisión Plan");
  });

  test("both observed empty-window variants parse as zero transactions", () => {
    expect(parseCheckingTransactions(fixtures.checkingEmptyOk, "CLP")).toEqual([]);
    expect(parseCheckingTransactions(fixtures.checkingNoData, "USD")).toEqual([]);
  });

  test("an unobserved code-ms is SchemaDrift", () => {
    const bad = clone(fixtures.checkingNoData);
    const code = bad.additionalInfo[0];
    if (!code) throw new Error("fixture shape");
    code.value = "BGE9999";
    expect(() => parseCheckingTransactions(bad, "CLP")).toThrow(SchemaDriftError);
  });

  test("NO EXISTEN DATOS carrying movements is SchemaDrift", () => {
    const bad = clone(fixtures.checkingNoData) as Record<string, unknown>;
    bad["movements"] = clone(fixtures.checkingWithMovements.movements);
    expect(() => parseCheckingTransactions(bad, "CLP")).toThrow(SchemaDriftError);
  });

  test("D/H flag disagreeing with the trailing-dash sign is SchemaDrift", () => {
    const bad = clone(fixtures.checkingWithMovements);
    const movement = bad.movements[0];
    if (!movement) throw new Error("fixture shape");
    movement.chargePaymentFlag = "D"; // amount has no trailing "-" → positive
    expect(() => parseCheckingTransactions(bad, "CLP")).toThrow(SchemaDriftError);
  });

  test("fractional pesos in a CLP movement are SchemaDrift", () => {
    const bad = clone(fixtures.checkingWithMovements);
    const movement = bad.movements[1];
    if (!movement) throw new Error("fixture shape");
    movement.movementAmount = "00000025000050-";
    expect(() => parseCheckingTransactions(bad, "CLP")).toThrow(SchemaDriftError);
  });
});

describe("parseCardMovements", () => {
  test("CLP leg: skips SALDO INICIAL, keeps purchases and payments with exact pesos", () => {
    const txns = parseCardMovements(fixtures.cardClp, "CLP");
    expect(txns.map((t) => t.rawDescription)).toEqual([
      "PAYU *TRANSPORTE",
      "PAGO PESOS", // Comercio null → falls back to Descripcion
      "MERPAGO *CAFETERIA",
    ]);
    expect(txns.map((t) => t.amount.minor)).toEqual([-11994n, 1430960n, -990n]);
    expect(txns.every((t) => t.status === "unbilled")).toBe(true);
    expect(String(txns[0]?.date)).toBe("2026-06-29"); // dd/mm/yyyy
  });

  test("USD leg: comma decimals parse to exact cents", () => {
    const txns = parseCardMovements(fixtures.cardUsd, "USD");
    expect(txns.map((t) => t.amount.minor)).toEqual([-1632n, -10000n]);
    expect(txns[0]?.amount.currency).toBe("USD");
  });

  test("a non-success Codigo is SchemaDrift", () => {
    const bad = clone(fixtures.cardClp);
    bad.DATA.Informacion.Codigo = "91";
    expect(() => parseCardMovements(bad, "CLP")).toThrow(SchemaDriftError);
  });

  test("a non-OK METADATA.STATUS is SchemaDrift", () => {
    const bad = clone(fixtures.cardClp);
    bad.METADATA.STATUS = "1";
    expect(() => parseCardMovements(bad, "CLP")).toThrow(SchemaDriftError);
  });

  test("a comma-decimal Importe on the CLP leg is SchemaDrift (pesos have no cents)", () => {
    const bad = clone(fixtures.cardClp);
    const movement = bad.DATA.MatrizMovimientos[1];
    if (!movement) throw new Error("fixture shape");
    movement.Importe = "11.994,50";
    expect(() => parseCardMovements(bad, "CLP")).toThrow(SchemaDriftError);
  });

  test("an unexpected movement field is SchemaDrift (strict schemas)", () => {
    const bad = clone(fixtures.cardClp) as {
      METADATA: unknown;
      DATA: { MatrizMovimientos: Array<Record<string, unknown>> };
    };
    const movement = bad.DATA.MatrizMovimientos[1];
    if (!movement) throw new Error("fixture shape");
    movement["Cuotas"] = "01/03";
    expect(() => parseCardMovements(bad, "CLP")).toThrow(SchemaDriftError);
  });
});
