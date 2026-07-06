import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import {
  assertIsoDate,
  assertPlausibleDates,
  daysBetween,
  parseBankDate,
  todayInSantiago,
} from "../src/core/dates.ts";
import { SchemaDriftError } from "../src/core/errors.ts";

describe("parseBankDate", () => {
  test("declared formats parse; the other format is rejected (format flips fail loudly)", () => {
    expect(String(parseBankDate("2026-06-21", "iso"))).toBe("2026-06-21");
    expect(String(parseBankDate("05-07-2026", "dd-mm-yyyy"))).toBe("2026-07-05");
    // A dd-mm value in a declared-ISO context must throw, and vice versa.
    expect(() => parseBankDate("05-07-2026", "iso")).toThrow(SchemaDriftError);
    expect(() => parseBankDate("2026-07-05", "dd-mm-yyyy")).toThrow(SchemaDriftError);
  });

  test("impossible calendar dates are rejected in both formats", () => {
    expect(() => parseBankDate("2026-02-30", "iso")).toThrow(SchemaDriftError);
    expect(() => parseBankDate("31-02-2026", "dd-mm-yyyy")).toThrow(SchemaDriftError);
    expect(() => parseBankDate("2026-13-01", "iso")).toThrow(SchemaDriftError);
    expect(() => parseBankDate("00-06-2026", "dd-mm-yyyy")).toThrow(SchemaDriftError);
  });

  test("dd-mm-yyyy ↔ iso round-trip property", () => {
    const dateArb = fc
      .date({
        min: new Date("2000-01-01T00:00:00Z"),
        max: new Date("2099-12-31T00:00:00Z"),
        noInvalidDate: true,
      })
      .map((d) => {
        const yyyy = d.getUTCFullYear();
        const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
        const dd = String(d.getUTCDate()).padStart(2, "0");
        return { iso: `${yyyy}-${mm}-${dd}`, ddmm: `${dd}-${mm}-${yyyy}` };
      });
    fc.assert(
      fc.property(dateArb, ({ iso, ddmm }) => {
        expect(String(parseBankDate(ddmm, "dd-mm-yyyy"))).toBe(iso);
        expect(String(parseBankDate(iso, "iso"))).toBe(iso);
      }),
    );
  });
});

describe("plausibility window", () => {
  const today = assertIsoDate("2026-07-06");

  test("accepts recent past and near future", () => {
    assertPlausibleDates(
      [assertIsoDate("2026-07-05"), assertIsoDate("2025-11-11"), assertIsoDate("2026-07-08")],
      today,
    );
  });

  test("rejects far past and far future (mm-dd flip symptom)", () => {
    expect(() => assertPlausibleDates([assertIsoDate("2024-01-01")], today)).toThrow(
      SchemaDriftError,
    );
    expect(() => assertPlausibleDates([assertIsoDate("2026-09-01")], today)).toThrow(
      SchemaDriftError,
    );
  });
});

describe("daysBetween", () => {
  test("simple deltas", () => {
    expect(daysBetween(assertIsoDate("2026-07-05"), assertIsoDate("2026-07-06"))).toBe(1);
    expect(daysBetween(assertIsoDate("2026-07-06"), assertIsoDate("2026-07-05"))).toBe(-1);
    expect(daysBetween(assertIsoDate("2026-02-28"), assertIsoDate("2026-03-01"))).toBe(1);
  });
});

describe("todayInSantiago", () => {
  test("returns a valid ISO date", () => {
    expect(() => assertIsoDate(todayInSantiago())).not.toThrow();
  });
});
