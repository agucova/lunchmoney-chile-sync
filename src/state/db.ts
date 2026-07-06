// State db bootstrap: bun:sqlite + drizzle, WAL mode, migrations applied at open.
// Schema lives in ./schema.ts (single source of truth); drizzle-kit generates the
// migration files under ./drizzle.

import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import * as schema from "./schema.ts";

const MIGRATIONS_FOLDER = new URL("../../drizzle", import.meta.url).pathname;

export function openDb(path: string) {
  const sqlite = new Database(path, { create: true });
  sqlite.exec("PRAGMA journal_mode = WAL;");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return db;
}

export type Db = ReturnType<typeof openDb>;
