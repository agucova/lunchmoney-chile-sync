// santander source adapter: pure HTTP against the bank's native JSON API, no browser.
// One inventory call discovers every product (contracts, currencies, balances); per-product
// calls fetch checking movements and card movements per currency leg.
//
// Sub-account keying is kind:CURRENCY ("checking:CLP", "credit_card:USD") — one Santander
// connection carries two checking accounts and two card legs distinguished only by
// currency. The credit line (LCR) is reported via onProgress and skipped: it has no
// mapped LM account and no movement feed wired yet.
//
// Card results deliberately declare NO unbilled coverage yet: the billed-statement
// endpoints (estadoCuentaNacional + its international sibling) are not integrated, so a
// purchase leaving the últimos-movimientos feed at statement close is billing, not a
// reversal — with coverage declared, every one of them would be a false vanish flag.
// Reversal detection for these cards resumes when the billed feeds land.

import { addDays, assertPlausibleDates, todayInSantiago, type IsoDate } from "../../core/dates.ts";
import { SchemaDriftError } from "../../core/errors.ts";
import type { CanonicalTxn, FetchResult } from "../../core/model.ts";
import { subAccountKey } from "../../core/model.ts";
import { persistRawPayload } from "../raw-payload.ts";
import { SantanderClient, type SantanderCredentials } from "./client.ts";
import {
  parseCardMovements,
  parseCheckingTransactions,
  parseInventory,
  type SantanderProduct,
} from "./payload.ts";

export interface SantanderHooks {
  onProgress?: (step: string) => void;
}

export interface SantanderFetchOptions {
  /** How far back checking movements are requested. */
  windowDays?: number;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  today?: IsoDate;
}

const DEFAULT_WINDOW_DAYS = 60;

/** The two card currency legs Santander exposes (same contract, per-currency statements). */
const CARD_CURRENCIES = ["CLP", "USD"] as const;

/** Parse with the shared fail-closed contract: on drift, persist the raw payload. */
async function parseOrPersist<T>(
  label: string,
  payload: unknown,
  parse: (p: unknown) => T,
): Promise<T> {
  try {
    return parse(payload);
  } catch (err) {
    if (err instanceof SchemaDriftError) {
      const path = await persistRawPayload(label, payload);
      throw new SchemaDriftError(`${err.message} (raw payload: ${path})`, path, err);
    }
    throw err;
  }
}

/**
 * Fetch every mapped Santander product and return per-sub-account FetchResults
 * (keyed by subAccountKey). Throws classified SyncErrors; any schema drift discards
 * the whole result (fail closed, never partially ingest).
 */
export async function fetchSantanderData(
  credentials: SantanderCredentials,
  hooks: SantanderHooks = {},
  options: SantanderFetchOptions = {},
): Promise<Map<string, FetchResult>> {
  const client = new SantanderClient(credentials, options.fetchImpl ?? fetch);
  const today = options.today ?? todayInSantiago();
  const opening = addDays(today, -(options.windowDays ?? DEFAULT_WINDOW_DAYS));
  const fetchedAt = new Date().toISOString();
  const sourceMeta = { source: "santander" as const, fetchedAt };

  hooks.onProgress?.("consultando inventario de productos");
  const products = await parseOrPersist(
    "santander-inventory",
    await client.fetchInventory(),
    parseInventory,
  );

  const results = new Map<string, FetchResult>();
  const put = (key: string, result: FetchResult) => {
    if (results.has(key)) {
      throw new SchemaDriftError(
        `santander inventory maps two products to sub-account ${key} — keying needs a new disambiguator`,
      );
    }
    results.set(key, result);
  };

  const checkPlausible = (txns: readonly CanonicalTxn[]) => {
    assertPlausibleDates(
      txns.map((t) => t.date),
      today,
    );
    return txns;
  };

  for (const product of products) {
    switch (product.group) {
      case "CCC": {
        hooks.onProgress?.(`movimientos ${product.glosa} (${product.currency})`);
        const payload = await client.fetchCheckingTransactions({
          office: product.office,
          contract: product.contract,
          currency: product.currency,
          opening,
          closing: today,
        });
        const txns = checkPlausible(
          await parseOrPersist(`santander-checking-${product.currency}`, payload, (p) =>
            parseCheckingTransactions(p, product.currency),
          ),
        );
        put(subAccountKey({ kind: "checking", sub: product.currency }), {
          coverage: { posted: { from: opening, to: today } },
          facets: {
            transactions: txns,
            balance: { amount: product.available, asOf: today },
          },
          sourceMeta,
        });
        break;
      }
      case "TCR": {
        // One inventory entry per currency leg; each leg is fetched with its own Moneda.
        if (!(CARD_CURRENCIES as readonly string[]).includes(product.currency)) {
          throw new SchemaDriftError(
            `santander card leg in unobserved currency ${product.currency}`,
          );
        }
        hooks.onProgress?.(`movimientos tarjeta ${product.glosa} (${product.currency})`);
        const payload = await client.fetchCardMovements({
          office: product.office,
          contract: product.contract,
          currency: product.currency,
        });
        const txns = checkPlausible(
          await parseOrPersist(`santander-card-${product.currency}`, payload, (p) =>
            parseCardMovements(p, product.currency),
          ),
        );
        put(subAccountKey({ kind: "credit_card", sub: product.currency }), {
          // No coverage declared: see the header note on vanish flags vs billed feeds.
          coverage: {},
          facets: {
            transactions: txns,
            // MONTOUTILIZADO = amount owed on this leg (used + available = cupo,
            // verified against live data); LM credit assets store owed as positive.
            balance: { amount: product.used, asOf: today },
          },
          sourceMeta,
        });
        break;
      }
      case "LCR":
        hooks.onProgress?.(`omitiendo ${product.glosa} (línea de crédito, sin cuenta LM mapeada)`);
        break;
    }
  }

  if (results.size === 0) {
    throw new SchemaDriftError("santander fetch produced no sub-accounts");
  }
  return results;
}

export type { SantanderCredentials, SantanderProduct };
