// Round-trips the state layer against an in-memory db: migrations apply, BigInt
// amounts survive the TEXT custom type exactly, identities and balances round-trip.
import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { assertIsoDate } from "../src/core/dates.ts";
import { Money } from "../src/core/money.ts";
import { NORMALIZE_VERSION } from "../src/core/normalize.ts";
import { openDb } from "../src/state/db.ts";
import {
  identitiesInWindow,
  insertIdentity,
  lastPushedBalance,
  recordPushedBalance,
  setLmTxnId,
  startRun,
  touchIdentity,
} from "../src/state/repo.ts";

function freshDb() {
  return openDb(":memory:");
}

describe("state layer", () => {
  test("identity round-trip preserves BigInt amounts exactly", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: -(10n ** 14n), max: 10n ** 14n }), (minor) => {
        const db = freshDb();
        const runId = startRun(db, "santander", "obc");
        const amount = Money.of(minor, "CLP");
        const externalId = `${minor.toString(16).replace("-", "n").padStart(40, "0")}-00`;
        insertIdentity(db, runId, {
          accountId: "prop-test",
          externalId,
          bucketHash: externalId.slice(0, 40),
          occurrence: 0,
          date: assertIsoDate("2026-07-05"),
          amount,
          normDesc: "PROP",
          rawDesc: "prop",
          normVersion: NORMALIZE_VERSION,
          status: "posted",
        });
        const [loaded] = identitiesInWindow(
          db,
          "prop-test",
          assertIsoDate("2026-07-05"),
          assertIsoDate("2026-07-05"),
        ).filter((i) => i.externalId === externalId);
        expect(loaded?.amount.minor).toBe(minor);
        expect(loaded?.amount.currency).toBe("CLP");
      }),
      { numRuns: 25 },
    );
  });

  test("touchIdentity records variants once; setLmTxnId sticks", () => {
    const db = freshDb();
    const runId = startRun(db, "santander", "obc");
    const id = insertIdentity(db, runId, {
      accountId: "a",
      externalId: "x".repeat(40) + "-00",
      bucketHash: "x".repeat(40),
      occurrence: 0,
      date: assertIsoDate("2026-07-05"),
      amount: Money.fromMinorNumber(-25990, "CLP"),
      normDesc: "PAYU *UBER EA",
      rawDesc: "PAYU *UBER EA",
      normVersion: NORMALIZE_VERSION,
      status: "posted",
    });

    touchIdentity(db, id, runId, "PAYU *UBER EATS");
    touchIdentity(db, id, runId, "PAYU *UBER EATS"); // duplicate: must not double-record
    setLmTxnId(db, id, 2430990248);

    const [identity] = identitiesInWindow(
      db,
      "a",
      assertIsoDate("2026-07-05"),
      assertIsoDate("2026-07-05"),
    );
    expect(identity?.descVariants).toEqual(["PAYU *UBER EATS"]);
    expect(identity?.lmTxnId).toBe(2430990248);
  });

  test("duplicate (account, external_id) is rejected by the unique constraint", () => {
    const db = freshDb();
    const runId = startRun(db, "santander", "obc");
    const mint = {
      accountId: "a",
      externalId: "y".repeat(40) + "-00",
      bucketHash: "y".repeat(40),
      occurrence: 0,
      date: assertIsoDate("2026-07-05"),
      amount: Money.fromMinorNumber(-1, "CLP"),
      normDesc: "D",
      rawDesc: "d",
      normVersion: NORMALIZE_VERSION,
      status: "posted" as const,
    };
    insertIdentity(db, runId, mint);
    expect(() => insertIdentity(db, runId, mint)).toThrow();
  });

  test("pushed balance upsert round-trips", () => {
    const db = freshDb();
    expect(lastPushedBalance(db, "santander-checking")).toBeNull();
    recordPushedBalance(db, "santander-checking", Money.fromMinorNumber(7654321, "CLP"));
    expect(lastPushedBalance(db, "santander-checking")?.minor).toBe(7654321n);
    recordPushedBalance(db, "santander-checking", Money.fromMinorNumber(9000000, "CLP"));
    expect(lastPushedBalance(db, "santander-checking")?.minor).toBe(9000000n);
  });
});
