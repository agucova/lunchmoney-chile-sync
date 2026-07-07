// USD (international) billed statement — the ONLY source is estadoDeCuenta, which returns the
// statement as a base64 PDF (there is no structured USD endpoint; estadoCuentaNacional is
// CLP-only). We decode the PDF, extract its text with `pdftotext -layout` (poppler), parse the
// transaction table, and — crucially — RECONCILE the parsed line items against the statement's
// own header totals before ingesting. A parse that doesn't reconcile is discarded (fail closed),
// so a future statement-layout change degrades to no-USD-billed rather than wrong money.
//
// Layout (pdftotext -layout), one row per international transaction:
//   FECHA(dd/mm/yy)  DESCRIPCIÓN  CIUDAD  PAÍS(2)  MONTO-MONEDA-ORIGEN  MONTO-US$
// The last column (MONTO US$) is the billed amount; purchases are positive, credits negative.
// A "TRASPASO DE DEUDA INTERNACIONAL" row is a balance mechanic (prior balance moved to the
// peso line), not a transaction — excluded. Reconciliation, both exact:
//   sum(purchases) == "TOTAL DE COMPRAS Y CARGOS"   and   sum(credits) == "ABONO REALIZADO".

import { spawn } from "node:child_process";
import { z } from "zod";
import { parseBankDate } from "../../core/dates.ts";
import { SchemaDriftError } from "../../core/errors.ts";
import type { CanonicalTxn } from "../../core/model.ts";
import { Money } from "../../core/money.ts";
import { normalizeDescription } from "../../core/normalize.ts";
import { parseChileanDisplayAmount } from "./amounts.ts";

// ---------------------------------------------------------------------------
// estadoDeCuenta response → PDF bytes
// ---------------------------------------------------------------------------

const StatementPdfSchema = z
  .object({
    METADATA: z.object({ STATUS: z.string(), DESCRIPCION: z.string() }).strict(),
    DATA: z
      .object({
        Informacion: z
          .object({ Codigo: z.string(), Resultado: z.string(), Mensaje: z.string() })
          .strict(),
        imgNbs64: z.string().min(1),
      })
      .strict(),
  })
  .strict();

/** Validate the estadoDeCuenta wrapper and decode its base64 PDF to bytes. */
export function extractStatementPdf(payload: unknown): Uint8Array {
  const parsed = StatementPdfSchema.safeParse(payload);
  if (!parsed.success) {
    throw new SchemaDriftError(
      `santander usd-statement payload failed validation: ${parsed.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    );
  }
  const { METADATA, DATA } = parsed.data;
  if (METADATA.STATUS !== "0") {
    throw new SchemaDriftError(
      `santander usd-statement STATUS ${METADATA.STATUS}: ${METADATA.DESCRIPCION}`,
    );
  }
  if (DATA.Informacion.Codigo !== "00") {
    throw new SchemaDriftError(
      `santander usd-statement Codigo ${DATA.Informacion.Codigo}: ${DATA.Informacion.Resultado}`,
    );
  }
  const bytes = Buffer.from(DATA.imgNbs64, "base64");
  if (bytes.length < 5 || bytes.subarray(0, 5).toString("latin1") !== "%PDF-") {
    throw new SchemaDriftError("santander usd-statement imgNbs64 is not a PDF");
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// PDF → text (pdftotext -layout, poppler)
// ---------------------------------------------------------------------------

const PDFTOTEXT_TIMEOUT_MS = 20_000;

/**
 * Extract text from a PDF with `pdftotext -layout` (reads stdin, writes stdout). The binary
 * comes from PATH (poppler; the Nix module adds poppler_utils), overridable via
 * SANTANDER_PDFTOTEXT. Throws SourceUnavailable-style errors as plain Error; the caller treats
 * a failure as "USD billed unavailable" (best-effort).
 */
export function extractPdfText(pdf: Uint8Array): Promise<string> {
  const bin = process.env["SANTANDER_PDFTOTEXT"] ?? "pdftotext";
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ["-layout", "-nopgbrk", "-", "-"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("pdftotext timed out"));
    }, PDFTOTEXT_TIMEOUT_MS);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error(`pdftotext not runnable (${bin}): ${e.message}`));
    });
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => err.push(d));
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(
          new Error(`pdftotext exited ${code}: ${Buffer.concat(err).toString().slice(0, 200)}`),
        );
        return;
      }
      resolve(Buffer.concat(out).toString("utf8"));
    });
    child.stdin.on("error", () => {}); // ignore EPIPE if the child died early
    child.stdin.end(Buffer.from(pdf));
  });
}

// ---------------------------------------------------------------------------
// Text → billed transactions (with reconciliation)
// ---------------------------------------------------------------------------

// A transaction row: date at the start; país (2 caps) + origin amount + MONTO US$ at the end;
// the greedy middle is description + city (which may contain "/", "*", digits).
const ROW_RE = /^(\d{2})\/(\d{2})\/(\d{2})\s+(.+)\s+[A-Z]{2}\s+-?[\d.]+,\d{2}\s+(-?[\d.]+,\d{2})$/;
const TRASPASO_RE = /traspaso\s+de\s+deuda/i;

/** Extract a header total like `TOTAL DE COMPRAS Y CARGOS   US$ -20,06` as signed USD Money. */
function headerTotal(text: string, label: string): Money {
  const re = new RegExp(
    `${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+US\\$\\s*(-?[\\d.]+,\\d{2})`,
  );
  const match = re.exec(text);
  if (!match?.[1]) throw new SchemaDriftError(`usd-statement missing total "${label}"`);
  return signedDisplayAmount(match[1]);
}

/** Parse a possibly-negative Chilean-display USD amount ("1.234,56" / "-20,06") to Money. */
function signedDisplayAmount(raw: string): Money {
  const negative = raw.startsWith("-");
  return parseChileanDisplayAmount(raw.replace(/^-/, ""), negative ? "D" : "H", "USD");
}

/**
 * Parse the extracted statement text into billed USD CanonicalTxns, reconciling against the
 * header totals. Purchases carry a positive MONTO US$ (→ negative/expense in canonical bank
 * sign); credits are negative (→ positive). Throws SchemaDriftError if the parse does not
 * reconcile exactly — the caller then discards the USD billed feed for this run.
 */
export function parseUsdStatementText(text: string): CanonicalTxn[] {
  const compras = headerTotal(text, "TOTAL DE COMPRAS Y CARGOS");
  const abono = headerTotal(text, "ABONO REALIZADO");

  const txns: CanonicalTxn[] = [];
  let purchaseSum = Money.zero("USD");
  let creditSum = Money.zero("USD");

  for (const line of text.split("\n")) {
    const match = ROW_RE.exec(line.trim());
    if (!match) continue;
    const [, dd, mm, yy, middle, montoUsdRaw] = match as unknown as [
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    if (TRASPASO_RE.test(middle)) continue; // balance transfer, not a transaction

    const montoUsd = signedDisplayAmount(montoUsdRaw); // + = purchase, − = credit
    if (montoUsd.isNegative) creditSum = creditSum.add(montoUsd);
    else purchaseSum = purchaseSum.add(montoUsd);

    // Merchant = the text before the run of spaces separating it from the city column.
    const rawDescription = (middle.split(/\s{2,}/)[0] ?? middle).trim();
    txns.push({
      date: parseBankDate(`${dd}/${mm}/20${yy}`, "dd/mm/yyyy"),
      amount: montoUsd.negate(), // bank sign: purchase = debit (negative)
      rawDescription,
      normDescription: normalizeDescription(rawDescription),
      status: "billed" as const,
      meta: {},
    });
  }

  if (!purchaseSum.equals(compras)) {
    throw new SchemaDriftError(
      `usd-statement did not reconcile: purchases ${purchaseSum.toString()} != ` +
        `TOTAL DE COMPRAS Y CARGOS ${compras.toString()} (${txns.length} rows parsed)`,
    );
  }
  if (!creditSum.equals(abono)) {
    throw new SchemaDriftError(
      `usd-statement did not reconcile: credits ${creditSum.toString()} != ABONO REALIZADO ${abono.toString()}`,
    );
  }
  return txns;
}
