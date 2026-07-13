// Payee → category rules: first-match-wins ordering, case-insensitivity, no-match, and
// that config validates (compiles) patterns at load so a bad regex fails closed.
import { describe, expect, test } from "bun:test";
import { categorizePayee, compileCategoryRules } from "../src/core/categorize.ts";
import { parseConfig } from "../src/config.ts";

const RAW = [
  { pattern: "UBER\\s*\\*?\\s*EATS|RAPPI", category_id: 10 }, // food delivery
  { pattern: "UBER", category_id: 20 }, // rideshare — broader, must come AFTER eats
  { pattern: "ANTHROPIC|CLAUDE", category_id: 30 },
];

describe("categorizePayee", () => {
  const rules = compileCategoryRules(RAW);

  test("first matching rule wins (specific eats rule beats the broad uber rule)", () => {
    expect(categorizePayee("UBER *EATS santiago", rules)).toBe(10);
    expect(categorizePayee("UBER *TRIP help.uber.com", rules)).toBe(20);
  });

  test("matching is case-insensitive", () => {
    expect(categorizePayee("anthropic", rules)).toBe(30);
    expect(categorizePayee("Claude.ai Subscription", rules)).toBe(30);
  });

  test("a payee matching no rule is left uncategorized (undefined)", () => {
    expect(categorizePayee("KIOSKO ZAPALLAR", rules)).toBeUndefined();
  });

  test("empty ruleset never categorizes", () => {
    expect(categorizePayee("ANTHROPIC", [])).toBeUndefined();
  });
});

describe("compileCategoryRules", () => {
  test("preserves order and compiles patterns to case-insensitive regex", () => {
    const compiled = compileCategoryRules(RAW);
    expect(compiled.map((r) => r.categoryId)).toEqual([10, 20, 30]);
    expect(compiled[0]?.pattern.flags).toContain("i");
  });
});

describe("config categorization", () => {
  const base = {
    lunchmoney: { token_env: "LUNCHMONEY_TOKEN" },
    state: {},
    connections: {
      c: { type: "santander", rut_env: "R", password_env: "P" },
    },
    accounts: [
      {
        id: "a",
        connection: "c",
        kind: "checking",
        currency: "CLP",
        lm_account_id: 1,
        sources: ["santander"],
      },
    ],
  };

  test("defaults to an empty ruleset when omitted", () => {
    expect(parseConfig(base).categorization).toEqual([]);
  });

  test("parses well-formed rules in order", () => {
    const cfg = parseConfig({
      ...base,
      categorization: [
        { pattern: "ANTHROPIC", category_id: 30 },
        { pattern: "RAPPI", category_id: 10 },
      ],
    });
    expect(cfg.categorization.map((r) => r.category_id)).toEqual([30, 10]);
  });

  test("an invalid regex fails closed at config load", () => {
    expect(() =>
      parseConfig({ ...base, categorization: [{ pattern: "([unclosed", category_id: 1 }] }),
    ).toThrow();
  });
});
