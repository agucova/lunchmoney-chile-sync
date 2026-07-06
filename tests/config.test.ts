// config.example.toml must always parse under the real schema (and the local,
// gitignored config.toml too, when present); the schema's cross-checks must reject
// the classic misconfigurations.
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { loadConfig, parseConfig } from "../src/config.ts";

const EXAMPLE_PATH = new URL("../config.example.toml", import.meta.url).pathname;
const CONFIG_PATH = new URL("../config.toml", import.meta.url).pathname;
const hasLocalConfig = existsSync(CONFIG_PATH);

// A minimal valid config (one racional + one obc connection) to mutate in negative tests.
function baseConfig(): Record<string, unknown> {
  return {
    lunchmoney: { token_env: "LUNCHMONEY_TOKEN" },
    state: { db_path: ":memory:" },
    connections: {
      racional: { type: "racional", email_env: "E", password_env: "P", device_id_env: "D" },
      santander: { type: "obc", obc_bank: "santander", rut_env: "R", password_env: "P" },
    },
    accounts: [
      {
        id: "stocks",
        connection: "racional",
        kind: "investment",
        currency: "USD",
        lm_account_id: 1,
        sources: ["racional"],
        match: { sub: "stocks" },
      },
    ],
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- deep access into the mutable clone
type Any = any;
function clone(): Any {
  return JSON.parse(JSON.stringify(baseConfig()));
}

describe("config files", () => {
  test("config.example.toml parses under the real schema", async () => {
    const config = await loadConfig(EXAMPLE_PATH);
    expect(config.accounts.length).toBeGreaterThanOrEqual(2);
    for (const account of config.accounts) {
      expect(config.connections).toHaveProperty(account.connection);
    }
    const ids = config.accounts.map((a) => a.id);
    const lmIds = config.accounts.map((a) => a.lm_account_id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(lmIds).size).toBe(lmIds.length);
  });

  test.if(hasLocalConfig)("local config.toml parses under the real schema", async () => {
    const config = await loadConfig(CONFIG_PATH);
    expect(config.accounts.length).toBeGreaterThanOrEqual(2);
    const lmIds = config.accounts.map((a) => a.lm_account_id);
    expect(new Set(lmIds).size).toBe(lmIds.length);
  });
});

describe("config schema (fail closed)", () => {
  test("the base fixture is valid", () => {
    expect(() => parseConfig(baseConfig())).not.toThrow();
  });

  test("a connection without a type is rejected", () => {
    const bad = clone();
    delete bad.connections.santander.type;
    expect(() => parseConfig(bad)).toThrow();
  });

  test("a racional connection carrying an obc-only key is rejected (strict)", () => {
    const bad = clone();
    bad.connections.racional.obc_bank = "santander";
    expect(() => parseConfig(bad)).toThrow();
  });

  test("an account whose sources exclude its connection's type is rejected", () => {
    const bad = clone();
    bad.accounts[0].sources = ["obc"]; // connection is racional
    expect(() => parseConfig(bad)).toThrow(/do not include/);
  });

  test("an unknown racional sub is rejected at boot", () => {
    const bad = clone();
    bad.accounts[0].match.sub = "bogus";
    expect(() => parseConfig(bad)).toThrow(/unknown racional sub/);
  });

  test("match.sub on a non-racional account is rejected", () => {
    const bad = clone();
    bad.accounts.push({
      id: "checking",
      connection: "santander",
      kind: "checking",
      currency: "CLP",
      lm_account_id: 2,
      sources: ["obc"],
      match: { sub: "stocks" },
    });
    expect(() => parseConfig(bad)).toThrow(/only valid on racional/);
  });

  test("two accounts resolving to the same sub-account on one connection are rejected", () => {
    const bad = clone();
    bad.accounts.push({
      id: "stocks-dupe",
      connection: "racional",
      kind: "investment",
      currency: "USD",
      lm_account_id: 2, // distinct LM id, so this trips the sub-account check specifically
      sources: ["racional"],
      match: { sub: "stocks" },
    });
    expect(() => parseConfig(bad)).toThrow(/same sub-account/);
  });
});
