// planBalanceOp is pure: it must dedupe unchanged balances and fail closed on a currency
// mismatch (Money.equals returns false across currencies rather than throwing, so without
// the guard a CLP→USD change would silently plan a push in the wrong denomination).
import { describe, expect, test } from "bun:test";
import { assertIsoDate } from "../src/core/dates.ts";
import { SchemaDriftError } from "../src/core/errors.ts";
import { Money } from "../src/core/money.ts";
import { planBalanceOp } from "../src/core/plan.ts";

const ASOF = assertIsoDate("2026-07-06");

describe("planBalanceOp", () => {
  test("plans a set_balance carrying the balance and as-of date", () => {
    const op = planBalanceOp("acc", 42, Money.fromDecimalString("10.00", "USD"), null, "USD", ASOF);
    expect(op?.op).toBe("set_balance");
    expect(op?.lmAccountId).toBe(42);
    expect(op?.balance.minor).toBe(1000n);
    expect(op?.asOf).toBe(ASOF);
  });

  test("plans nothing when the balance is unchanged", () => {
    const bal = Money.fromDecimalString("10.00", "USD");
    expect(planBalanceOp("acc", 42, bal, bal, "USD", ASOF)).toBeNull();
  });

  test("a currency mismatch is schema drift, not a silent re-push", () => {
    const clp = Money.of(1000n, "CLP");
    expect(() => planBalanceOp("acc", 42, clp, null, "USD", ASOF)).toThrow(SchemaDriftError);
  });
});
