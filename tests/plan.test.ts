// planBalanceOp is pure. It always emits an op (no value-dedupe) so LM's balance_as_of
// refreshes every sync, and it fails closed on a currency mismatch (Money.equals returns
// false across currencies rather than throwing, so an unguarded mismatch would silently
// misdenominate the LM asset, whose currency is fixed).
import { describe, expect, test } from "bun:test";
import { SchemaDriftError } from "../src/core/errors.ts";
import { Money } from "../src/core/money.ts";
import { planBalanceOp } from "../src/core/plan.ts";

const ASOF = "2026-07-06T12:00:00.000Z";

describe("planBalanceOp", () => {
  test("plans a set_balance carrying the balance and the observation timestamp", () => {
    const op = planBalanceOp("acc", 42, Money.fromDecimalString("10.00", "USD"), "USD", ASOF);
    expect(op.op).toBe("set_balance");
    expect(op.lmAccountId).toBe(42);
    expect(op.balance.minor).toBe(1000n);
    expect(op.asOf).toBe(ASOF);
  });

  test("always plans an op so a stable balance still refreshes its as-of", () => {
    const bal = Money.fromDecimalString("10.00", "USD");
    expect(planBalanceOp("acc", 42, bal, "USD", ASOF).op).toBe("set_balance");
  });

  test("a currency mismatch is schema drift, not a silent misdenomination", () => {
    const clp = Money.of(1000n, "CLP");
    expect(() => planBalanceOp("acc", 42, clp, "USD", ASOF)).toThrow(SchemaDriftError);
  });
});
