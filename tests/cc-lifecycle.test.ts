// Credit-card lifecycle: statement close (unbilled → billed with description drift and
// posting-date shift), cuotas, same-run overlap, vanish flags, and illegal transitions.
// Payloads are built in the Santander flat shape (dd-mm-yyyy unbilled, ISO billed).
import { describe, expect, test } from "bun:test";
import type { Config } from "../src/config.ts";
import { assertIsoDate } from "../src/core/dates.ts";
import type { FetchResult } from "../src/core/model.ts";
import { parseObcPayload } from "../src/adapters/obc-payload.ts";
import { sync, type EngineDeps } from "../src/engine.ts";
import { openDb } from "../src/state/db.ts";
import { flaggedIdentities, openUnbilledIdentities } from "../src/state/repo.ts";
import { FakeLunchMoney } from "./helpers/fake-lm.ts";

const TODAY = assertIsoDate("2026-07-06");

const CONFIG: Config = {
  lunchmoney: { token_env: "LUNCHMONEY_TOKEN" },
  state: { db_path: ":memory:" },
  connections: {
    santander: { type: "obc", obc_bank: "santander", rut_env: "X_RUT", password_env: "X_PASS" },
  },
  accounts: [
    {
      id: "santander-cc",
      connection: "santander",
      kind: "credit_card",
      currency: "CLP",
      lm_account_id: 998,
      sources: ["obc"],
      match: {},
    },
  ],
};

interface Mov {
  date: string;
  description: string;
  amount: number;
  source: "credit_card_unbilled" | "credit_card_billed";
  installments?: string;
}

function unbilled(ddmmDate: string, description: string, amount: number): Mov {
  return { date: ddmmDate, description, amount, source: "credit_card_unbilled" };
}

function billed(isoDate: string, description: string, amount: number, installments?: string): Mov {
  return {
    date: isoDate,
    description,
    amount,
    source: "credit_card_billed",
    ...(installments ? { installments } : {}),
  };
}

function payload(movements: Mov[]): unknown {
  return {
    success: true,
    bank: "santander",
    accounts: [
      {
        label: null,
        balance: 1000000,
        movements: movements.map((m) => ({ ...m, balance: 0 })),
      },
    ],
  };
}

function fetcher(movements: Mov[]) {
  return async (): Promise<Map<string, FetchResult>> =>
    parseObcPayload("santander", payload(movements), TODAY, new Date().toISOString());
}

function makeDeps(): EngineDeps & { fake: FakeLunchMoney } {
  const fake = new FakeLunchMoney();
  return {
    db: openDb(":memory:"),
    config: CONFIG,
    client: fake as unknown as EngineDeps["client"],
    fetchConnection: fetcher([]),
    log: () => {},
    notify: () => {},
    fake,
  };
}

async function syncWith(deps: ReturnType<typeof makeDeps>, movements: Mov[]) {
  const reports = await sync({ ...deps, fetchConnection: fetcher(movements) }, { dryRun: false });
  const account = reports[0]?.accounts[0];
  if (!account) throw new Error(`no account report: ${JSON.stringify(reports)}`);
  return account;
}

describe("credit-card lifecycle", () => {
  test("ACCEPTANCE: statement close transitions without duplicates or orphans", async () => {
    const deps = makeDeps();

    // Run A (pre-close): two unbilled purchases + one already-billed cuota.
    const runA = await syncWith(deps, [
      unbilled("03-07-2026", "PAYU *UBER TR", -5000),
      unbilled("04-07-2026", "40515-SBX COLON", -6150),
      billed("2026-05-26", "TIENDA CUOTAS", -10000, "02/06"),
    ]);
    expect(runA.minted).toBe(3);
    expect(deps.fake.txnsByExternalId.size).toBe(3);

    // Run B (statement close): both unbilled now billed — one with description drift
    // (same date), one with a +1d posting-date shift — plus the NEXT cuota and a fresh
    // unbilled purchase.
    const runB = await syncWith(deps, [
      billed("2026-07-03", "PAYU   *UBER TRIP", -5000), // desc drift, same date
      billed("2026-07-05", "40515-SBX COLON", -6150), // date shifted +1d
      billed("2026-05-26", "TIENDA CUOTAS", -10000, "02/06"), // old cuota, still listed
      billed("2026-06-26", "TIENDA CUOTAS", -10000, "03/06"), // next cuota: NEW txn
      unbilled("06-07-2026", "NUEVO CAFE", -3000),
    ]);

    expect(runB.transitioned).toBe(2); // both unbilled became billed
    expect(runB.minted).toBe(2); // next cuota + fresh unbilled only
    expect(runB.vanishFlagged).toBe(0); // transitions are not disappearances
    // LM: the two transitioned purchases were NOT re-inserted.
    expect(deps.fake.txnsByExternalId.size).toBe(5);
    expect(openUnbilledIdentities(deps.db, "santander-cc")).toHaveLength(1); // NUEVO CAFE

    // Run C: identical to run B ⇒ full no-op.
    const runC = await syncWith(deps, [
      billed("2026-07-03", "PAYU   *UBER TRIP", -5000),
      billed("2026-07-05", "40515-SBX COLON", -6150),
      billed("2026-05-26", "TIENDA CUOTAS", -10000, "02/06"),
      billed("2026-06-26", "TIENDA CUOTAS", -10000, "03/06"),
      unbilled("06-07-2026", "NUEVO CAFE", -3000),
    ]);
    expect(runC.minted).toBe(0);
    expect(runC.transitioned).toBe(0);
    expect(runC.ops).toHaveLength(0);
    expect(deps.fake.txnsByExternalId.size).toBe(5);
  });

  test("cuota payee carries the installment index; cuotas are distinct identities", async () => {
    const deps = makeDeps();
    await syncWith(deps, [
      billed("2026-05-26", "TIENDA CUOTAS", -10000, "02/06"),
      billed("2026-06-26", "TIENDA CUOTAS", -10000, "03/06"),
    ]);
    const payees = [...deps.fake.txnsByExternalId.values()].map((t) => t.payee).sort();
    expect(payees).toEqual(["TIENDA CUOTAS (02/06)", "TIENDA CUOTAS (03/06)"]);
  });

  test("same-run unbilled/billed overlap collapses to one billed identity", async () => {
    const deps = makeDeps();
    const report = await syncWith(deps, [
      unbilled("05-07-2026", "PAYU *UBER EA", -25990),
      billed("2026-07-05", "PAYU *UBER EATS", -25990),
    ]);
    expect(report.minted).toBe(1);
    expect(deps.fake.txnsByExternalId.size).toBe(1);
    expect(openUnbilledIdentities(deps.db, "santander-cc")).toHaveLength(0); // billed won
  });

  test("vanished unbilled txn is flagged, kept in LM, and unflagged on reappearance", async () => {
    const deps = makeDeps();
    await syncWith(deps, [
      unbilled("02-07-2026", "HOLD HOTEL", -50000),
      unbilled("03-07-2026", "PAYU *UBER TR", -5000),
    ]);
    expect(deps.fake.txnsByExternalId.size).toBe(2);

    // Run 2: the hotel hold is gone from the feed (and not billed).
    const run2 = await syncWith(deps, [unbilled("03-07-2026", "PAYU *UBER TR", -5000)]);
    expect(run2.vanishFlagged).toBe(1);
    const flagged = flaggedIdentities(deps.db);
    expect(flagged).toHaveLength(1);
    expect(flagged[0]?.rawDesc).toBe("HOLD HOTEL");
    // Never auto-deleted from LM.
    expect(deps.fake.txnsByExternalId.size).toBe(2);

    // Run 3: it reappears (the hold was re-posted) ⇒ flag clears.
    const run3 = await syncWith(deps, [
      unbilled("02-07-2026", "HOLD HOTEL", -50000),
      unbilled("03-07-2026", "PAYU *UBER TR", -5000),
    ]);
    expect(run3.vanishFlagged).toBe(0);
    expect(flaggedIdentities(deps.db)).toHaveLength(0);
  });

  test("illegal billed→unbilled observation flags, never rewinds", async () => {
    const deps = makeDeps();
    await syncWith(deps, [billed("2026-07-03", "PAYU *UBER TRIP", -5000)]);

    const report = await syncWith(deps, [unbilled("03-07-2026", "PAYU *UBER TRIP", -5000)]);
    expect(report.transitioned).toBe(0);
    const flagged = flaggedIdentities(deps.db);
    expect(flagged[0]?.flagged).toContain("illegal transition billed→unbilled");
    expect(flagged[0]?.status).toBe("billed"); // state not rewound
    expect(deps.fake.txnsByExternalId.size).toBe(1);
  });

  test("unbilled insert reaches LM immediately (pending-spend visibility)", async () => {
    const deps = makeDeps();
    const report = await syncWith(deps, [unbilled("05-07-2026", "PAYU *UBER EA", -25990)]);
    expect(report.ops.filter((o) => o.op === "insert_txn")).toHaveLength(1);
    const [txn] = deps.fake.txnsByExternalId.values();
    expect(txn?.amount).toBe("25990"); // expense-positive in LM
  });
});
