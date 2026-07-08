// Checking-account statement (cartola): PDF-wrapper validation, the ultCartolaHistorica listing
// parse, and the text→transactions parser with its reconciliation gate. Uses a sanitized
// pdftotext-layout fixture (fictional names/amounts) that reconciles exactly — reconciliation
// succeeds ONLY when the trailing "Resumen de Comisiones" duplicate is excluded.
import { describe, expect, test } from "bun:test";
import {
  dashContract,
  extractCartolaPdf,
  parseCartolaList,
  parseCartolaText,
} from "../src/adapters/santander/cartola.ts";
import { SchemaDriftError } from "../src/core/errors.ts";

const STATEMENT_TEXT = await Bun.file(
  new URL("./fixtures/santander-checking-statement.txt", import.meta.url).pathname,
).text();

describe("parseCartolaText", () => {
  test("parses the movement table into posted CLP txns with column-driven signs", () => {
    const txns = parseCartolaText(STATEMENT_TEXT);
    expect(txns.map((t) => [String(t.date), t.amount.minor, t.rawDescription, t.status])).toEqual([
      ["2025-07-05", -300000n, "Traspaso a Cuenta de Otro Banco", "posted"], // CARGO → debit
      ["2025-07-10", -150000n, "0123456789 Transf a JUAN PEREZ", "posted"], // docnum stripped
      ["2025-07-15", 500000n, "0987654321 SUELDO EMPRESA XYZ", "posted"], // ABONO (deposit) → credit
      ["2025-07-20", 200000n, "Abono Transferencia", "posted"], // ABONO, no docnum/saldo
      ["2025-07-30", -26702n, "COM.MANTENCION PLAN", "posted"], // in-table commission (kept)
    ]);
    // The Resumen de Comisiones row (a duplicate COM.MANTENCION PLAN) is excluded — 5 rows, not 6.
    expect(txns).toHaveLength(5);
    expect(txns.every((t) => t.amount.currency === "CLP")).toBe(true);
  });

  test("captures the running balance where present, omits it otherwise", () => {
    const txns = parseCartolaText(STATEMENT_TEXT);
    expect(txns.map((t) => t.meta.runningBalance?.minor ?? null)).toEqual([
      700000n,
      550000n,
      1050000n,
      null,
      null,
    ]);
  });

  test("rejects a statement whose debits don't sum to the footer CARGOS total", () => {
    const tampered = STATEMENT_TEXT.replace("300.000", "200.000"); // one CARGO row only
    expect(() => parseCartolaText(tampered)).toThrow(SchemaDriftError);
  });

  test("rejects a statement whose credits don't sum to the footer ABONOS total", () => {
    const tampered = STATEMENT_TEXT.replace("500.000", "400.000"); // one ABONO row only
    expect(() => parseCartolaText(tampered)).toThrow(SchemaDriftError);
  });

  test("rejects a statement whose SALDO FINAL doesn't equal inicial + credits − debits", () => {
    const tampered = STATEMENT_TEXT.replace("1.223.298", "1.223.299");
    expect(() => parseCartolaText(tampered)).toThrow(SchemaDriftError);
  });

  test("including the Resumen de Comisiones duplicate breaks reconciliation", () => {
    // Remove the stop marker so the duplicate commission row gets counted → debits no longer match.
    const tampered = STATEMENT_TEXT.replace("Resumen de Comisiones", "Otros Movimientos    ");
    expect(() => parseCartolaText(tampered)).toThrow(SchemaDriftError);
  });

  test("a missing footer is SchemaDrift", () => {
    const tampered = STATEMENT_TEXT.replace("SALDO INICIAL", "SALDO INIC");
    expect(() => parseCartolaText(tampered)).toThrow(/footer/);
  });

  test("a missing statement period is SchemaDrift", () => {
    const tampered = STATEMENT_TEXT.replace("30/06/2025", "30-06-2025");
    expect(() => parseCartolaText(tampered)).toThrow(/period/);
  });
});

describe("parseCartolaList", () => {
  const listing = (over: Record<string, unknown> = {}) => ({
    METADATA: { STATUS: "0", DESCRIPCION: "OK" },
    DATA: {
      AS_TIB_ConsultaUltCartolaHistorica: {
        INFO: { CODERR: "00", DESERR: "OK", MSGUSUARIO: "" },
        OUTPUT: {
          Escalares: { ESTADORESULTADO: "0" },
          MATRIZ: [
            { NUMEROCARTOLA: "  42", NUMEROCUENTA: "000011111111", FECHADESDE: "2025-07-31" },
          ],
        },
        ...over,
      },
    },
  });

  test("CODERR 00 returns the statement close date and account number", () => {
    const parsed = parseCartolaList(listing());
    expect(
      parsed && { closeDate: String(parsed.closeDate), account: parsed.accountNumber },
    ).toEqual({ closeDate: "2025-07-31", account: "000011111111" });
  });

  test("CODERR 16 (no statement that month) returns null", () => {
    expect(
      parseCartolaList(listing({ INFO: { CODERR: "16", DESERR: "sin datos", MSGUSUARIO: "" } })),
    ).toBeNull();
  });

  test("any other CODERR is SchemaDrift", () => {
    expect(() =>
      parseCartolaList(listing({ INFO: { CODERR: "99", DESERR: "error", MSGUSUARIO: "" } })),
    ).toThrow(SchemaDriftError);
  });

  test("an unexpected field is SchemaDrift (strict)", () => {
    const bad = listing() as Record<string, unknown>;
    (bad as { extra?: unknown }).extra = 1;
    expect(() => parseCartolaList(bad)).toThrow(SchemaDriftError);
  });
});

describe("extractCartolaPdf", () => {
  const pdfBytes = Buffer.from("%PDF-1.4\nfake pdf body\n%%EOF").toString("base64");
  const wrapper = (over: Record<string, unknown> = {}) => ({
    METADATA: { STATUS: "0", DESCRIPCION: "OK" },
    DATA: {
      OUTPUT: {
        INFO: { CODERR: "00", DESERR: "Operación exitosa." },
        FILE: pdfBytes,
        ...over,
      },
    },
  });

  test("decodes the base64 PDF from a valid wrapper", () => {
    const bytes = extractCartolaPdf(wrapper());
    expect(Buffer.from(bytes).subarray(0, 5).toString()).toBe("%PDF-");
  });

  test("a non-PDF FILE is SchemaDrift", () => {
    expect(() =>
      extractCartolaPdf(wrapper({ FILE: Buffer.from("<html>").toString("base64") })),
    ).toThrow(SchemaDriftError);
  });

  test("a non-success CODERR is SchemaDrift", () => {
    expect(() =>
      extractCartolaPdf(wrapper({ INFO: { CODERR: "91", DESERR: "sin documento" } })),
    ).toThrow(SchemaDriftError);
  });

  test("an unexpected wrapper field is SchemaDrift (strict)", () => {
    expect(() => extractCartolaPdf(wrapper({ extra: 1 }))).toThrow(SchemaDriftError);
  });
});

describe("dashContract", () => {
  test("formats a 12-digit account number 1-3-2-5-1", () => {
    expect(dashContract("001234567890")).toBe("0-012-34-56789-0");
  });

  test("a non-12-digit account number is SchemaDrift", () => {
    expect(() => dashContract("12345")).toThrow(SchemaDriftError);
  });
});
