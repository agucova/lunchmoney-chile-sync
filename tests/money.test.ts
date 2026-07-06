import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { CurrencyMismatchError, Money } from "../src/core/money.ts";
import { InvariantViolation } from "../src/core/errors.ts";

const minorUnits = fc.bigInt({ min: -(10n ** 15n), max: 10n ** 15n });

describe("Money", () => {
  test("decimal round-trip: CLP (exponent 0)", () => {
    fc.assert(
      fc.property(minorUnits, (minor) => {
        const money = Money.of(minor, "CLP");
        expect(Money.fromDecimalString(money.toDecimalString(), "CLP").minor).toBe(minor);
      }),
    );
  });

  test("decimal round-trip: USD (exponent 2)", () => {
    fc.assert(
      fc.property(minorUnits, (minor) => {
        const money = Money.of(minor, "USD");
        expect(Money.fromDecimalString(money.toDecimalString(), "USD").minor).toBe(minor);
      }),
    );
  });

  test("addition is commutative and zero is identity", () => {
    fc.assert(
      fc.property(minorUnits, minorUnits, (a, b) => {
        const ma = Money.of(a, "CLP");
        const mb = Money.of(b, "CLP");
        expect(ma.add(mb).minor).toBe(mb.add(ma).minor);
        expect(ma.add(Money.zero("CLP")).minor).toBe(a);
      }),
    );
  });

  test("cross-currency arithmetic throws", () => {
    const clp = Money.of(1000n, "CLP");
    const usd = Money.of(1000n, "USD");
    expect(() => clp.add(usd)).toThrow(CurrencyMismatchError);
    expect(() => clp.subtract(usd)).toThrow(CurrencyMismatchError);
    expect(() => clp.compare(usd)).toThrow(CurrencyMismatchError);
  });

  test("CLP rejects fractional amounts", () => {
    expect(() => Money.fromDecimalString("12.5", "CLP")).toThrow(InvariantViolation);
  });

  test("USD rejects more decimals than the exponent", () => {
    expect(() => Money.fromDecimalString("12.345", "USD")).toThrow(InvariantViolation);
  });

  test("fromMinorNumber rejects non-integers and unsafe integers", () => {
    expect(() => Money.fromMinorNumber(12.5, "CLP")).toThrow(InvariantViolation);
    expect(() => Money.fromMinorNumber(Number.MAX_SAFE_INTEGER + 1, "CLP")).toThrow(
      InvariantViolation,
    );
    expect(() => Money.fromMinorNumber(Number.NaN, "CLP")).toThrow(InvariantViolation);
  });

  test("known renderings", () => {
    expect(Money.of(-1234n, "CLP").toDecimalString()).toBe("-1234");
    expect(Money.of(-1234n, "USD").toDecimalString()).toBe("-12.34");
    expect(Money.of(5n, "USD").toDecimalString()).toBe("0.05");
    expect(Money.of(0n, "CLP").toDecimalString()).toBe("0");
    expect(Money.fromDecimalString("-12.5", "USD").minor).toBe(-1250n);
    expect(Money.fromDecimalString("7654321", "CLP").minor).toBe(7654321n);
  });

  test("JSON round-trip", () => {
    fc.assert(
      fc.property(minorUnits, (minor) => {
        const money = Money.of(minor, "USD");
        const back = Money.fromJSON(JSON.parse(JSON.stringify(money)));
        expect(back.equals(money)).toBe(true);
      }),
    );
  });

  test("parse rejects garbage", () => {
    for (const bad of ["", "12,34", "1e5", "12.34.56", "abc", "12 34", "--5"]) {
      expect(() => Money.fromDecimalString(bad, "USD")).toThrow(InvariantViolation);
    }
  });
});
