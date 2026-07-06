import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { assertIsoDate } from "../src/core/dates.ts";
import {
  contentHash,
  formatExternalId,
  matchTransactions,
  type StoredIdentity,
} from "../src/core/identity.ts";
import type { CanonicalTxn } from "../src/core/model.ts";
import { Money } from "../src/core/money.ts";
import { normalizeDescription } from "../src/core/normalize.ts";

const ACCOUNT = "santander-checking";

function txn(date: string, amountClp: number, rawDesc: string): CanonicalTxn {
  return {
    date: assertIsoDate(date),
    amount: Money.fromMinorNumber(amountClp, "CLP"),
    rawDescription: rawDesc,
    normDescription: normalizeDescription(rawDesc),
    status: "posted",
    meta: {},
  };
}

/** Simulate persisting a mint plan as a stored identity. */
let nextId = 1;
function stored(plan: {
  txn: CanonicalTxn;
  bucketHash: string;
  occurrence: number;
  externalId: string;
}): StoredIdentity {
  return {
    id: nextId++,
    accountId: ACCOUNT,
    externalId: plan.externalId,
    bucketHash: plan.bucketHash,
    occurrence: plan.occurrence,
    date: plan.txn.date,
    amount: plan.txn.amount,
    normDesc: plan.txn.normDescription,
    rawDesc: plan.txn.rawDescription,
    descVariants: [],
    status: plan.txn.status,
    installments: plan.txn.meta.installments ?? null,
    lmTxnId: null,
    flagged: null,
  };
}

describe("matchTransactions", () => {
  test("re-ingesting the same transactions is a no-op (idempotency core)", () => {
    const txns = [
      txn("2026-06-26", 4321000, "00775502738 JUNE 2026 PAYROLL"),
      txn("2026-06-25", -24990, "COM.MANTENCION PLAN"),
      txn("2026-06-25", -45000, "Traspaso A:Mauricio gonzalez"),
    ];
    const first = matchTransactions(ACCOUNT, txns, []);
    expect(first.toMint).toHaveLength(3);
    const identities = first.toMint.map(stored);

    const second = matchTransactions(ACCOUNT, txns, identities);
    expect(second.toMint).toHaveLength(0);
    expect(second.matched).toHaveLength(3);
    expect(second.unmatchedExisting).toHaveLength(0);
  });

  test("truncation variants across runs do NOT mint duplicates (real Santander case)", () => {
    const run1 = [txn("2026-07-05", -25990, "PAYU *UBER EA")];
    const first = matchTransactions(ACCOUNT, run1, []);
    const identities = first.toMint.map(stored);

    const run2 = [txn("2026-07-05", -25990, "PAYU *UBER EATS")];
    const second = matchTransactions(ACCOUNT, run2, identities);
    expect(second.toMint).toHaveLength(0);
    expect(second.matched).toHaveLength(1);
    expect(second.matched[0]?.newVariant).toBe("PAYU *UBER EATS");
  });

  test("same-day identical twins stay distinct with distinct external_ids", () => {
    const twins = [
      txn("2026-07-05", -3150, "UBER RIDES UBER"),
      txn("2026-07-05", -3150, "UBER RIDES UBER"),
    ];
    const first = matchTransactions(ACCOUNT, twins, []);
    expect(first.toMint).toHaveLength(2);
    const externalIds = new Set(first.toMint.map((m) => m.externalId));
    expect(externalIds.size).toBe(2);
    const occurrences = first.toMint.map((m) => m.occurrence).sort();
    expect(occurrences).toEqual([0, 1]);

    // Re-ingest: both twins match, neither re-mints.
    const identities = first.toMint.map(stored);
    const second = matchTransactions(ACCOUNT, twins, identities);
    expect(second.toMint).toHaveLength(0);
    expect(second.matched).toHaveLength(2);
  });

  test("distinct merchants with same amount+date stay separate", () => {
    const run1 = [txn("2026-07-05", -6150, "40515-SBX COLON")];
    const identities = matchTransactions(ACCOUNT, run1, []).toMint.map(stored);

    const run2 = [
      txn("2026-07-05", -6150, "40515-SBX COLON"),
      txn("2026-07-05", -6150, "DL*GOOGLE YOUTUBE"),
    ];
    const second = matchTransactions(ACCOUNT, run2, identities);
    expect(second.matched).toHaveLength(1);
    expect(second.matched[0]?.identity.normDesc).toBe("40515-SBX COLON");
    expect(second.toMint).toHaveLength(1);
    expect(second.toMint[0]?.txn.normDescription).toBe("DL*GOOGLE YOUTUBE");
  });

  test("external_id format: 40-hex + 2-digit counter", () => {
    const t = txn("2026-07-05", -1000, "SOMETHING");
    const hash = contentHash(ACCOUNT, t);
    expect(hash).toMatch(/^[0-9a-f]{40}$/);
    expect(formatExternalId(hash, 0)).toMatch(/^[0-9a-f]{40}-00$/);
    expect(formatExternalId(hash, 7).length).toBeLessThanOrEqual(75);
  });

  test("property: matching is deterministic under input permutation", () => {
    const txnArb = fc
      .record({
        date: fc.constantFrom("2026-07-01", "2026-07-02"),
        amount: fc.constantFrom(-1000, -2000, -3000),
        desc: fc.constantFrom("UBER RIDES", "STARBUCKS COLON", "GOOGLE YOUTUBE"),
      })
      .map(({ date, amount, desc }) => txn(date, amount, desc));

    fc.assert(
      fc.property(
        fc.array(txnArb, { minLength: 1, maxLength: 8 }),
        fc.func(fc.integer()),
        (txns, shuffleKey) => {
          const identities = matchTransactions(ACCOUNT, txns, []).toMint.map(stored);
          const shuffled = [...txns]
            .map((t, i) => ({ t, k: shuffleKey(i) }))
            .sort((a, b) => a.k - b.k)
            .map(({ t }) => t);
          const a = matchTransactions(ACCOUNT, txns, identities);
          const b = matchTransactions(ACCOUNT, shuffled, identities);
          expect(a.toMint.map((m) => m.externalId).sort()).toEqual(
            b.toMint.map((m) => m.externalId).sort(),
          );
          expect(a.matched.map((m) => m.identity.externalId).sort()).toEqual(
            b.matched.map((m) => m.identity.externalId).sort(),
          );
        },
      ),
    );
  });

  test("property: re-ingest of any transaction set is always a full match, zero mints", () => {
    const txnArb = fc
      .record({
        date: fc.constantFrom("2026-07-01", "2026-07-02", "2026-07-03"),
        amount: fc.integer({ min: -100000, max: 100000 }),
        desc: fc.string({ minLength: 1, maxLength: 30 }),
      })
      .map(({ date, amount, desc }) => txn(date, amount, desc || "X"));

    fc.assert(
      fc.property(fc.array(txnArb, { minLength: 1, maxLength: 12 }), (txns) => {
        const identities = matchTransactions(ACCOUNT, txns, []).toMint.map(stored);
        const again = matchTransactions(ACCOUNT, txns, identities);
        expect(again.toMint).toHaveLength(0);
        expect(again.matched).toHaveLength(txns.length);
        expect(again.unmatchedExisting).toHaveLength(0);
      }),
    );
  });
});
