// Config loading. Fail-closed at boot: an invalid config never starts a sync.
// Secrets are env-var *references* here, never values.

import { z } from "zod";
import { invariant } from "./core/errors.ts";
import { expectedSubAccountKey } from "./core/model.ts";
import { isCurrencyCode } from "./core/money.ts";

// Connections are a discriminated union on `type`: each source shapes its own credential
// references. `.strict()` on every branch makes a typo'd key a boot error, not a silent
// drop. The `type` doubles as the run's source label (engine startRun) and the dispatch
// discriminant (main.ts).
const ObcConnectionSchema = z
  .object({
    type: z.literal("obc"),
    /** open-banking-chile bank id for the obc source (e.g. "santander", "bchile"). */
    obc_bank: z.string().min(1),
    rut_env: z.string().min(1),
    password_env: z.string().min(1),
  })
  .strict();

const RacionalConnectionSchema = z
  .object({
    type: z.literal("racional"),
    email_env: z.string().min(1),
    password_env: z.string().min(1),
    /** Env ref for a Racional-trusted device UUID (custom MFA gate; see docs/racional-api.md). */
    device_id_env: z.string().min(1),
  })
  .strict();

const BetterplanConnectionSchema = z
  .object({
    type: z.literal("betterplan"),
    /**
     * Env ref for the bootstrap OAuth refresh token (BetterPlan rotates it every use, so the
     * live token is persisted in the state db; this env value only seeds the first run and,
     * if changed, forces a re-bootstrap — see src/adapters/betterplan-auth.ts).
     */
    refresh_token_env: z.string().min(1),
  })
  .strict();

const SantanderConnectionSchema = z
  .object({
    type: z.literal("santander"),
    /**
     * Native Santander JSON-API source: a browser harvests the (Akamai-gated) OAuth token,
     * then all data is pure HTTP (src/adapters/santander/). Credentials seed the browser
     * login; the minted token is cached in the state db.
     */
    rut_env: z.string().min(1),
    password_env: z.string().min(1),
  })
  .strict();

const ConnectionSchema = z.discriminatedUnion("type", [
  ObcConnectionSchema,
  RacionalConnectionSchema,
  BetterplanConnectionSchema,
  SantanderConnectionSchema,
]);

/**
 * Racional sub-account facets selectable via `match.sub` (src/adapters/racional-payload.ts).
 * Only "stocks" needs a sub — the cash sweep is its own `kind: "cash"` sub-account (keyed
 * plainly "cash"). Validated at boot so a typo fails loudly here, not after a full fetch.
 */
const RACIONAL_SUBS = ["stocks"] as const;

const AccountSchema = z.object({
  id: z.string().min(1),
  connection: z.string().min(1),
  kind: z.enum(["checking", "savings", "cash", "credit_card", "investment"]),
  currency: z.string().refine(isCurrencyCode, { message: "unknown currency code" }),
  /** Lunch Money v2 manual_account id. */
  lm_account_id: z.number().int().positive(),
  /** Ordered: first is primary, the rest are fallbacks. */
  sources: z.array(z.enum(["obc", "racional", "betterplan", "santander"])).min(1),
  match: z
    .object({
      card_last4: z
        .string()
        .regex(/^\d{4}$/)
        .optional(),
      /** Source-defined sub-account facet (racional: "stocks"; santander: currency code). */
      sub: z.string().min(1).optional(),
    })
    .default({}),
});

const ConfigSchema = z
  .object({
    lunchmoney: z.object({
      token_env: z.string().min(1).default("LUNCHMONEY_TOKEN"),
    }),
    state: z.object({
      db_path: z.string().min(1).default("state.sqlite"),
    }),
    connections: z.record(z.string(), ConnectionSchema),
    accounts: z.array(AccountSchema).min(1),
    // Ordered payee → category rules; first match wins, applied at plan time so synced
    // transactions arrive categorized. Patterns are validated here (fail closed at load)
    // so a bad regex never surfaces as a 3am sync crash.
    categorization: z
      .array(
        z.object({
          pattern: z
            .string()
            .min(1)
            .refine(
              (p) => {
                try {
                  new RegExp(p);
                  return true;
                } catch {
                  return false;
                }
              },
              { message: "invalid regular expression" },
            ),
          category_id: z.number().int().positive(),
        }),
      )
      .default([]),
  })
  .superRefine((config, ctx) => {
    const ids = new Set<string>();
    const lmIds = new Set<number>();
    // One connection must never route two accounts to the same sub-account key, or the
    // adapter's single FetchResult for that key would be applied to both (double-push).
    const subAccountKeys = new Set<string>();
    for (const account of config.accounts) {
      if (ids.has(account.id)) {
        ctx.addIssue({ code: "custom", message: `duplicate account id: ${account.id}` });
      }
      ids.add(account.id);
      if (lmIds.has(account.lm_account_id)) {
        ctx.addIssue({
          code: "custom",
          message: `two accounts map to LM account ${account.lm_account_id}`,
        });
      }
      lmIds.add(account.lm_account_id);

      const connection = config.connections[account.connection];
      if (!connection) {
        ctx.addIssue({
          code: "custom",
          message: `account ${account.id} references unknown connection ${account.connection}`,
        });
        continue; // remaining checks need the connection
      }

      // The connection's source must be one this account draws from.
      if (!account.sources.includes(connection.type)) {
        ctx.addIssue({
          code: "custom",
          message: `account ${account.id} sources [${account.sources.join(", ")}] do not include its connection's type "${connection.type}"`,
        });
      }

      // `match.sub` names a source-defined facet the adapter emits. Racional: a fixed facet
      // name from RACIONAL_SUBS. Betterplan: a goal id — dynamic/per-user, so there is no boot-
      // time allowlist; it's validated by shape and a typo surfaces as runtime schema_drift
      // (the engine rejects a missing sub-account key). Santander: a currency code (one
      // connection yields per-currency checking + card sub-accounts). Other sources don't use subs.
      if (account.match.sub !== undefined) {
        if (connection.type === "racional") {
          if (!(RACIONAL_SUBS as readonly string[]).includes(account.match.sub)) {
            ctx.addIssue({
              code: "custom",
              message: `account ${account.id}: unknown racional sub "${account.match.sub}" (expected one of ${RACIONAL_SUBS.join(", ")})`,
            });
          }
        } else if (connection.type === "betterplan") {
          if (!/^\d+$/.test(account.match.sub)) {
            ctx.addIssue({
              code: "custom",
              message: `account ${account.id}: betterplan match.sub must be a numeric goal id (got "${account.match.sub}")`,
            });
          }
        } else if (connection.type === "santander") {
          if (!isCurrencyCode(account.match.sub)) {
            ctx.addIssue({
              code: "custom",
              message: `account ${account.id}: santander match.sub must be a currency code (got "${account.match.sub}")`,
            });
          }
        } else {
          ctx.addIssue({
            code: "custom",
            message: `account ${account.id}: match.sub is not valid on ${connection.type} connections`,
          });
        }
      }

      const key = `${account.connection} ${expectedSubAccountKey(account)}`;
      if (subAccountKeys.has(key)) {
        ctx.addIssue({
          code: "custom",
          message: `two accounts on connection ${account.connection} resolve to the same sub-account ${expectedSubAccountKey(account)}`,
        });
      }
      subAccountKeys.add(key);

      // card_last4 is optional: flat-shape connections (Santander) expose one card
      // sub-account with no label; nested shapes (BdCh) require it to disambiguate.
      // The engine rejects a missing sub-account key at runtime either way.
    }
  });

export type Config = z.infer<typeof ConfigSchema>;
export type AccountConfig = Config["accounts"][number];
export type ConnectionConfig = Config["connections"][string];
export type ObcConnectionConfig = z.infer<typeof ObcConnectionSchema>;
export type RacionalConnectionConfig = z.infer<typeof RacionalConnectionSchema>;
export type BetterplanConnectionConfig = z.infer<typeof BetterplanConnectionSchema>;
export type SantanderConnectionConfig = z.infer<typeof SantanderConnectionSchema>;

/** Validate a raw config object (post-TOML-parse). Throws ZodError on any violation. */
export function parseConfig(raw: unknown): Config {
  return ConfigSchema.parse(raw);
}

export async function loadConfig(path: string): Promise<Config> {
  const imported = (await import(path)) as { default: unknown };
  return parseConfig(imported.default);
}

/** Resolve a secret env reference; missing secrets are a boot error, not a 3am error. */
export function requireEnv(name: string): string {
  const value = process.env[name];
  invariant(value && value.length > 0, `missing required env var: ${name}`);
  return value;
}
