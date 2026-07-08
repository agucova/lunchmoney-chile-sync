// Golden-fixture tests for the payload parser: the santander/bchile fixtures mirror the
// real Phase 0 payloads including every observed quirk (flat vs nested shapes, mixed date
// formats, string balances, truncated descriptions). The bci fixture is code-derived from
// the pinned scraper (commit 085faafd) and validated against a real capture (2026-07-06:
// checking-only account, all-ISO API dates, no creditCards[], history back ~23 months);
// the synthetic fixture stays because it exercises more of the declared grammar.
import { describe, expect, test } from "bun:test";
import { assertIsoDate } from "../src/core/dates.ts";
import { SchemaDriftError } from "../src/core/errors.ts";
import { parseObcPayload } from "../src/adapters/obc-payload.ts";
import bchileFixture from "./fixtures/bchile.json";
import bciFixture from "./fixtures/bci.json";
import santanderFixture from "./fixtures/santander.json";

const TODAY = assertIsoDate("2026-07-06");
const FETCHED_AT = "2026-07-06T12:00:00.000Z";

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe("santander (flat v2 shape)", () => {
  test("splits checking and credit card by source tag", () => {
    const results = parseObcPayload("santander", santanderFixture, TODAY, FETCHED_AT);
    expect([...results.keys()].sort()).toEqual(["checking", "credit_card"]);

    const checking = results.get("checking");
    expect(checking?.facets.transactions).toHaveLength(2);
    expect(checking?.facets.balance?.amount.minor).toBe(7654321n);
    expect(checking?.coverage.posted?.from).toBe(assertIsoDate("2026-06-25"));

    const card = results.get("credit_card");
    expect(card?.facets.transactions).toHaveLength(3);
    expect(card?.facets.balance).toBeUndefined();
  });

  test("per-source date formats: unbilled dd-mm-yyyy, billed ISO", () => {
    const results = parseObcPayload("santander", santanderFixture, TODAY, FETCHED_AT);
    const txns = results.get("credit_card")?.facets.transactions ?? [];
    const unbilled = txns.find((t) => t.status === "unbilled");
    expect(unbilled?.date).toBe(assertIsoDate("2026-07-05"));
    const billed = txns.filter((t) => t.status === "billed").map((t) => String(t.date));
    expect(billed.sort()).toEqual(["2026-05-26", "2026-06-21"]);
  });

  test("normalization and metadata: whitespace collapsed, installments captured", () => {
    const results = parseObcPayload("santander", santanderFixture, TODAY, FETCHED_AT);
    const txns = results.get("credit_card")?.facets.transactions ?? [];
    expect(txns.map((t) => t.normDescription)).toContain("PAYU *UBER TRIP");
    const cuota = txns.find((t) => t.meta.installments);
    expect(cuota?.meta.installments).toBe("02/06");
  });

  test("a dd-mm date in a declared-ISO source is SchemaDrift", () => {
    const bad = clone(santanderFixture);
    const account = bad.accounts[0];
    if (!account?.movements[0]) throw new Error("fixture shape");
    account.movements[0].date = "26-06-2026"; // account source is declared ISO
    expect(() => parseObcPayload("santander", bad, TODAY, FETCHED_AT)).toThrow(SchemaDriftError);
  });

  test("non-integer amount is SchemaDrift", () => {
    const bad = clone(santanderFixture);
    const account = bad.accounts[0];
    if (!account?.movements[1]) throw new Error("fixture shape");
    account.movements[1].amount = -24990.5;
    expect(() => parseObcPayload("santander", bad, TODAY, FETCHED_AT)).toThrow(SchemaDriftError);
  });

  test("unknown movement field is SchemaDrift (strict schemas)", () => {
    const bad = clone(santanderFixture) as {
      accounts: Array<{ movements: Array<Record<string, unknown>> }>;
    };
    const movement = bad.accounts[0]?.movements[0];
    if (!movement) throw new Error("fixture shape");
    movement["surprise"] = "field";
    expect(() => parseObcPayload("santander", bad, TODAY, FETCHED_AT)).toThrow(SchemaDriftError);
  });

  test("implausibly old movement date is SchemaDrift (format-flip guard)", () => {
    const bad = clone(santanderFixture);
    const account = bad.accounts[0];
    if (!account?.movements[0]) throw new Error("fixture shape");
    account.movements[0].date = "2020-01-01";
    expect(() => parseObcPayload("santander", bad, TODAY, FETCHED_AT)).toThrow(SchemaDriftError);
  });

  test("a creditCards entry is SchemaDrift (shape declares none)", () => {
    const bad = clone(santanderFixture) as Record<string, unknown>;
    bad["creditCards"] = [{ label: "Visa **** 9999", movements: [] }];
    expect(() => parseObcPayload("santander", bad, TODAY, FETCHED_AT)).toThrow(SchemaDriftError);
  });
});

describe("bchile (nested v3 shape)", () => {
  test("checking + per-card sub-accounts keyed by last-4", () => {
    const results = parseObcPayload("bchile", bchileFixture, TODAY, FETCHED_AT);
    expect([...results.keys()].sort()).toEqual([
      "checking",
      "credit_card:1122",
      "credit_card:3344",
    ]);
    expect(results.get("credit_card:1122")?.facets.transactions).toHaveLength(0);
  });

  test("string running balances parse exactly; accents survive normalization", () => {
    const results = parseObcPayload("bchile", bchileFixture, TODAY, FETCHED_AT);
    const txns = results.get("checking")?.facets.transactions ?? [];
    expect(txns[0]?.meta.runningBalance?.minor).toBe(1450000n);
    expect(txns.map((t) => t.normDescription)).toContain("TRASPASO A:PERSONA DOS");
  });

  test("dd-mm-yyyy account dates parse", () => {
    const results = parseObcPayload("bchile", bchileFixture, TODAY, FETCHED_AT);
    const txns = results.get("checking")?.facets.transactions ?? [];
    expect(txns.map((t) => String(t.date)).sort()).toEqual(["2026-06-08", "2026-06-16"]);
  });

  test("card label without last-4 is SchemaDrift", () => {
    const bad = clone(bchileFixture);
    const card = bad.creditCards[0];
    if (!card) throw new Error("fixture shape");
    card.label = "Visa Infinite";
    expect(() => parseObcPayload("bchile", bad, TODAY, FETCHED_AT)).toThrow(SchemaDriftError);
  });
});

describe("bci (flat shape, cupo-only cards)", () => {
  test("checking + bare credit_card; cupo-only cards emit no sub-accounts", () => {
    const results = parseObcPayload("bci", bciFixture, TODAY, FETCHED_AT);
    // "Mastercard **** 5566" has a last-4 in its label, but cupo-only entries must
    // still not become credit_card:<last4> sub-accounts.
    expect([...results.keys()].sort()).toEqual(["checking", "credit_card"]);

    const checking = results.get("checking");
    expect(checking?.facets.transactions).toHaveLength(2);
    expect(checking?.facets.balance?.amount.minor).toBe(2345678n);

    const card = results.get("credit_card");
    expect(card?.facets.transactions).toHaveLength(2);
    expect(card?.facets.balance).toBeUndefined();
  });

  test("path-dependent account dates: ISO and dd-mm-yyyy both parse", () => {
    const results = parseObcPayload("bci", bciFixture, TODAY, FETCHED_AT);
    const txns = results.get("checking")?.facets.transactions ?? [];
    expect(txns.map((t) => String(t.date)).sort()).toEqual(["2026-06-28", "2026-07-01"]);
  });

  test("card statuses map from source tags; unbilled/billed dates are dd-mm-yyyy", () => {
    const results = parseObcPayload("bci", bciFixture, TODAY, FETCHED_AT);
    const txns = results.get("credit_card")?.facets.transactions ?? [];
    const unbilled = txns.find((t) => t.status === "unbilled");
    expect(unbilled?.date).toBe(assertIsoDate("2026-07-03"));
    const billed = txns.find((t) => t.status === "billed");
    expect(billed?.date).toBe(assertIsoDate("2026-06-15"));
  });

  test("zero movement balances yield no runningBalance meta", () => {
    const results = parseObcPayload("bci", bciFixture, TODAY, FETCHED_AT);
    const txns = [...results.values()].flatMap((r) => r.facets.transactions ?? []);
    expect(txns.every((t) => t.meta.runningBalance === undefined)).toBe(true);
  });

  test("checking history up to ~2 years old is accepted (observed API window)", () => {
    const old = clone(bciFixture);
    const account = old.accounts[0];
    if (!account?.movements[0]) throw new Error("fixture shape");
    account.movements[0].date = "2024-08-15"; // ~23 months before TODAY
    const results = parseObcPayload("bci", old, TODAY, FETCHED_AT);
    expect(results.get("checking")?.coverage.posted?.from).toBe(assertIsoDate("2024-08-15"));
  });

  test("a movement older than the widened window is still SchemaDrift", () => {
    const bad = clone(bciFixture);
    const account = bad.accounts[0];
    if (!account?.movements[0]) throw new Error("fixture shape");
    account.movements[0].date = "2023-01-01";
    expect(() => parseObcPayload("bci", bad, TODAY, FETCHED_AT)).toThrow(SchemaDriftError);
  });

  test("an account date matching neither declared format is SchemaDrift", () => {
    const bad = clone(bciFixture);
    const account = bad.accounts[0];
    if (!account?.movements[0]) throw new Error("fixture shape");
    account.movements[0].date = "01/07/2026";
    expect(() => parseObcPayload("bci", bad, TODAY, FETCHED_AT)).toThrow(SchemaDriftError);
  });

  test("an ISO date in a dd-mm-yyyy-only card source is SchemaDrift", () => {
    const bad = clone(bciFixture);
    const billed = bad.accounts[0]?.movements.find((m) => m.source === "credit_card_billed");
    if (!billed) throw new Error("fixture shape");
    billed.date = "2026-06-15";
    expect(() => parseObcPayload("bci", bad, TODAY, FETCHED_AT)).toThrow(SchemaDriftError);
  });

  test("a cupo-only card carrying movements is SchemaDrift (double-emit guard)", () => {
    // The fixture's empty movements arrays infer as never[]; widen to inject one.
    const bad = clone(bciFixture) as unknown as {
      accounts: Array<{ movements: unknown[] }>;
      creditCards: Array<{ movements: unknown[] }>;
    };
    const card = bad.creditCards[0];
    const movement = bad.accounts[0]?.movements[2];
    if (!card || !movement) throw new Error("fixture shape");
    card.movements.push(movement);
    expect(() => parseObcPayload("bci", bad, TODAY, FETCHED_AT)).toThrow(SchemaDriftError);
  });

  test("empty checking with no balance is SchemaDrift (navigation-failure tripwire)", () => {
    const bad = clone(bciFixture) as {
      accounts: Array<{ balance?: number; movements: unknown[] }>;
    };
    const account = bad.accounts[0];
    if (!account) throw new Error("fixture shape");
    delete account.balance;
    account.movements = [];
    expect(() => parseObcPayload("bci", bad, TODAY, FETCHED_AT)).toThrow(SchemaDriftError);
  });
});

describe("general drift", () => {
  test("empty payload is SchemaDrift", () => {
    expect(() =>
      parseObcPayload("santander", { success: true, bank: "santander" }, TODAY, FETCHED_AT),
    ).toThrow(SchemaDriftError);
  });

  test("unknown bank has no payload-shape declaration", () => {
    expect(() => parseObcPayload("notabank", clone(santanderFixture), TODAY, FETCHED_AT)).toThrow(
      SchemaDriftError,
    );
  });
});
