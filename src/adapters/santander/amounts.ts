// Santander amount parsing → exact BigInt Money, never through float.
//
// The API uses two distinct encodings, both observed live (docs/phase0-findings.md):
//
// 1. Chilean display strings (credit-card `Importe`): dot = thousands separator,
//    comma = decimal separator. Sign lives in a separate D/H field.
//      CLP "1.430.960" → 1 430 960 pesos;  USD "100,00" → 100.00;  USD "1.234,56".
//
// 2. Fixed-width centavos (checking `movementAmount`, inventory `MONTODISPONIBLE`):
//    an integer in hundredths with an optional trailing "-" for debit. CLP is encoded
//    with two implied decimals too, always ".00".
//      "000000532498500" → 5 324 985.00;  "00000250000000-" → −250 000.00.

import { CURRENCY_EXPONENT, type CurrencyCode, Money } from "../../core/money.ts";
import { invariant } from "../../core/errors.ts";

/** D = cargo (debit, negative), H = abono (credit, positive). */
export type DebitCreditFlag = "D" | "H";

const CHILEAN_RE = /^\d{1,3}(?:\.\d{3})*(?:,\d+)?$/;

/**
 * Parse a Chilean-formatted display amount (unsigned) plus a D/H flag into Money.
 * Normalizes to a canonical decimal string, then defers to Money for exact BigInt
 * construction (which rejects more decimals than the currency allows).
 */
export function parseChileanDisplayAmount(
  importe: string,
  flag: DebitCreditFlag,
  currency: CurrencyCode,
): Money {
  const trimmed = importe.trim();
  invariant(CHILEAN_RE.test(trimmed), `unparseable Chilean amount: ${JSON.stringify(importe)}`);
  const canonical = trimmed.replace(/\./g, "").replace(",", ".");
  const magnitude = Money.fromDecimalString(canonical, currency);
  return flag === "D" ? magnitude.negate() : magnitude;
}

const CENTAVOS_RE = /^(\d+)(-?)$/;

/**
 * Parse a fixed-width centavos field (2 implied decimals, optional trailing "-").
 * For currencies with fewer than 2 decimal places (CLP), the hundredths must be zero —
 * a non-zero fraction is schema drift (fractional pesos don't exist), not something to
 * silently round.
 */
export function parseCentavos(raw: string, currency: CurrencyCode): Money {
  const match = CENTAVOS_RE.exec(raw.trim());
  invariant(match, `unparseable centavos field: ${JSON.stringify(raw)}`);
  const digits = match[1] as string;
  const negative = match[2] === "-";
  const padded = digits.padStart(3, "0"); // ensure ≥1 integer digit + 2 fractional
  const intPart = padded.slice(0, -2);
  const fracPart = padded.slice(-2);
  const exponent = CURRENCY_EXPONENT[currency];
  const canonical =
    exponent >= 2 ? `${intPart}.${fracPart}` : mergeToExponent(intPart, fracPart, exponent);
  const magnitude = Money.fromDecimalString(canonical, currency);
  return negative ? magnitude.negate() : magnitude;
}

/** Collapse 2-decimal centavos onto a lower-exponent currency, asserting no loss. */
function mergeToExponent(intPart: string, fracPart: string, exponent: number): string {
  const keep = fracPart.slice(0, exponent);
  const drop = fracPart.slice(exponent);
  invariant(
    /^0*$/.test(drop),
    `centavos field has sub-unit precision for a ${exponent}-decimal currency: .${fracPart}`,
  );
  return exponent === 0 ? intPart : `${intPart}.${keep}`;
}
