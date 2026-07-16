// Amount-parsing exactness for the Santander adapter. Example cases are real strings
// from the live HAR capture; properties assert no float path and exact round-trips.
import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { SchemaDriftError } from "../src/core/errors.ts";
import {
  parseBilledMonto,
  parseCentavos,
  parseChileanDisplayAmount,
} from "../src/adapters/santander/amounts.ts";

describe("parseChileanDisplayAmount (card Importe)", () => {
  test("CLP: dot is a thousands separator, no decimals", () => {
    expect(parseChileanDisplayAmount("1.430.960", "D", "CLP").minor).toBe(-1430960n);
    expect(parseChileanDisplayAmount("11.994", "D", "CLP").minor).toBe(-11994n);
    expect(parseChileanDisplayAmount("10.832", "H", "CLP").minor).toBe(10832n);
    expect(parseChileanDisplayAmount("990", "D", "CLP").minor).toBe(-990n);
  });

  test("USD: comma is the decimal separator → exact cents", () => {
    expect(parseChileanDisplayAmount("100,00", "D", "USD").minor).toBe(-10000n);
    expect(parseChileanDisplayAmount("10,80", "D", "USD").minor).toBe(-1080n);
    expect(parseChileanDisplayAmount("16,32", "D", "USD").minor).toBe(-1632n);
    expect(parseChileanDisplayAmount("1.234,56", "D", "USD").minor).toBe(-123456n);
  });

  test("CLP rejects a fractional (comma) amount — pesos have no cents", () => {
    expect(() => parseChileanDisplayAmount("10,80", "D", "CLP")).toThrow(SchemaDriftError);
  });

  test("garbage is rejected, not coerced", () => {
    for (const bad of ["", "1,2,3", "1.99.9", "abc", "10.80", "-5"]) {
      expect(() => parseChileanDisplayAmount(bad, "D", "USD")).toThrow(SchemaDriftError);
    }
  });
});

describe("parseCentavos (checking movementAmount / balances)", () => {
  test("CLP: 2 implied decimals, always .00, trailing - = debit", () => {
    expect(parseCentavos("000000532498500", "CLP").minor).toBe(5324985n);
    expect(parseCentavos("00000250000000-", "CLP").minor).toBe(-2500000n);
    expect(parseCentavos("000000608261400", "CLP").minor).toBe(6082614n);
    expect(parseCentavos("000000000000000000", "CLP").minor).toBe(0n);
  });

  test("USD: same encoding maps straight to cents", () => {
    expect(parseCentavos("000000000000264335", "USD").minor).toBe(264335n);
    expect(parseCentavos("00000000000010080-", "USD").minor).toBe(-10080n);
  });

  test("a CLP centavos field with non-zero cents is schema drift (strict is the default)", () => {
    expect(() => parseCentavos("000000000000000150", "CLP")).toThrow(SchemaDriftError);
    expect(() => parseCentavos("000000000000000150", "CLP", "reject")).toThrow(SchemaDriftError);
  });

  test('subUnit "round": a CLP BALANCE with FX centavos rounds half-up to whole pesos', () => {
    // The real drift that broke a sync: a CLP card MONTOUTILIZADO of 5.031.890,20.
    expect(parseCentavos("000000000503189020", "CLP", "round").minor).toBe(5031890n); // .20 → down
    expect(parseCentavos("000000000503189088", "CLP", "round").minor).toBe(5031891n); // .88 → up
    expect(parseCentavos("000000000000000150", "CLP", "round").minor).toBe(2n); // .50 → half-up
    expect(parseCentavos("000000000000000149", "CLP", "round").minor).toBe(1n); // .49 → down
    expect(parseCentavos("00000250000020-", "CLP", "round").minor).toBe(-2500000n); // sign kept
    expect(parseCentavos("000000532498500", "CLP", "round").minor).toBe(5324985n); // exact, no rounding
  });

  test('subUnit "round" leaves 2-decimal currencies (USD) untouched', () => {
    expect(parseCentavos("000000000000264335", "USD", "round").minor).toBe(264335n);
  });

  test("property: CLP centavos round-trips digits/100 exactly, no float", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 10n ** 12n }), fc.boolean(), (pesos, debit) => {
        const raw = `${(pesos * 100n).toString().padStart(6, "0")}${debit ? "-" : ""}`;
        const money = parseCentavos(raw, "CLP");
        expect(money.minor).toBe(debit ? -pesos : pesos);
      }),
    );
  });

  test("property: USD cents preserved exactly across the centavos encoding", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 10n ** 10n }), (cents) => {
        const raw = cents.toString().padStart(6, "0");
        expect(parseCentavos(raw, "USD").minor).toBe(cents);
      }),
    );
  });
});

describe("parseBilledMonto (statement MontoTxs)", () => {
  test("CLP: zero-padded integer is whole pesos (minor units), unsigned", () => {
    expect(parseBilledMonto("0000007016", "CLP").minor).toBe(7016n);
    expect(parseBilledMonto("0010000000", "CLP").minor).toBe(10000000n);
    expect(parseBilledMonto("0000000000", "CLP").minor).toBe(0n);
  });

  test("dot thousands-separators are stripped", () => {
    expect(parseBilledMonto("1.430.960", "CLP").minor).toBe(1430960n);
  });

  test("a trailing '-' (refund marker) yields the magnitude — sign is the caller's", () => {
    expect(parseBilledMonto("000014293-", "CLP").minor).toBe(14293n);
    expect(parseBilledMonto("1.430.960-", "CLP").minor).toBe(1430960n);
  });

  test("garbage or a mid-string sign is drift, not coerced", () => {
    for (const bad of ["", "-500", "12a", "1,50", "12-34"]) {
      expect(() => parseBilledMonto(bad, "CLP")).toThrow(SchemaDriftError);
    }
  });
});
