// CLI entry point.
//   sync [--dry-run] [--config path] [account…]   — fetch, plan, apply (or print plan)
//   status [--config path]                        — recent runs, pending work, flags

import { object, or } from "@optique/core/constructs";
import { multiple, withDefault } from "@optique/core/modifiers";
import { argument, command, constant, flag, option } from "@optique/core/primitives";
import { string } from "@optique/core/valueparser";
import { run } from "@optique/run";
import type { ConnectionConfig } from "./config.ts";
import { loadConfig, requireEnv } from "./config.ts";
import { fetchObcConnection } from "./adapters/obc.ts";
import { fetchRacionalConnection } from "./adapters/racional.ts";
import type { FetchResult } from "./core/model.ts";
import { sync } from "./engine.ts";
import { LunchMoneyClient } from "./sink/lunchmoney.ts";
import { openDb } from "./state/db.ts";
import { flaggedIdentities, identitiesAwaitingLm, recentRuns } from "./state/repo.ts";

const configOption = withDefault(option("--config", string({ metavar: "PATH" })), "config.toml");

const syncCommand = command(
  "sync",
  object({
    action: constant("sync"),
    dryRun: withDefault(flag("--dry-run"), false),
    config: configOption,
    accounts: multiple(argument(string({ metavar: "ACCOUNT" }))),
  }),
);

const statusCommand = command(
  "status",
  object({
    action: constant("status"),
    config: configOption,
  }),
);

const args = run(or(syncCommand, statusCommand), { programName: "lunchmoney-chile-sync" });

function notify(message: string): void {
  // Best-effort push (ai-notify routes to desktop or phone); never fails the sync.
  try {
    Bun.spawn(["ai-notify", "lunchmoney-sync", message, "--remote"], {
      stdout: "ignore",
      stderr: "ignore",
    });
  } catch {
    // ai-notify not installed (e.g. dev machine without the tool) — the log line stands.
  }
}

// Source dispatch lives at the composition root: the engine stays source-agnostic and each
// branch narrows the connection union to its adapter's exact config type. Adding a source is
// one more case here (a missing return would be a compile error — the exhaustiveness guard).
function fetchConnection(
  connection: ConnectionConfig,
  hooks: { onProgress?: (step: string) => void; onTwoFactorWait?: () => void },
): Promise<Map<string, FetchResult>> {
  switch (connection.type) {
    case "obc":
      return fetchObcConnection(connection, hooks);
    case "racional":
      return fetchRacionalConnection(connection, hooks);
  }
}

const config = await loadConfig(
  args.config.startsWith("/") ? args.config : `${process.cwd()}/${args.config}`,
);
const db = openDb(config.state.db_path);

if (args.action === "sync") {
  const unknown = args.accounts.filter((id) => !config.accounts.some((a) => a.id === id));
  if (unknown.length > 0) {
    console.error(
      `unknown account(s): ${unknown.join(", ")} (configured: ${config.accounts
        .map((a) => a.id)
        .join(", ")})`,
    );
    process.exit(2);
  }

  const client = new LunchMoneyClient(requireEnv(config.lunchmoney.token_env));
  const reports = await sync(
    {
      db,
      config,
      client,
      fetchConnection,
      log: (message) => console.log(message),
      notify,
    },
    {
      dryRun: args.dryRun,
      ...(args.accounts.length > 0 ? { accountIds: args.accounts } : {}),
    },
  );

  const failed = reports.filter((r) => r.outcome !== "ok" && r.outcome !== "dry_run");
  if (failed.length > 0) {
    notify(`sync failed: ${failed.map((r) => `${r.connectionId} (${r.outcome})`).join(", ")}`);
    process.exit(1);
  }
  process.exit(0);
}

// status
console.log("recent runs:");
for (const runRow of recentRuns(db, 10)) {
  const finished = runRow.finishedAt ?? "…";
  console.log(
    `  #${runRow.id}  ${runRow.startedAt}  ${runRow.connectionId}/${runRow.source}  ` +
      `${runRow.outcome ?? "running"}${runRow.error ? `  ${runRow.error.slice(0, 80)}` : ""}  (${finished})`,
  );
}

let pendingTotal = 0;
for (const account of config.accounts) {
  const pending = identitiesAwaitingLm(db, account.id);
  pendingTotal += pending.length;
  if (pending.length > 0) {
    console.log(`\n${account.id}: ${pending.length} identity(ies) awaiting LM insert`);
  }
}
if (pendingTotal === 0) console.log("\nno identities awaiting LM insert");

const flagged = flaggedIdentities(db);
if (flagged.length > 0) {
  console.log(`\nflagged identities (${flagged.length}):`);
  for (const identity of flagged) {
    console.log(
      `  ${identity.accountId}  ${identity.date}  ${identity.amount.toString()}  ` +
        `${identity.rawDesc}  — ${identity.flagged}`,
    );
  }
}
