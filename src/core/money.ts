// Money as an immutable BigInt value object. Amounts never pass through float
// arithmetic: construction is from integers or decimal strings only, and arithmetic is
// same-currency-only (mixing currencies throws, mixing BigInt with number throws by
// construction).

import { InvariantViolation, invariant } from "./errors.ts";

/** ISO 4217 codes we handle. Extend the registry when a new currency appears. */
export const CURRENCY_EXPONENT = {
  CLP: 0, // whole pesos — the v1 lesson: never divide by 100
  USD: 2,
  GBP: 2,
  EUR: 2,
} as const;

export type CurrencyCode = keyof typeof CURRENCY_EXPONENT;

export function isCurrencyCode(value: string): value is CurrencyCode {
  return value in CURRENCY_EXPONENT;
}

export class CurrencyMismatchError extends InvariantViolation {}

const DECIMAL_RE = /^([+-]?)(\d+)(?:\.(\d+))?$/;

export class Money {
  private constructor(
    /** Amount in minor units (CLP: pesos; USD/GBP: cents). */
    readonly minor: bigint,
    readonly currency: CurrencyCode,
  ) {
    Object.freeze(this);
  }

  static of(minor: bigint, currency: CurrencyCode): Money {
    invariant(typeof minor === "bigint", "Money.of requires a bigint");
    return new Money(minor, currency);
  }

  static zero(currency: CurrencyCode): Money {
    return new Money(0n, currency);
  }

  /**
   * From an integer `number` that represents WHOLE minor units (e.g. scraper CLP
   * amounts). Rejects non-integers outright — a decimal here means a parser upstream
   * should have used fromDecimalString.
   */
  static fromMinorNumber(value: number, currency: CurrencyCode): Money {
    invariant(
      Number.isSafeInteger(value),
      `Money.fromMinorNumber requires a safe integer, got ${value}`,
    );
    return new Money(BigInt(value), currency);
  }

  /**
   * From a decimal string like "-1234.56". The fractional part must not exceed the
   * currency's exponent ("12.5" is fine for USD → 1250¢, an error for CLP).
   */
  static fromDecimalString(value: string, currency: CurrencyCode): Money {
    const match = DECIMAL_RE.exec(value.trim());
    invariant(match, `unparseable decimal amount: ${JSON.stringify(value)}`);
    const [, sign, intPart = "", fracPart = ""] = match;
    const exponent = CURRENCY_EXPONENT[currency];
    invariant(
      fracPart.length <= exponent,
      `${currency} allows ${exponent} decimal places, got ${JSON.stringify(value)}`,
    );
    const minorDigits = intPart + fracPart.padEnd(exponent, "0");
    const minor = BigInt(minorDigits);
    return new Money(sign === "-" ? -minor : minor, currency);
  }

  private assertSameCurrency(other: Money, operation: string): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(`cannot ${operation} ${this.currency} and ${other.currency}`);
    }
  }

  add(other: Money): Money {
    this.assertSameCurrency(other, "add");
    return new Money(this.minor + other.minor, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other, "subtract");
    return new Money(this.minor - other.minor, this.currency);
  }

  negate(): Money {
    return new Money(-this.minor, this.currency);
  }

  abs(): Money {
    return this.minor < 0n ? this.negate() : this;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.minor === other.minor;
  }

  /** -1 | 0 | 1; throws on cross-currency comparison. */
  compare(other: Money): -1 | 0 | 1 {
    this.assertSameCurrency(other, "compare");
    if (this.minor < other.minor) return -1;
    if (this.minor > other.minor) return 1;
    return 0;
  }

  get isNegative(): boolean {
    return this.minor < 0n;
  }

  get isZero(): boolean {
    return this.minor === 0n;
  }

  /** Canonical decimal rendering: "-1234" (CLP), "-12.34" (USD). For the LM API. */
  toDecimalString(): string {
    const exponent = CURRENCY_EXPONENT[this.currency];
    const sign = this.minor < 0n ? "-" : "";
    const digits = (this.minor < 0n ? -this.minor : this.minor).toString();
    if (exponent === 0) return sign + digits;
    const padded = digits.padStart(exponent + 1, "0");
    const intPart = padded.slice(0, -exponent);
    const fracPart = padded.slice(-exponent);
    return `${sign}${intPart}.${fracPart}`;
  }

  /** JSON-safe: BigInt serialized as string. */
  toJSON(): { minor: string; currency: CurrencyCode } {
    return { minor: this.minor.toString(), currency: this.currency };
  }

  static fromJSON(value: { minor: string; currency: string }): Money {
    invariant(isCurrencyCode(value.currency), `unknown currency: ${value.currency}`);
    invariant(/^-?\d+$/.test(value.minor), `invalid minor units: ${value.minor}`);
    return new Money(BigInt(value.minor), value.currency);
  }

  toString(): string {
    return `${this.toDecimalString()} ${this.currency}`;
  }
}
