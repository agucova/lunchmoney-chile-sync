// Checking-account statement ("cartola") — historical checking movements that the live
// current-accounts/transactions feed can't reach (it silently caps at ~60–90 days). A cartola
// is a monthly PDF fetched in two steps: ultCartolaHistorica lists whether a month's statement
// exists (+ its close date), then buzonVirtual returns it as a base64 PDF. We decode the PDF,
// extract text with `pdftotext -layout` (reusing usd-statement.ts's extractor), parse the
// movement table, and — crucially — RECONCILE the parsed rows against the statement's own footer
// totals before ingesting. A parse that doesn't reconcile is discarded (fail closed), so a
// future layout change degrades to no-cartola rather than wrong money.
//
// Layout (pdftotext -layout), positional columns keyed off the header row:
//   FECHA(dd/mm)  SUCURSAL  DESCRIPCION  Nº DCTO  CHEQUES Y OTROS CARGOS  DEPOSITOS Y OTROS ABONOS  SALDO
// A movement row carries a magnitude in the CARGO (debit) OR ABONO (credit) column, classified
// by the amount's start column; SALDO is an intermittent running balance. Amounts are dotted CLP
// integers ("250.000"); the row year comes from the statement's DESDE/HASTA period. The trailing
// "Resumen de Comisiones" block repeats commission rows already in the table — excluded.
// Reconciliation footer (INFORMACION DE CUENTA CORRIENTE), all exact:
//   sum(ABONO rows) == DEPOSITOS + OTROS ABONOS
//   sum(CARGO rows) == CHEQUES + OTROS CARGOS + IMPUESTOS
//   SALDO INICIAL + credits − debits == SALDO FINAL

import { compareIsoDates, type IsoDate, parseBankDate } from "../../core/dates.ts";
import { SchemaDriftError } from "../../core/errors.ts";
import type { CanonicalTxn } from "../../core/model.ts";
import { Money } from "../../core/money.ts";
import { normalizeDescription } from "../../core/normalize.ts";
import { z } from "zod";
import { parseBilledMonto } from "./amounts.ts";

// ---------------------------------------------------------------------------
// buzonVirtual response → PDF bytes
// ---------------------------------------------------------------------------

const CartolaPdfSchema = z
  .object({
    METADATA: z.object({ STATUS: z.string(), DESCRIPCION: z.string() }).strict(),
    DATA: z
      .object({
        OUTPUT: z
          .object({
            INFO: z.object({ CODERR: z.string(), DESERR: z.string() }).strict(),
            FILE: z.string().min(1),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();

/** Validate the buzonVirtual wrapper and decode its base64 PDF to bytes. */
export function extractCartolaPdf(payload: unknown): Uint8Array {
  const parsed = CartolaPdfSchema.safeParse(payload);
  if (!parsed.success) {
    throw new SchemaDriftError(
      `santander cartola payload failed validation: ${parsed.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    );
  }
  const { OUTPUT } = parsed.data.DATA;
  if (OUTPUT.INFO.CODERR !== "00") {
    throw new SchemaDriftError(
      `santander cartola CODERR ${OUTPUT.INFO.CODERR}: ${OUTPUT.INFO.DESERR}`,
    );
  }
  const bytes = Buffer.from(OUTPUT.FILE, "base64");
  if (bytes.length < 5 || bytes.subarray(0, 5).toString("latin1") !== "%PDF-") {
    throw new SchemaDriftError("santander cartola FILE is not a PDF");
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// ultCartolaHistorica response → statement listing (or null when none exists)
// ---------------------------------------------------------------------------

const CartolaListSchema = z
  .object({
    METADATA: z.object({ STATUS: z.string(), DESCRIPCION: z.string() }).strict(),
    DATA: z
      .object({
        AS_TIB_ConsultaUltCartolaHistorica: z
          .object({
            INFO: z
              .object({ CODERR: z.string(), DESERR: z.string(), MSGUSUARIO: z.string() })
              .strict(),
            OUTPUT: z
              .object({
                Escalares: z.object({ ESTADORESULTADO: z.string() }).strict(),
                MATRIZ: z
                  .array(
                    z
                      .object({
                        NUMEROCARTOLA: z.string(),
                        NUMEROCUENTA: z.string(),
                        FECHADESDE: z.string(),
                      })
                      .strict(),
                  )
                  .min(1),
              })
              .strict()
              .optional(),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();

export interface CartolaListing {
  /** Statement close date (ISO); drives the buzonVirtual fecha and the row-year basis. */
  readonly closeDate: IsoDate;
  /** 12-digit account number; dash-formatted for the buzonVirtual `contrato`. */
  readonly accountNumber: string;
}

/**
 * Parse an ultCartolaHistorica response. CODERR "16" means no statement exists for that month
 * (e.g. the current, still-open month) → null. CODERR "00" → the statement's close date +
 * account number. Any other code, or a malformed/strict-extra payload, is schema drift.
 */
export function parseCartolaList(payload: unknown): CartolaListing | null {
  const parsed = CartolaListSchema.safeParse(payload);
  if (!parsed.success) {
    throw new SchemaDriftError(
      `santander cartola-list payload failed validation: ${parsed.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    );
  }
  const consulta = parsed.data.DATA.AS_TIB_ConsultaUltCartolaHistorica;
  if (consulta.INFO.CODERR === "16") return null; // no statement that month
  if (consulta.INFO.CODERR !== "00") {
    throw new SchemaDriftError(
      `santander cartola-list CODERR ${consulta.INFO.CODERR}: ${consulta.INFO.DESERR}`,
    );
  }
  if (!consulta.OUTPUT) {
    throw new SchemaDriftError("santander cartola-list CODERR 00 but no OUTPUT");
  }
  const row = consulta.OUTPUT.MATRIZ[0] as { FECHADESDE: string; NUMEROCUENTA: string };
  return {
    closeDate: parseBankDate(row.FECHADESDE.trim(), "iso"),
    accountNumber: row.NUMEROCUENTA.trim(),
  };
}

// ---------------------------------------------------------------------------
// Text → checking transactions (with reconciliation)
// ---------------------------------------------------------------------------

const PERIOD_RE = /^\s*\d+\s+(\d{2}\/\d{2}\/\d{4})\s+(\d{2}\/\d{2}\/\d{4})/;
const MOVEMENT_RE = /^(\d{2})\/(\d{2})\b/;
const STOP_RE = /Resumen de Comisiones|INFORMACION DE CUENTA/;
const AMOUNT_RE = /\d[\d.]*\d|\d/g;

interface Columns {
  readonly headerIdx: number;
  readonly descEnd: number;
  readonly cargo: number;
  readonly abono: number;
  readonly saldo: number;
}

/** Locate the movement-table header row and its column offsets; drift if not found. */
function parseColumns(lines: readonly string[]): Columns {
  const headerIdx = lines.findIndex(
    (l) => l.includes("DESCRIPCION") && l.includes("CHEQUES Y OTROS"),
  );
  if (headerIdx < 0) throw new SchemaDriftError("cartola movement header row not found");
  const header = lines[headerIdx] as string;
  const cargo = header.indexOf("CHEQUES Y OTROS");
  const abono = header.indexOf("DEPOSITOS Y OTROS");
  const saldo = header.indexOf("SALDO");
  const docCol = header.indexOf("DCTO");
  if (cargo < 0 || abono < 0 || saldo < 0 || docCol < 0) {
    throw new SchemaDriftError("cartola movement header columns incomplete");
  }
  // Nº DCTO values sit a few columns left of the "DCTO" label, so end the description before them.
  return { headerIdx, descEnd: Math.max(6, docCol - 3), cargo, abono, saldo };
}

/** Parse the DESDE/HASTA statement period (the row-year basis). */
function parsePeriod(lines: readonly string[]): { desde: IsoDate; hasta: IsoDate } {
  for (const line of lines) {
    const m = PERIOD_RE.exec(line);
    if (m) {
      return {
        desde: parseBankDate(m[1] as string, "dd/mm/yyyy"),
        hasta: parseBankDate(m[2] as string, "dd/mm/yyyy"),
      };
    }
  }
  throw new SchemaDriftError("cartola statement period (DESDE/HASTA) not found");
}

/** Assign a dd/mm row the year from the statement period; drift if it falls outside it. */
function resolveRowDate(dd: string, mm: string, desde: IsoDate, hasta: IsoDate): IsoDate {
  const desdeYear = Number(desde.slice(0, 4));
  const hastaYear = Number(hasta.slice(0, 4));
  const desdeMonth = Number(desde.slice(5, 7));
  const year = Number(mm) >= desdeMonth ? desdeYear : hastaYear;
  const date = parseBankDate(`${dd}/${mm}/${year}`, "dd/mm/yyyy");
  if (compareIsoDates(date, desde) < 0 || compareIsoDates(date, hasta) > 0) {
    throw new SchemaDriftError(`cartola row date ${date} outside period ${desde}..${hasta}`);
  }
  return date;
}

/** The one movement magnitude (CARGO/ABONO) and optional running balance from a row. */
interface RowAmounts {
  readonly cargo?: Money;
  readonly abono?: Money;
  readonly saldo?: Money;
}

/** Classify each numeric token in a row by its start column into the CARGO/ABONO/SALDO field. */
function scanAmounts(line: string, cols: Columns): RowAmounts {
  let cargo: Money | undefined;
  let abono: Money | undefined;
  let saldo: Money | undefined;
  AMOUNT_RE.lastIndex = 0;
  for (let m = AMOUNT_RE.exec(line); m; m = AMOUNT_RE.exec(line)) {
    const start = m.index;
    if (start < cols.cargo) continue; // FECHA/description/docnum digits — not amounts
    const magnitude = parseBilledMonto(m[0], "CLP");
    if (start < cols.abono) {
      if (cargo) throw new SchemaDriftError(`cartola row has two CARGO amounts: ${line.trim()}`);
      cargo = magnitude;
    } else if (start < cols.saldo) {
      if (abono) throw new SchemaDriftError(`cartola row has two ABONO amounts: ${line.trim()}`);
      abono = magnitude;
    } else {
      saldo = line[m.index + m[0].length] === "-" ? magnitude.negate() : magnitude;
    }
  }
  return { ...(cargo ? { cargo } : {}), ...(abono ? { abono } : {}), ...(saldo ? { saldo } : {}) };
}

const FOOTER_FIELDS = [
  "saldoInicial",
  "depositos",
  "otrosAbonos",
  "cheques",
  "otrosCargos",
  "impuestos",
  "saldoFinal",
] as const;
type FooterTotals = Record<(typeof FOOTER_FIELDS)[number], Money>;

/** Parse the 7 reconciliation totals under INFORMACION DE CUENTA CORRIENTE. */
function parseFooter(lines: readonly string[]): FooterTotals {
  const labelIdx = lines.findIndex((l) => l.includes("SALDO INICIAL") && l.includes("SALDO FINAL"));
  if (labelIdx < 0)
    throw new SchemaDriftError("cartola footer (SALDO INICIAL … SALDO FINAL) not found");
  const valueLine = lines.slice(labelIdx + 1).find((l) => l.trim().length > 0);
  if (!valueLine) throw new SchemaDriftError("cartola footer totals row not found");
  const tokens = valueLine.match(AMOUNT_RE) ?? [];
  if (tokens.length !== FOOTER_FIELDS.length) {
    throw new SchemaDriftError(
      `cartola footer expected ${FOOTER_FIELDS.length} totals, got ${tokens.length}`,
    );
  }
  const totals = {} as FooterTotals;
  FOOTER_FIELDS.forEach((field, i) => {
    totals[field] = parseBilledMonto(tokens[i] as string, "CLP");
  });
  return totals;
}

/**
 * Parse the extracted cartola text into posted checking CanonicalTxns, reconciling against the
 * footer totals. CARGO magnitudes become debits (negative), ABONO magnitudes credits (positive).
 * Throws SchemaDriftError if the parse does not reconcile exactly — the caller then discards this
 * statement (fail closed).
 */
export function parseCartolaText(text: string): CanonicalTxn[] {
  const lines = text.split("\n");
  const { desde, hasta } = parsePeriod(lines);
  const cols = parseColumns(lines);

  const txns: CanonicalTxn[] = [];
  let creditSum = Money.zero("CLP");
  let debitSum = Money.zero("CLP");

  for (let i = cols.headerIdx + 1; i < lines.length; i++) {
    const line = lines[i] as string;
    if (STOP_RE.test(line)) break; // Resumen de Comisiones repeats rows — stop before it
    const m = MOVEMENT_RE.exec(line);
    if (!m) continue;
    const amounts = scanAmounts(line, cols);
    let amount: Money;
    if (amounts.cargo) {
      amount = amounts.cargo.negate();
      debitSum = debitSum.add(amounts.cargo);
    } else if (amounts.abono) {
      amount = amounts.abono;
      creditSum = creditSum.add(amounts.abono);
    } else {
      continue; // a dated line with no movement magnitude — informational, skip
    }
    const rawDescription = stripSucursal(line.slice(6, cols.descEnd).replace(/\s+\d{4,}\s*$/, ""));
    txns.push({
      date: resolveRowDate(m[1] as string, m[2] as string, desde, hasta),
      amount,
      rawDescription,
      normDescription: normalizeDescription(rawDescription),
      status: "posted" as const,
      meta: amounts.saldo ? { runningBalance: amounts.saldo } : {},
    });
  }

  const totals = parseFooter(lines);
  const expectCredit = totals.depositos.add(totals.otrosAbonos);
  const expectDebit = totals.cheques.add(totals.otrosCargos).add(totals.impuestos);
  if (!creditSum.equals(expectCredit)) {
    throw new SchemaDriftError(
      `cartola did not reconcile: credits ${creditSum.toString()} != DEPOSITOS+OTROS ABONOS ` +
        `${expectCredit.toString()} (${txns.length} rows)`,
    );
  }
  if (!debitSum.equals(expectDebit)) {
    throw new SchemaDriftError(
      `cartola did not reconcile: debits ${debitSum.toString()} != ` +
        `CHEQUES+OTROS CARGOS+IMPUESTOS ${expectDebit.toString()}`,
    );
  }
  const computedFinal = totals.saldoInicial.add(creditSum).subtract(debitSum);
  if (!computedFinal.equals(totals.saldoFinal)) {
    throw new SchemaDriftError(
      `cartola did not reconcile: SALDO INICIAL + credits − debits ${computedFinal.toString()} ` +
        `!= SALDO FINAL ${totals.saldoFinal.toString()}`,
    );
  }
  return txns;
}

/** Drop the leading SUCURSAL token (branch name) from a description cell. */
function stripSucursal(descCell: string): string {
  return descCell
    .trim()
    .replace(/^\S+\s+/, "")
    .trim();
}

/** Format a 12-digit account number as the buzonVirtual `contrato` (`0-012-34-56789-0`). */
export function dashContract(accountNumber: string): string {
  const digits = accountNumber.replace(/\D/g, "");
  if (digits.length !== 12) {
    throw new SchemaDriftError(
      `cartola account number is not 12 digits: ${JSON.stringify(accountNumber)}`,
    );
  }
  return `${digits.slice(0, 1)}-${digits.slice(1, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 11)}-${digits.slice(11, 12)}`;
}
