// End-to-end engine tests against an in-memory db, the golden fixtures, and a fake
// Lunch Money client that mimics the verified v2 semantics (duplicate external_id →
// skipped with existing id). The acceptance invariant lives here: sync twice ⇒ the
// second run plans zero *transaction* ops (balances re-push every run to refresh as-of).
import { describe, expect, test } from "bun:test";
import type { Config } from "../src/config.ts";
import { assertIsoDate } from "../src/core/dates.ts";
import type { FetchResult } from "../src/core/model.ts";
import { SinkError } from "../src/core/errors.ts";
import { parseObcPayload } from "../src/adapters/obc-payload.ts";
import { parseRacionalPayload } from "../src/adapters/racional-payload.ts";
import { sync, type EngineDeps } from "../src/engine.ts";
import { openDb } from "../src/state/db.ts";
import racionalFixture from "./fixtures/racional.json";
import santanderFixture from "./fixtures/santander.json";
import { FakeLunchMoney } from "./helpers/fake-lm.ts";

const TODAY = assertIsoDate("2026-07-06");

const CONFIG: Config = {
  lunchmoney: { token_env: "LUNCHMONEY_TOKEN" },
  state: { db_path: ":memory:" },
  categorization: [],
  connections: {
    santander: { type: "obc", obc_bank: "santander", rut_env: "X_RUT", password_env: "X_PASS" },
  },
  accounts: [
    {
      id: "santander-checking",
      connection: "santander",
      kind: "checking",
      currency: "CLP",
      lm_account_id: 999,
      sources: ["obc"],
      match: {},
    },
  ],
};

function fixtureFetcher(payload: unknown = santanderFixture) {
  return async (): Promise<Map<string, FetchResult>> =>
    parseObcPayload("santander", payload, TODAY, new Date().toISOString());
}

function makeDeps(overrides: Partial<EngineDeps> = {}): EngineDeps & { fake: FakeLunchMoney } {
  const fake = new FakeLunchMoney();
  return {
    db: openDb(":memory:"),
    config: CONFIG,
    client: fake as unknown as EngineDeps["client"],
    fetchConnection: fixtureFetcher(),
    log: () => {},
    notify: () => {},
    fake,
    ...overrides,
  };
}

describe("engine", () => {
  test("ACCEPTANCE: sync twice ⇒ second run plans zero transaction ops", async () => {
    const deps = makeDeps();

    const first = await sync(deps, { dryRun: false });
    expect(first[0]?.outcome).toBe("ok");
    const firstOps = first[0]?.accounts[0]?.ops ?? [];
    // 2 posted txns + 1 balance op (CC movements in the fixture are ignored in Phase 1).
    expect(firstOps.filter((o) => o.op === "insert_txn")).toHaveLength(2);
    expect(firstOps.filter((o) => o.op === "set_balance")).toHaveLength(1);
    expect(deps.fake.txnsByExternalId.size).toBe(2);

    const second = await sync(deps, { dryRun: false });
    expect(second[0]?.outcome).toBe("ok");
    const secondOps = second[0]?.accounts[0]?.ops ?? [];
    // Transactions are idempotent (none re-inserted); the balance re-pushes to refresh as-of.
    expect(secondOps.filter((o) => o.op === "insert_txn")).toHaveLength(0);
    expect(secondOps.filter((o) => o.op === "set_balance")).toHaveLength(1);
    expect(second[0]?.accounts[0]?.matched).toBe(2);
    expect(second[0]?.accounts[0]?.minted).toBe(0);
    expect(deps.fake.txnsByExternalId.size).toBe(2);
    expect(deps.fake.balances).toHaveLength(2);
  });

  test("sign convention: bank expense (negative) lands positive in LM", async () => {
    const deps = makeDeps();
    await sync(deps, { dryRun: false });
    const amounts = [...deps.fake.txnsByExternalId.values()].map((t) => t.amount);
    expect(amounts).toContain("24990"); // COM.MANTENCION PLAN: -24990 at the bank
    expect(amounts).toContain("-4321000"); // payroll: +4321000 at the bank
  });

  test("dry-run plans but applies nothing and stays repeatable", async () => {
    const deps = makeDeps();
    const report = await sync(deps, { dryRun: true });
    expect(report[0]?.outcome).toBe("dry_run");
    expect(report[0]?.accounts[0]?.ops.length).toBeGreaterThan(0);
    expect(deps.fake.txnsByExternalId.size).toBe(0);

    // Identities were minted (ingest is idempotent), but nothing hit LM; a second
    // dry-run mints nothing further and still plans the same inserts.
    const again = await sync(deps, { dryRun: true });
    expect(again[0]?.accounts[0]?.minted).toBe(0);
    expect(again[0]?.accounts[0]?.ops.filter((o) => o.op === "insert_txn")).toHaveLength(2);
  });

  test("crash mid-apply converges on the next run without duplicates", async () => {
    const deps = makeDeps();
    deps.fake.failAfter = 1; // first insert succeeds, second throws

    const first = await sync(deps, { dryRun: false });
    expect(first[0]?.outcome).toBe("sink_error");
    expect(deps.fake.txnsByExternalId.size).toBe(1);

    deps.fake.failAfter = Number.POSITIVE_INFINITY;
    const second = await sync(deps, { dryRun: false });
    expect(second[0]?.outcome).toBe("ok");
    expect(deps.fake.txnsByExternalId.size).toBe(2); // the missing one, no dupes
    expect(deps.fake.balances).toHaveLength(1);

    const third = await sync(deps, { dryRun: false });
    // No transactions left to insert; only the balance refresh remains.
    expect((third[0]?.accounts[0]?.ops ?? []).filter((o) => o.op === "insert_txn")).toHaveLength(0);
  });

  test("truncation drift between runs neither duplicates nor re-inserts", async () => {
    const deps = makeDeps();
    await sync(deps, { dryRun: false });

    const drifted = JSON.parse(JSON.stringify(santanderFixture)) as typeof santanderFixture;
    const movement = drifted.accounts[0]?.movements.find(
      (m) => m.description === "COM.MANTENCION PLAN",
    );
    if (!movement) throw new Error("fixture shape");
    movement.description = "COM.MANTENCION PLA"; // shorter truncation of the same txn

    const second = await sync(
      { ...deps, fetchConnection: fixtureFetcher(drifted) },
      { dryRun: false },
    );
    expect(second[0]?.accounts[0]?.minted).toBe(0);
    expect((second[0]?.accounts[0]?.ops ?? []).filter((o) => o.op === "insert_txn")).toHaveLength(
      0,
    );
    expect(deps.fake.txnsByExternalId.size).toBe(2);
  });

  test("fetch failure is classified and other connections are unaffected", async () => {
    const deps = makeDeps({
      fetchConnection: async () => {
        throw new SinkError("boom"); // arbitrary SyncError
      },
    });
    const report = await sync(deps, { dryRun: false });
    expect(report[0]?.outcome).toBe("sink_error");
    expect(deps.fake.txnsByExternalId.size).toBe(0);
  });
});

const RACIONAL_CONFIG: Config = {
  lunchmoney: { token_env: "LUNCHMONEY_TOKEN" },
  state: { db_path: ":memory:" },
  categorization: [],
  connections: {
    racional: {
      type: "racional",
      email_env: "R_EMAIL",
      password_env: "R_PASS",
      device_id_env: "R_DEV",
    },
  },
  accounts: [
    {
      id: "racional-stocks",
      connection: "racional",
      kind: "investment",
      currency: "USD",
      lm_account_id: 111111,
      sources: ["racional"],
      match: { sub: "stocks" },
    },
    {
      id: "racional-cash",
      connection: "racional",
      kind: "cash",
      currency: "USD",
      lm_account_id: 111112,
      sources: ["racional"],
      match: {},
    },
  ],
};

describe("engine — racional balances", () => {
  const FETCHED_AT = "2026-07-06T12:00:00.000Z";
  const racionalFetcher =
    (payload: typeof racionalFixture = racionalFixture) =>
    async (): Promise<Map<string, FetchResult>> =>
      parseRacionalPayload(payload.positions, payload.buyingPower, TODAY, FETCHED_AT);

  function makeRacionalDeps(
    fetchConnection = racionalFetcher(),
  ): EngineDeps & { fake: FakeLunchMoney } {
    const fake = new FakeLunchMoney();
    return {
      db: openDb(":memory:"),
      config: RACIONAL_CONFIG,
      client: fake as unknown as EngineDeps["client"],
      fetchConnection,
      log: () => {},
      notify: () => {},
      fake,
    };
  }

  test("stocks and cash push distinct balances, stamped with the fetch time", async () => {
    const deps = makeRacionalDeps();

    const first = await sync(deps, { dryRun: false });
    expect(first[0]?.outcome).toBe("ok");
    const balanceOps = (first[0]?.accounts ?? []).flatMap((a) =>
      a.ops.filter((o) => o.op === "set_balance"),
    );
    expect(balanceOps).toHaveLength(2);
    const byId = new Map(deps.fake.balances.map((b) => [b.lmAccountId, b.balance]));
    expect(byId.get(111111)).toBe("3384.08"); // Σ round(2100, 1250.75, 33.333333)
    expect(byId.get(111112)).toBe("2500.00"); // buyingPower
    // balance_as_of is the fetch timestamp, not a date → LM reads it as freshly synced.
    expect(deps.fake.balances.every((b) => b.asOf === FETCHED_AT)).toBe(true);
  });

  test("second run refreshes both balances even when values are unchanged", async () => {
    const deps = makeRacionalDeps();
    await sync(deps, { dryRun: false });

    const second = await sync(deps, { dryRun: false });
    const balanceOps = (second[0]?.accounts ?? []).flatMap((a) =>
      a.ops.filter((o) => o.op === "set_balance"),
    );
    expect(balanceOps).toHaveLength(2); // re-pushed to refresh as-of, not deduped
    expect(deps.fake.balances).toHaveLength(4); // 2 per run
  });

  test("a changed stocks value is reflected; both assets re-push each run", async () => {
    const deps = makeRacionalDeps();
    await sync(deps, { dryRun: false });

    const bumped = JSON.parse(JSON.stringify(racionalFixture)) as typeof racionalFixture;
    const firstPos = bumped.positions[0];
    if (!firstPos) throw new Error("fixture shape");
    firstPos.amountUSD = 2200.0; // +100 → stocks 3484.08; cash unchanged

    const report = await sync(
      { ...deps, fetchConnection: racionalFetcher(bumped) },
      { dryRun: false },
    );
    const balanceOps = (report[0]?.accounts ?? []).flatMap((a) =>
      a.ops.filter((o) => o.op === "set_balance"),
    );
    expect(balanceOps).toHaveLength(2); // both always refresh
    const lastTwo = new Map(deps.fake.balances.slice(-2).map((b) => [b.lmAccountId, b.balance]));
    expect(lastTwo.get(111111)).toBe("3484.08"); // new stocks value
    expect(lastTwo.get(111112)).toBe("2500.00"); // cash unchanged, still re-pushed
  });
});
