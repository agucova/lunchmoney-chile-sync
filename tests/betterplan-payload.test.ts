import { describe, expect, test } from "bun:test";
import { create, toBinary } from "@bufbuild/protobuf";
import {
  CurrencyModelSchema,
  FinancialEntityModelSchema,
  GetPatrimonyByFinancialEntityResponseSchema,
  GoalModelSchema,
  ListGoalResponseSchema,
  PatrimonyEntitySchema,
} from "../src/adapters/betterplan/gen/betterplan_pb.ts";
import { parseBetterplanPayload } from "../src/adapters/betterplan-payload.ts";
import { assertIsoDate } from "../src/core/dates.ts";
import { SchemaDriftError } from "../src/core/errors.ts";

const TODAY = assertIsoDate("2026-07-06");
const FETCHED = "2026-07-06T14:00:00.000Z";

const USD = { id: 2, name: "Dólares", currencyCode: "USD" };
const CLP = { id: 1, name: "Pesos", currencyCode: "CLP" };

interface GoalSpec {
  id: number;
  title: string;
  amount: number;
  currency: typeof USD | typeof CLP;
  entity: string; // "bp-us" | "vector"
  archived?: boolean;
  currencyCode?: string; // override to force drift
}

function goal(spec: GoalSpec) {
  return create(GoalModelSchema, {
    id: spec.id,
    title: spec.title,
    currentCapital: spec.amount,
    currency: create(CurrencyModelSchema, {
      ...spec.currency,
      ...(spec.currencyCode ? { currencyCode: spec.currencyCode } : {}),
    }),
    financialEntity: create(FinancialEntityModelSchema, {
      id: 1,
      shortTitle: spec.entity,
      uuid: spec.entity,
    }),
    archived: spec.archived ?? false,
    hidden: false,
  });
}

function listBytes(specs: GoalSpec[]): Uint8Array {
  return toBinary(
    ListGoalResponseSchema,
    create(ListGoalResponseSchema, { values: specs.map(goal) }),
  );
}

function patrimonyBytes(
  entities: { uuid: string; balance: number; currency: typeof USD | typeof CLP }[],
): Uint8Array {
  return toBinary(
    GetPatrimonyByFinancialEntityResponseSchema,
    create(GetPatrimonyByFinancialEntityResponseSchema, {
      totalBalance: 0,
      totalCurrency: create(CurrencyModelSchema, CLP),
      entities: entities.map((e) =>
        create(PatrimonyEntitySchema, {
          financialEntityUuid: e.uuid,
          financialEntityName: e.uuid,
          balance: e.balance,
          currency: create(CurrencyModelSchema, e.currency),
        }),
      ),
    }),
  );
}

// A reconciling world: two USD goals + empty USD wallet under bp-us (Σ 15679.41), one CLP wallet
// + empty archived goal under vector (Σ 150000). Matches the live figures in docs/betterplan-api.md.
const GOALS: GoalSpec[] = [
  {
    id: 34256,
    title: "Inversiones generales 2",
    amount: 3333.5217,
    currency: USD,
    entity: "bp-us",
  },
  {
    id: 34876,
    title: "Inversiones generales 3",
    amount: 12345.891,
    currency: USD,
    entity: "bp-us",
  },
  // A USD wallet under the CLP broker (vector) — brokers are multi-currency; when empty it has
  // no patrimony total and must still reconcile.
  { id: 31503, title: "Billetera Dólar", amount: 0, currency: USD, entity: "vector" },
  { id: 31502, title: "Billetera Pesos", amount: 150000, currency: CLP, entity: "vector" },
  {
    id: 33170,
    title: "Arriesgado Largo Plazo",
    amount: 0,
    currency: CLP,
    entity: "vector",
    archived: true,
  },
];
const PATRIMONY = [
  { uuid: "bp-us", balance: 15679.41, currency: USD },
  { uuid: "vector", balance: 150000, currency: CLP },
];

describe("parseBetterplanPayload", () => {
  test("reconciling payload → one balance per goal, correct minor units", () => {
    const results = parseBetterplanPayload(
      listBytes(GOALS),
      patrimonyBytes(PATRIMONY),
      TODAY,
      FETCHED,
    );
    expect([...results.keys()].sort()).toEqual(
      [
        "investment:31502",
        "investment:31503",
        "investment:33170",
        "investment:34256",
        "investment:34876",
      ].sort(),
    );
    // 12345.891 → toFixed(2) "12345.89" → 1234589 cents
    expect(results.get("investment:34876")?.facets.balance?.amount.minor).toBe(1234589n);
    expect(results.get("investment:34876")?.facets.balance?.amount.currency).toBe("USD");
    // CLP exp 0 → whole pesos
    expect(results.get("investment:31502")?.facets.balance?.amount.minor).toBe(150000n);
    // empty wallet legitimately 0
    expect(results.get("investment:31503")?.facets.balance?.amount.minor).toBe(0n);
    expect(results.get("investment:34876")?.facets.balance?.asOf).toBe(TODAY);
    expect(results.get("investment:34876")?.sourceMeta.source).toBe("betterplan");
  });

  test("a goal's balance silently reading 0 → reconciliation SchemaDrift", () => {
    const broken = GOALS.map((g) => (g.id === 34876 ? { ...g, amount: 0 } : g));
    expect(() =>
      parseBetterplanPayload(listBytes(broken), patrimonyBytes(PATRIMONY), TODAY, FETCHED),
    ).toThrow(SchemaDriftError);
  });

  test("a goal dropping out of the list → reconciliation SchemaDrift", () => {
    const missing = GOALS.filter((g) => g.id !== 34876);
    expect(() =>
      parseBetterplanPayload(listBytes(missing), patrimonyBytes(PATRIMONY), TODAY, FETCHED),
    ).toThrow(SchemaDriftError);
  });

  test("legitimate full withdrawal (goal 0 AND patrimony drops) → reconciles, pushes 0", () => {
    const withdrawn = GOALS.map((g) => (g.id === 34876 ? { ...g, amount: 0 } : g));
    const patrimony = [
      { uuid: "bp-us", balance: 3333.52, currency: USD }, // 15679.41 - 12345.89
      { uuid: "vector", balance: 150000, currency: CLP },
    ];
    const results = parseBetterplanPayload(
      listBytes(withdrawn),
      patrimonyBytes(patrimony),
      TODAY,
      FETCHED,
    );
    expect(results.get("investment:34876")?.facets.balance?.amount.minor).toBe(0n);
  });

  test("unknown currency code → SchemaDrift (never a guessed currency)", () => {
    const bad = GOALS.map((g) => (g.id === 34876 ? { ...g, currencyCode: "XYZ" } : g));
    expect(() =>
      parseBetterplanPayload(listBytes(bad), patrimonyBytes(PATRIMONY), TODAY, FETCHED),
    ).toThrow(SchemaDriftError);
  });

  test("a non-zero foreign-currency wallet with no matching patrimony total → SchemaDrift", () => {
    // Billetera Dólar (USD, under the CLP broker) holds $500, but patrimony has no vector/USD
    // total to verify it against — unverifiable money is drift.
    const bad = GOALS.map((g) => (g.id === 31503 ? { ...g, amount: 500 } : g));
    expect(() =>
      parseBetterplanPayload(listBytes(bad), patrimonyBytes(PATRIMONY), TODAY, FETCHED),
    ).toThrow(SchemaDriftError);
  });

  test("goal money under an entity absent from patrimony → SchemaDrift", () => {
    const orphan = [
      ...GOALS,
      { id: 99999, title: "Orphan", amount: 500, currency: USD, entity: "ghost" },
    ];
    expect(() =>
      parseBetterplanPayload(listBytes(orphan), patrimonyBytes(PATRIMONY), TODAY, FETCHED),
    ).toThrow(SchemaDriftError);
  });
});
