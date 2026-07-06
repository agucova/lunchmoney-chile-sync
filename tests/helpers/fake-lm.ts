// Fake Lunch Money v2 sink mimicking the verified API semantics: duplicate
// external_id → skipped with the existing transaction id (docs/phase0-findings.md).
import { SinkError } from "../../src/core/errors.ts";
import type { Money } from "../../src/core/money.ts";

export class FakeLunchMoney {
  txnsByExternalId = new Map<
    string,
    { id: number; amount: string; currency: string; payee: string }
  >();
  balances: Array<{ lmAccountId: number; balance: string; asOf: string }> = [];
  failAfter = Number.POSITIVE_INFINITY;
  private calls = 0;
  private nextId = 1000;

  /**
   * Batch insert. Processes transactions one at a time and can fail MID-BATCH
   * (failAfter counts individual txns) — simulating a server-side partial batch,
   * the harshest case for crash recovery.
   */
  async insertTransactions(
    txns: ReadonlyArray<{ amount: Money; externalId: string; payee: string }>,
  ): Promise<Array<{ lmTxnId: number; deduped: boolean }>> {
    const outcomes: Array<{ lmTxnId: number; deduped: boolean }> = [];
    for (const txn of txns) {
      if (++this.calls > this.failAfter) throw new SinkError("simulated LM outage");
      const existing = this.txnsByExternalId.get(txn.externalId);
      if (existing) {
        outcomes.push({ lmTxnId: existing.id, deduped: true });
        continue;
      }
      const id = this.nextId++;
      this.txnsByExternalId.set(txn.externalId, {
        id,
        amount: txn.amount.toDecimalString(),
        currency: txn.amount.currency,
        payee: txn.payee,
      });
      outcomes.push({ lmTxnId: id, deduped: false });
    }
    return outcomes;
  }

  async setBalance(lmAccountId: number, balance: Money, asOf: string): Promise<void> {
    if (++this.calls > this.failAfter) throw new SinkError("simulated LM outage");
    this.balances.push({ lmAccountId, balance: balance.toDecimalString(), asOf });
  }
}
