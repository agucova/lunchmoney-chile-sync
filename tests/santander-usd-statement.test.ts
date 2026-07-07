// USD international billed statement: PDF-wrapper validation, text→transactions parsing, and
// the reconciliation gate that makes PDF parsing safe. Uses a sanitized pdftotext-layout
// fixture (fictional merchants/amounts) that reconciles exactly.
import { describe, expect, test } from "bun:test";
import {
  extractStatementPdf,
  parseUsdStatementText,
} from "../src/adapters/santander/usd-statement.ts";
import { SchemaDriftError } from "../src/core/errors.ts";

const STATEMENT_TEXT = await Bun.file(
  new URL("./fixtures/santander-usd-statement.txt", import.meta.url).pathname,
).text();

describe("parseUsdStatementText", () => {
  test("parses the international table into billed USD txns with correct sign", () => {
    const txns = parseUsdStatementText(STATEMENT_TEXT);
    expect(txns.map((t) => [String(t.date), t.amount.minor, t.rawDescription, t.status])).toEqual([
      ["2026-05-15", -1000n, "UBER *TRIP", "billed"], // purchase → negative (debit)
      ["2026-05-16", -2550n, "AMAZON PRIME*AB12CD34", "billed"], // city with "/" handled
      ["2026-05-17", -123456n, "LYRO LAB", "billed"], // dot-thousands USD
      ["2026-05-18", 2000n, "NOTA DE CREDITO", "billed"], // credit → positive
    ]);
    // The TRASPASO DE DEUDA row is a balance mechanic, not a transaction.
    expect(txns.every((t) => !/traspaso/i.test(t.rawDescription))).toBe(true);
    expect(txns.every((t) => t.amount.currency === "USD")).toBe(true);
  });

  test("rejects a statement whose purchases don't sum to TOTAL DE COMPRAS Y CARGOS", () => {
    // Drop one purchase's amount so the line items no longer reconcile.
    const tampered = STATEMENT_TEXT.replace("10,00         10,00", "10,00          9,00");
    expect(() => parseUsdStatementText(tampered)).toThrow(SchemaDriftError);
  });

  test("rejects a statement whose credits don't match ABONO REALIZADO", () => {
    const tampered = STATEMENT_TEXT.replace("US$ -20,00", "US$ -25,00"); // ABONO header only
    expect(() => parseUsdStatementText(tampered)).toThrow(SchemaDriftError);
  });

  test("a missing header total is SchemaDrift", () => {
    const tampered = STATEMENT_TEXT.replace("TOTAL DE COMPRAS Y CARGOS", "TOTAL COMPRAS");
    expect(() => parseUsdStatementText(tampered)).toThrow(/missing total/);
  });
});

describe("extractStatementPdf", () => {
  const pdfBytes = Buffer.from("%PDF-1.4\nfake pdf body\n%%EOF").toString("base64");
  const wrapper = (over: Record<string, unknown> = {}) => ({
    METADATA: { STATUS: "0", DESCRIPCION: "OK" },
    DATA: {
      Informacion: { Codigo: "00", Resultado: "Operación exitosa", Mensaje: "Operación exitosa" },
      imgNbs64: pdfBytes,
      ...over,
    },
  });

  test("decodes the base64 PDF from a valid wrapper", () => {
    const bytes = extractStatementPdf(wrapper());
    expect(Buffer.from(bytes).subarray(0, 5).toString()).toBe("%PDF-");
  });

  test("a non-PDF imgNbs64 is SchemaDrift", () => {
    expect(() =>
      extractStatementPdf(wrapper({ imgNbs64: Buffer.from("<html>").toString("base64") })),
    ).toThrow(SchemaDriftError);
  });

  test("a non-success Codigo is SchemaDrift", () => {
    const bad = wrapper();
    bad.DATA.Informacion.Codigo = "91";
    expect(() => extractStatementPdf(bad)).toThrow(SchemaDriftError);
  });

  test("an unexpected wrapper field is SchemaDrift (strict)", () => {
    const bad = wrapper() as Record<string, unknown>;
    (bad as { extra?: unknown }).extra = 1;
    expect(() => extractStatementPdf(bad)).toThrow(SchemaDriftError);
  });
});
