// Golden + fail-closed tests for the Racional payload parser. The fixture mirrors the real
// /positions and /positions/buying-power shapes, with one >2-dp amountUSD (33.333333) to pin
// the toFixed(2) money boundary.
import { describe, expect, test } from "bun:test";
import { assertIsoDate } from "../src/core/dates.ts";
import { SchemaDriftError } from "../src/core/errors.ts";
import { parseRacionalPayload } from "../src/adapters/racional-payload.ts";
import racionalFixture from "./fixtures/racional.json";

const TODAY = assertIsoDate("2026-07-06");
const FETCHED_AT = "2026-07-06T14:31:00.000Z";

type Fixture = typeof racionalFixture;
function clone(): Fixture {
  return JSON.parse(JSON.stringify(racionalFixture)) as Fixture;
}
function parse(fx: Fixture) {
  return parseRacionalPayload(fx.positions, fx.buyingPower, TODAY, FETCHED_AT);
}

describe("racional payload (golden)", () => {
  test("emits total + stocks + cash entries", () => {
    const results = parse(clone());
    expect([...results.keys()].sort()).toEqual([
      "investment",
      "investment:cash",
      "investment:stocks",
    ]);
  });

  test("stocks is Σ round(position); cash is buyingPower; total is their sum", () => {
    const results = parse(clone());
    const stocks = results.get("investment:stocks")?.facets.balance?.amount;
    const cash = results.get("investment:cash")?.facets.balance?.amount;
    const total = results.get("investment")?.facets.balance?.amount;

    // 2100.00 + 1250.75 + 33.333333→33.33 = 3384.08
    expect(stocks?.minor).toBe(338408n);
    expect(stocks?.currency).toBe("USD");
    expect(cash?.minor).toBe(250000n);
    expect(total?.minor).toBe(588408n); // 3384.08 stocks + 2500.00 cash
    expect(total?.minor).toBe((stocks?.minor ?? 0n) + (cash?.minor ?? 0n));
  });

  test("balance-only with empty coverage, racional source, asOf today", () => {
    const stocks = parse(clone()).get("investment:stocks");
    expect(stocks?.facets.transactions).toBeUndefined();
    expect(stocks?.coverage).toEqual({});
    expect(stocks?.sourceMeta.source).toBe("racional");
    expect(stocks?.facets.balance?.asOf).toBe(TODAY);
  });

  test("empty positions is legal: stocks 0, total equals cash", () => {
    const fx = clone();
    fx.positions = [];
    const results = parse(fx);
    expect(results.get("investment:stocks")?.facets.balance?.amount.minor).toBe(0n);
    expect(results.get("investment")?.facets.balance?.amount.minor).toBe(250000n);
  });
});

describe("racional payload (fail closed)", () => {
  test("unknown field on a position is drift", () => {
    const fx = clone();
    (fx.positions[0] as Record<string, unknown>)["surprise"] = 1;
    expect(() => parse(fx)).toThrow(SchemaDriftError);
  });

  test("missing amountUSD is drift", () => {
    const fx = clone();
    delete (fx.positions[0] as Record<string, unknown>)["amountUSD"];
    expect(() => parse(fx)).toThrow(SchemaDriftError);
  });

  test("string amountUSD is drift", () => {
    const fx = clone();
    (fx.positions[0] as Record<string, unknown>)["amountUSD"] = "2100.00";
    expect(() => parse(fx)).toThrow(SchemaDriftError);
  });

  test("negative amountUSD is drift", () => {
    const fx = clone();
    fx.positions[0]!.amountUSD = -1;
    expect(() => parse(fx)).toThrow(SchemaDriftError);
  });

  test("non-finite amountUSD is drift (not an uncaught invariant)", () => {
    const fx = clone();
    fx.positions[0]!.amountUSD = Number.POSITIVE_INFINITY;
    expect(() => parse(fx)).toThrow(SchemaDriftError);
  });

  test("margin account (tradingType != CASH) is drift", () => {
    const fx = clone();
    (fx.buyingPower.accountContext as Record<string, unknown>)["tradingType"] = "MARGIN";
    expect(() => parse(fx)).toThrow(SchemaDriftError);
  });

  test("missing buying-power breakdown is drift", () => {
    const fx = clone();
    delete (fx.buyingPower as Record<string, unknown>)["breakdown"];
    expect(() => parse(fx)).toThrow(SchemaDriftError);
  });

  test("stale pricing (all lastUpdated far in the past) is drift", () => {
    const fx = clone();
    for (const p of fx.positions) p.lastUpdated = "2020-01-01T00:00:00.000Z";
    expect(() => parse(fx)).toThrow(SchemaDriftError);
  });

  test("future-dated pricing beyond the window is drift (absolute staleness)", () => {
    const fx = clone();
    for (const p of fx.positions) p.lastUpdated = "2027-01-01T00:00:00.000Z";
    expect(() => parse(fx)).toThrow(SchemaDriftError);
  });
});
