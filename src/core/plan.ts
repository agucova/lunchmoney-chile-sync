// SyncPlan: every mutation exists as inspectable data before anything touches Lunch
// Money. --dry-run prints the plan; apply executes it idempotently.

import { SchemaDriftError } from "./errors.ts";
import type { IsoDate } from "./dates.ts";
import type { AccountKind } from "./model.ts";
import { Money } from "./money.ts";

/**
 * Sign convention (verified against real data, see docs/phase0-findings.md):
 * banks emit expenses negative (cargo) and income positive; Lunch Money stores
 * debits/expenses POSITIVE. One flip, in exactly one place.
 * Credit-card semantics arrive in Phase 2 but use the same flip: a purchase
 * (negative at the bank) is an expense (positive in LM); a card payment (positive
 * at the bank) is a credit (negative in LM).
 */
export function toLunchMoneyAmount(bankAmount: Money, _kind: AccountKind): Money {
  return bankAmount.negate();
}

export interface InsertTxnOp {
  readonly op: "insert_txn";
  readonly accountId: string;
  readonly lmAccountId: number;
  readonly identityId: number;
  readonly externalId: string;
  readonly date: IsoDate;
  /** Already in LM sign convention. */
  readonly amount: Money;
  readonly payee: string;
}

export interface SetBalanceOp {
  readonly op: "set_balance";
  readonly accountId: string;
  readonly lmAccountId: number;
  /** LM asset balance (checking: bank balance as-is; CC in Phase 2: amount owed). */
  readonly balance: Money;
  /** Observation timestamp (ISO) → LM balance_as_of, so the asset reads as freshly synced. */
  readonly asOf: string;
}

export type SyncOp = InsertTxnOp | SetBalanceOp;

export function describeOp(op: SyncOp): string {
  switch (op.op) {
    case "insert_txn":
      return `insert  ${op.accountId}  ${op.date}  ${op.amount.toString().padStart(16)}  ${op.payee}`;
    case "set_balance":
      return `balance ${op.accountId}  → ${op.balance.toString()} (as of ${op.asOf})`;
  }
}

/**
 * A balance op is planned every run — deliberately NOT deduped on value. LM's balance_as_of
 * only advances when we PUT, so re-emitting each sync (with the current `asOf` timestamp)
 * keeps a stable balance reading as fresh rather than stale. Transaction idempotency is a
 * separate concern handled by the identity ledger, so this does not create duplicate txns.
 *
 * `expectedCurrency` is the account's configured currency. A source emitting a balance in the
 * wrong currency is schema drift (the LM asset's currency is fixed, so a mismatched number
 * would be silently misdenominated) — fail closed here, in the pure planner, before LM.
 */
export function planBalanceOp(
  accountId: string,
  lmAccountId: number,
  fetched: Money,
  expectedCurrency: string,
  asOf: string,
): SetBalanceOp {
  if (fetched.currency !== expectedCurrency) {
    throw new SchemaDriftError(
      `${accountId}: balance currency ${fetched.currency} does not match configured ${expectedCurrency}`,
    );
  }
  return { op: "set_balance", accountId, lmAccountId, balance: fetched, asOf };
}
