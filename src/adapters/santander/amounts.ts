// Santander amount parsing → exact BigInt Money, never through float.
//
// The API uses two distinct encodings, both observed live (docs/phase0-findings.md):
//
// 1. Chilean display strings (credit-card `Importe`): dot = thousands separator,
//    comma = decimal separator. Sign lives in a separate D/H field.
//      CLP "1.430.960" → 1 430 960 pesos;  USD "100,00" → 100.00;  USD "1.234,56".
//
// 2. Fixed-width centavos (checking `movementAmount`, inventory `MONTODISPONIBLE`):
//    an integer in hundredths with an optional trailing "-" for debit. CLP transaction
//    amounts are whole pesos (".00"); a CLP *balance* can carry centavos when an
//    international (USD) purchase settles to CLP, so balance fields round (parseCentavos
//    `subUnit`) while transaction amounts stay strict.
//      "000000532498500" → 5 324 985.00;  "00000250000000-" → −250 000.00.

import { CURRENCY_EXPONENT, type CurrencyCode, Money } from "../../core/money.ts";
import { SchemaDriftError } from "../../core/errors.ts";

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
  if (!CHILEAN_RE.test(trimmed)) {
    throw new SchemaDriftError(`unparseable Chilean amount: ${JSON.stringify(importe)}`);
  }
  const canonical = trimmed.replace(/\./g, "").replace(",", ".");
  const magnitude = decimalOrDrift(canonical, currency, importe);
  return flag === "D" ? magnitude.negate() : magnitude;
}

const CENTAVOS_RE = /^(\d+)(-?)$/;

/**
 * Parse a fixed-width centavos field (2 implied decimals, optional trailing "-").
 *
 * When the currency carries fewer than two decimals (CLP: whole pesos), how to treat a
 * non-zero fraction depends on WHAT the field is — hence `subUnit`:
 *   - "reject" (default): a fractional peso on a posted TRANSACTION is impossible, so it
 *     means the amount drifted (e.g. a foreign value misdenominated) — fail closed.
 *   - "round": a BALANCE snapshot legitimately gains centavos when an international (USD)
 *     purchase settles to CLP, and LM's CLP asset stores whole pesos anyway — round half-up
 *     to the currency's resolution instead of rejecting a real balance.
 */
export function parseCentavos(
  raw: string,
  currency: CurrencyCode,
  subUnit: "reject" | "round" = "reject",
): Money {
  const match = CENTAVOS_RE.exec(raw.trim());
  if (!match) throw new SchemaDriftError(`unparseable centavos field: ${JSON.stringify(raw)}`);
  const digits = match[1] as string;
  const negative = match[2] === "-";
  const padded = digits.padStart(3, "0"); // ensure ≥1 integer digit + 2 fractional
  const intPart = padded.slice(0, -2);
  const fracPart = padded.slice(-2);
  const exponent = CURRENCY_EXPONENT[currency];
  const canonical =
    exponent >= 2
      ? `${intPart}.${fracPart}`
      : collapseToExponent(intPart, fracPart, exponent, subUnit, raw);
  const magnitude = decimalOrDrift(canonical, currency, raw);
  return negative ? magnitude.negate() : magnitude;
}

/**
 * Collapse a 2-decimal centavos magnitude onto a currency with `exponent` decimals (CLP: 0).
 * An exact value (dropped digits all zero) passes through unchanged; a real fraction either
 * fails closed ("reject") or rounds half-up to the currency's resolution ("round"). Pure
 * BigInt arithmetic — the magnitude never touches a float.
 */
function collapseToExponent(
  intPart: string,
  fracPart: string,
  exponent: number,
  subUnit: "reject" | "round",
  raw: string,
): string {
  const drop = fracPart.slice(exponent);
  if (/^0*$/.test(drop)) {
    return exponent === 0 ? intPart : `${intPart}.${fracPart.slice(0, exponent)}`;
  }
  if (subUnit === "reject") {
    throw new SchemaDriftError(
      `centavos field has sub-unit precision for a ${exponent}-decimal currency: .${fracPart} ` +
        `(${JSON.stringify(raw)})`,
    );
  }
  // Round half-up to `exponent` decimals, working in hundredths (fracPart is exactly 2 digits).
  const hundredths = BigInt(intPart + fracPart);
  const divisor = 10n ** BigInt(2 - exponent);
  const rounded = (hundredths + divisor / 2n) / divisor; // value in units of 10^-exponent
  if (exponent === 0) return rounded.toString();
  const s = rounded.toString().padStart(exponent + 1, "0");
  return `${s.slice(0, -exponent)}.${s.slice(-exponent)}`;
}

const BILLED_MONTO_RE = /^\d+$/;

/**
 * Parse a billed-statement `MontoTxs` (estadoCuentaNacional) MAGNITUDE: a zero-padded integer
 * in the currency's MINOR units, optionally with dot thousands-separators and a trailing "-".
 * For CLP (exponent 0) that is whole pesos. This returns the unsigned magnitude — the sign is
 * the row's, decided by the caller (a trailing "-" marks a refund/credit; see parseBilledStatement).
 */
export function parseBilledMonto(raw: string, currency: CurrencyCode): Money {
  const cleaned = raw.trim().replace(/-$/, "").replace(/\./g, "");
  if (!BILLED_MONTO_RE.test(cleaned)) {
    throw new SchemaDriftError(`unparseable billed amount: ${JSON.stringify(raw)}`);
  }
  const value = Number(cleaned);
  if (!Number.isSafeInteger(value)) {
    throw new SchemaDriftError(`billed amount out of safe-integer range: ${JSON.stringify(raw)}`);
  }
  return Money.fromMinorNumber(value, currency);
}

/** Money construction re-thrown as drift: the offending input is bank data, not our bug. */
function decimalOrDrift(canonical: string, currency: CurrencyCode, raw: string): Money {
  try {
    return Money.fromDecimalString(canonical, currency);
  } catch (err) {
    throw new SchemaDriftError(
      `bank amount ${JSON.stringify(raw)} does not fit ${currency}: ${
        err instanceof Error ? err.message : String(err)
      }`,
      undefined,
      err,
    );
  }
}
