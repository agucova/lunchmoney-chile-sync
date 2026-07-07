// Fail-closed parsing of Santander's native JSON API payloads into canonical shapes.
//
// Every shape here was OBSERVED in the 2026-07 HAR capture (docs/phase0-findings.md) and
// is encoded deliberately narrowly: anything outside this grammar is SchemaDrift, and the
// whole batch is rejected rather than guessed at.
//
// - Product inventory (`cruceProductosOnline`): one MATRIZCAPTACIONES array covering
//   checking accounts (AGRUPACIONCOMERCIAL "CCC"), the credit line ("LCR") and credit-card
//   currency legs ("TCR", same contract once per currency). Amounts are fixed-width
//   centavos strings.
// - Checking transactions (openbanking `current-accounts/transactions`): ISO dates,
//   fixed-width centavos amounts with trailing "-" for debits, D/H flag. The payee-bearing
//   field is `observation`; `expandedCode` is the generic movement type. Empty windows
//   arrive either as code-ms "00" without a movements array or as code-ms "BGE0071"
//   "NO EXISTEN DATOS".
// - Card movements (`consultaUltimosMovimientos`): dd/mm/yyyy dates, Chilean display
//   amounts (CLP dot-thousands / USD comma-decimals), D/H in IndicadorDebeHaber, merchant
//   in `Comercio` falling back to `Descripcion`. A "SALDO INICIAL" carry-over row opens
//   the list and is not a transaction.
//
// Description composition deliberately MIRRORS the open-banking-chile normalizers
// (observation || expandedCode; Comercio || Descripcion): identities minted during the
// OBC era must keep matching within their buckets after the cutover.

import { z } from "zod";
import { type IsoDate, parseBankDate } from "../../core/dates.ts";
import { SchemaDriftError } from "../../core/errors.ts";
import type { CanonicalTxn } from "../../core/model.ts";
import { type CurrencyCode, isCurrencyCode, type Money } from "../../core/money.ts";
import { normalizeDescription } from "../../core/normalize.ts";
import { parseBilledMonto, parseCentavos, parseChileanDisplayAmount } from "./amounts.ts";

function driftFromZod(label: string, error: z.ZodError): SchemaDriftError {
  return new SchemaDriftError(
    `santander ${label} payload failed validation: ${error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ")}`,
  );
}

// ---------------------------------------------------------------------------
// Product inventory (POST /perdsk/datosCliente/cruceProductosOnline)
// ---------------------------------------------------------------------------

const MetadataSchema = z.object({ STATUS: z.string(), DESCRIPCION: z.string() }).strict();

const InventoryEntrySchema = z
  .object({
    NUMEROCONTRATO: z.string().regex(/^\d{12}$/),
    PRODUCTO: z.string(),
    SUBPRODUCTO: z.string(),
    MONTODISPONIBLE: z.string(),
    MONTOUTILIZADO: z.string(),
    GLOSACORTA: z.string(),
    OFICINACONTRATO: z.string().regex(/^\d{4}$/),
    CUPO: z.string(),
    GLOSAESTADO: z.string(),
    NUMEROPAN: z.string().nullish(),
    ESTADOOPERACION: z.string(),
    ESTADORELACION: z.string(),
    CODIGOMONEDA: z.string(),
    AGRUPACIONCOMERCIAL: z.string(),
    CALIDADPARTICIPACION: z.string(),
  })
  .strict();

const InventorySchema = z
  .object({
    METADATA: MetadataSchema,
    DATA: z
      .object({
        OUTPUT: z
          .object({
            INFO: z
              .object({ CODERR: z.string(), DESERR: z.string(), MSGUSUARIO: z.string() })
              .strict(),
            // Client metadata (name, segment, …) — never feeds the ledger, so drift
            // inside it cannot corrupt money data and is deliberately not policed.
            ESCALARES: z.unknown(),
            MATRICES: z
              .object({
                // Only "e1" observed; declared as a keyed record in case the matrix
                // ever paginates (e2, …) — pages are concatenated in key order.
                MATRIZCAPTACIONES: z.record(
                  z.string().regex(/^e\d+$/),
                  z.array(InventoryEntrySchema),
                ),
              })
              .strict(),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();

/** Product groupings observed in MATRIZCAPTACIONES. */
export type SantanderProductGroup = "CCC" | "LCR" | "TCR";

const PRODUCT_GROUPS: readonly SantanderProductGroup[] = ["CCC", "LCR", "TCR"];

export interface SantanderProduct {
  /** 12-digit contract number; checking accountId = office + contract. */
  readonly contract: string;
  /** 4-digit branch office code ("Centro" in card requests). */
  readonly office: string;
  readonly glosa: string;
  readonly group: SantanderProductGroup;
  readonly currency: CurrencyCode;
  readonly available: Money;
  readonly used: Money;
  readonly cupo: Money;
}

/**
 * Parse the product inventory into typed products. Fails closed on unknown product
 * groups, currencies or states — a new product appearing at the bank should be a loud
 * event, not a silently mis-classified one.
 */
export function parseInventory(payload: unknown): SantanderProduct[] {
  const parsed = InventorySchema.safeParse(payload);
  if (!parsed.success) throw driftFromZod("inventory", parsed.error);
  const { METADATA, DATA } = parsed.data;
  if (METADATA.STATUS !== "0") {
    throw new SchemaDriftError(
      `santander inventory returned STATUS ${METADATA.STATUS}: ${METADATA.DESCRIPCION}`,
    );
  }
  if (DATA.OUTPUT.INFO.CODERR !== "00") {
    throw new SchemaDriftError(
      `santander inventory returned CODERR ${DATA.OUTPUT.INFO.CODERR}: ${DATA.OUTPUT.INFO.DESERR}`,
    );
  }

  const pages = DATA.OUTPUT.MATRICES.MATRIZCAPTACIONES;
  const entries = Object.keys(pages)
    .sort()
    .flatMap((key) => pages[key] ?? []);
  if (entries.length === 0) {
    throw new SchemaDriftError("santander inventory contained no products");
  }

  return entries.map((entry) => {
    const group = entry.AGRUPACIONCOMERCIAL;
    if (!(PRODUCT_GROUPS as readonly string[]).includes(group)) {
      throw new SchemaDriftError(
        `santander inventory has unknown product group ${JSON.stringify(group)} ` +
          `(${entry.GLOSACORTA})`,
      );
    }
    if (!isCurrencyCode(entry.CODIGOMONEDA)) {
      throw new SchemaDriftError(
        `santander inventory has unknown currency ${JSON.stringify(entry.CODIGOMONEDA)} ` +
          `(${entry.GLOSACORTA})`,
      );
    }
    if (entry.ESTADOOPERACION !== "A") {
      throw new SchemaDriftError(
        `santander product ${entry.GLOSACORTA} in unobserved state ` +
          `ESTADOOPERACION=${JSON.stringify(entry.ESTADOOPERACION)}`,
      );
    }
    const currency = entry.CODIGOMONEDA;
    return {
      contract: entry.NUMEROCONTRATO,
      office: entry.OFICINACONTRATO,
      glosa: entry.GLOSACORTA.trim(),
      group: group as SantanderProductGroup,
      currency,
      available: parseCentavos(entry.MONTODISPONIBLE, currency),
      used: parseCentavos(entry.MONTOUTILIZADO, currency),
      cupo: parseCentavos(entry.CUPO, currency),
    };
  });
}

// ---------------------------------------------------------------------------
// Checking transactions (POST openbanking …/current-accounts/transactions)
// ---------------------------------------------------------------------------

const CheckingMovementSchema = z
  .object({
    accountingDate: z.string(),
    transactionDate: z.string(),
    operationTime: z.string(),
    newBalance: z.string(),
    codeOperationMovement: z.string(),
    movementAmount: z.string(),
    observation: z.string(),
    expandedCode: z.string(),
    movementNumber: z.string(),
    chargePaymentFlag: z.enum(["D", "H"]),
  })
  .strict();

const CheckingResponseSchema = z
  .object({
    additionalInfo: z.array(z.object({ key: z.string(), value: z.string() }).strict()),
    movements: z.array(CheckingMovementSchema).optional(),
  })
  .strict();

/** The service's "empty window" signal — observed on the (dormant) USD account. */
const CHECKING_NO_DATA_CODE = "BGE0071";

/**
 * Parse a checking-transactions response into posted CanonicalTxns.
 * The response carries no currency marker; the caller declares the currency it
 * requested and amounts are parsed against it (CLP asserts whole-peso hundredths).
 */
export function parseCheckingTransactions(
  payload: unknown,
  currency: CurrencyCode,
): CanonicalTxn[] {
  const parsed = CheckingResponseSchema.safeParse(payload);
  if (!parsed.success) throw driftFromZod("checking", parsed.error);
  const info = new Map(parsed.data.additionalInfo.map(({ key, value }) => [key, value]));
  const code = info.get("code-ms");
  const message = info.get("message-ms") ?? "";

  if (code === CHECKING_NO_DATA_CODE && message === "NO EXISTEN DATOS") {
    if (parsed.data.movements !== undefined) {
      throw new SchemaDriftError("santander checking: NO EXISTEN DATOS but movements present");
    }
    return [];
  }
  if (code !== "00") {
    throw new SchemaDriftError(
      `santander checking returned code-ms ${JSON.stringify(code)}: ${message}`,
    );
  }

  return (parsed.data.movements ?? []).map((movement) => {
    const amount = parseCentavos(movement.movementAmount, currency);
    // Observed invariant: the D/H flag and the trailing "-" always agree. Disagreement
    // means the sign encoding drifted and every amount is suspect.
    const isDebit = movement.chargePaymentFlag === "D";
    if (isDebit !== amount.isNegative && !amount.isZero) {
      throw new SchemaDriftError(
        `santander checking movement sign mismatch: flag=${movement.chargePaymentFlag} ` +
          `amount=${JSON.stringify(movement.movementAmount)}`,
      );
    }
    const rawDescription = movement.observation.trim() || movement.expandedCode.trim();
    const runningBalance = parseCentavos(movement.newBalance, currency);
    return {
      date: parseBankDate(movement.transactionDate, "iso"),
      amount,
      rawDescription,
      normDescription: normalizeDescription(rawDescription),
      status: "posted" as const,
      meta: runningBalance.isZero ? {} : { runningBalance },
    };
  });
}

// ---------------------------------------------------------------------------
// Card movements (POST /perdsk/tarjetasDeCredito/consultaUltimosMovimientos)
// ---------------------------------------------------------------------------

const CardMovementSchema = z
  .object({
    Fecha: z.string(),
    Descripcion: z.string(),
    Comercio: z.string().nullable(),
    Importe: z.string(),
    DescripcionRubro: z.string().nullable(),
    Ciudad: z.string().nullable(),
    TipoBen: z.string().nullable(),
    IndicadorDebeHaber: z.enum(["D", "H"]),
  })
  .strict();

const CardResponseSchema = z
  .object({
    METADATA: MetadataSchema,
    DATA: z
      .object({
        Informacion: z
          .object({ Codigo: z.string(), Resultado: z.string(), Mensaje: z.string() })
          .strict(),
        MatrizMovimientos: z.array(CardMovementSchema),
      })
      .strict(),
  })
  .strict();

/** Balance carry-over pseudo-row, not a transaction (same rule as open-banking-chile). */
const SALDO_INICIAL_RE = /saldo\s+inicial/i;

// ---------------------------------------------------------------------------
// Card statement list (POST /perdsk/tarjetasDeCredito/cuentasDisponibles)
// ---------------------------------------------------------------------------

/** ISO-4217 numeric codes the card statements use. */
const STATEMENT_CURRENCY: Record<string, CurrencyCode> = { "152": "CLP", "840": "USD" };

const StatementEntrySchema = z
  .object({
    CODENT: z.string(),
    CENTALT: z.string(),
    CUENTA: z.string(),
    NUMEXT: z.string().regex(/^\d+$/),
    FECHAEXT: z.string(),
    MONEDA: z.string(),
    PRODUCTO: z.string(),
    SUBPRODUSTO: z.string(),
    TipoEECC: z.string(),
  })
  .strict();

const StatementListSchema = z
  .object({
    METADATA: MetadataSchema,
    DATA: z.record(
      z.string().regex(/^AS_TIB_WM\d+_CONCuentasDisponibles$/),
      z
        .object({
          OUTPUT: z
            .object({
              INFO: z
                .object({ CODERR: z.string(), DESERR: z.string(), MSGUSUARIO: z.string() })
                .strict(),
              MATRIZ: z.array(StatementEntrySchema),
            })
            .strict(),
        })
        .strict(),
    ),
  })
  .strict();

/** One available billed statement for a card, in a specific currency. */
export interface CardStatement {
  /** Statement number, passed as NumExtracto to estadoCuentaNacional. */
  readonly numExtracto: string;
  /** Statement close date (ISO). */
  readonly fecha: IsoDate;
  readonly currency: CurrencyCode;
}

/**
 * Parse the available-statements list. Only "N" (nacional) statements are returned — the type
 * the estadoCuentaNacional endpoint serves. Unknown currency codes are drift. Entries are
 * newest-first as the bank returns them.
 */
export function parseCardStatements(payload: unknown): CardStatement[] {
  const parsed = StatementListSchema.safeParse(payload);
  if (!parsed.success) throw driftFromZod("card-statements", parsed.error);
  const { METADATA, DATA } = parsed.data;
  if (METADATA.STATUS !== "0") {
    throw new SchemaDriftError(
      `santander card-statements returned STATUS ${METADATA.STATUS}: ${METADATA.DESCRIPCION}`,
    );
  }
  const wrapper = Object.values(DATA)[0];
  if (!wrapper) throw new SchemaDriftError("santander card-statements: empty DATA");
  if (wrapper.OUTPUT.INFO.CODERR !== "00") {
    throw new SchemaDriftError(
      `santander card-statements CODERR ${wrapper.OUTPUT.INFO.CODERR}: ${wrapper.OUTPUT.INFO.DESERR}`,
    );
  }
  return wrapper.OUTPUT.MATRIZ.filter((entry) => entry.TipoEECC === "N").map((entry) => {
    const currency = STATEMENT_CURRENCY[entry.MONEDA];
    if (!currency) {
      throw new SchemaDriftError(
        `santander card-statements: unknown MONEDA ${JSON.stringify(entry.MONEDA)}`,
      );
    }
    return { numExtracto: entry.NUMEXT, fecha: parseBankDate(entry.FECHAEXT, "iso"), currency };
  });
}

// ---------------------------------------------------------------------------
// Billed statement (POST /perdsk/tarjetasDeCredito/estadoCuentaNacional)
// ---------------------------------------------------------------------------

const BilledMovementSchema = z
  .object({
    Pan: z.string(),
    SegmentoTxs: z.string(),
    CodComercio: z.string(),
    RutComercio: z.string(),
    RubroComercio: z.string(),
    NombreComercio: z.string(),
    TipoTxs: z.string(),
    CodTxs: z.string(),
    FechaTxs: z.string(),
    MontoTxs: z.string(),
    NumeroCuotas: z.string(),
    TotalCuotas: z.string(),
    TasaCompraCuotas: z.string(),
    TipoCuota: z.string(),
    MontoCuota: z.string(),
    Microfilm: z.string(),
    Glosa1: z.string(),
    Glosa2: z.string(),
    Ciudad: z.string(),
    GlosaRubroCom: z.string(),
  })
  .strict();

const BilledStatementSchema = z
  .object({
    METADATA: MetadataSchema,
    DATA: z
      .object({
        AS_TIB_WM02_CONEstCtaNacional_Response: z
          .object({
            INFO: z
              .object({ CODERR: z.string(), DESERR: z.string(), MSGUSUARIO: z.string() })
              .strict(),
            OUTPUT: z
              .object({
                // Statement header (cupo, due date, totals, …); metadata we don't ingest, so
                // drift inside it can't corrupt money data — deliberately not policed.
                RESPUESTA: z.unknown(),
                Matriz: z.array(BilledMovementSchema),
              })
              .strict(),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();

/** A card payment credit row, by the marker open-banking-chile uses. */
const MONTO_CANCELADO_RE = /monto\s+cancelado/i;

/**
 * Parse a billed statement into billed CanonicalTxns. `MontoTxs` carries the magnitude; a row is
 * a CREDIT (positive at the bank) when either its amount has a trailing "-" (a refund/reversal —
 * verified: charges − trailing-dash rows == statement TotalCompras) or its name is "MONTO
 * CANCELADO" (a payment); otherwise it's a purchase (debit, negative). Descriptions mirror the
 * open-banking-chile normalizer so identities minted from the unbilled feed transition rather
 * than duplicate. Installments come from NumeroCuotas/TotalCuotas.
 */
export function parseBilledStatement(payload: unknown, currency: CurrencyCode): CanonicalTxn[] {
  const parsed = BilledStatementSchema.safeParse(payload);
  if (!parsed.success) throw driftFromZod("billed-statement", parsed.error);
  const { METADATA, DATA } = parsed.data;
  if (METADATA.STATUS !== "0") {
    throw new SchemaDriftError(
      `santander billed-statement returned STATUS ${METADATA.STATUS}: ${METADATA.DESCRIPCION}`,
    );
  }
  const response = DATA.AS_TIB_WM02_CONEstCtaNacional_Response;
  if (response.INFO.CODERR !== "00") {
    throw new SchemaDriftError(
      `santander billed-statement CODERR ${response.INFO.CODERR}: ${response.INFO.DESERR}`,
    );
  }

  const txns: CanonicalTxn[] = [];
  for (const movement of response.OUTPUT.Matriz) {
    const rawDescription = movement.NombreComercio.trim();
    if (SALDO_INICIAL_RE.test(rawDescription)) continue;
    const magnitude = parseBilledMonto(movement.MontoTxs, currency);
    const isCredit =
      movement.MontoTxs.trim().endsWith("-") || MONTO_CANCELADO_RE.test(rawDescription);
    const amount = isCredit ? magnitude : magnitude.negate();
    const installments = billedInstallments(movement.NumeroCuotas, movement.TotalCuotas);
    txns.push({
      date: parseBankDate(movement.FechaTxs, "iso"),
      amount,
      rawDescription,
      normDescription: normalizeDescription(rawDescription),
      status: "billed" as const,
      meta: installments ? { installments } : {},
    });
  }
  return txns;
}

/** "08"/"12" → "08/12"; a zero total means a single-payment purchase (no installments). */
function billedInstallments(numeroCuotas: string, totalCuotas: string): string | undefined {
  const total = Number.parseInt(totalCuotas, 10);
  if (!Number.isFinite(total) || total <= 0) return undefined;
  const current = Number.parseInt(numeroCuotas, 10) || 0;
  return `${String(current).padStart(2, "0")}/${String(total).padStart(2, "0")}`;
}

/**
 * Parse a card últimos-movimientos response into unbilled CanonicalTxns for one
 * currency leg. The feed is a rolling recent-movements window, so around statement
 * close it may include already-billed purchases — the identity ledger's cross-status
 * dedupe and billed-transition passes are built for exactly that overlap.
 */
export function parseCardMovements(payload: unknown, currency: CurrencyCode): CanonicalTxn[] {
  const parsed = CardResponseSchema.safeParse(payload);
  if (!parsed.success) throw driftFromZod("card", parsed.error);
  const { METADATA, DATA } = parsed.data;
  if (METADATA.STATUS !== "0") {
    throw new SchemaDriftError(
      `santander card returned STATUS ${METADATA.STATUS}: ${METADATA.DESCRIPCION}`,
    );
  }
  if (DATA.Informacion.Codigo !== "00") {
    throw new SchemaDriftError(
      `santander card returned Codigo ${DATA.Informacion.Codigo}: ${DATA.Informacion.Resultado}`,
    );
  }

  const txns: CanonicalTxn[] = [];
  for (const movement of DATA.MatrizMovimientos) {
    const rawDescription = movement.Comercio?.trim() || movement.Descripcion.trim();
    if (SALDO_INICIAL_RE.test(rawDescription)) continue;
    txns.push({
      date: parseBankDate(movement.Fecha, "dd/mm/yyyy"),
      amount: parseChileanDisplayAmount(movement.Importe, movement.IndicadorDebeHaber, currency),
      rawDescription,
      normDescription: normalizeDescription(rawDescription),
      status: "unbilled" as const,
      meta: {},
    });
  }
  return txns;
}
