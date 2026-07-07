// santander source adapter: pure HTTP against the bank's native JSON API, no browser.
// One inventory call discovers every product (contracts, currencies, balances); per-product
// calls fetch checking movements and card movements per currency leg.
//
// Sub-account keying is kind:CURRENCY ("checking:CLP", "credit_card:USD") — one Santander
// connection carries two checking accounts and two card legs distinguished only by
// currency. The credit line (LCR) is reported via onProgress and skipped: it has no
// mapped LM account and no movement feed wired yet.
//
// Card sub-accounts merge two feeds: the unbilled "últimos movimientos" (all currencies) and,
// for the CLP leg, the latest billed statement (cuentasDisponibles → estadoCuentaNacional),
// which adds installment tags, historical backfill, and unbilled→billed transitions. The
// billed fetch is best-effort: its failure degrades to unbilled-only rather than dropping the
// card. USD billed is a separate endpoint (estadoDeCuenta) not yet integrated. Cards declare
// only `billed` coverage — never `unbilled` — because a single-statement billed fetch can't
// reliably confirm a vanished unbilled txn was billed, so declaring it would risk false vanish
// flags; transitions fire regardless of coverage.

import {
  addDays,
  assertPlausibleDates,
  compareIsoDates,
  type IsoDate,
  todayInSantiago,
} from "../../core/dates.ts";
import { AuthError, SchemaDriftError } from "../../core/errors.ts";
import type { CanonicalTxn, FetchResult, TxnStatus } from "../../core/model.ts";
import { subAccountKey } from "../../core/model.ts";
import { persistRawPayload } from "../raw-payload.ts";
import { SantanderClient, type SantanderCredentials } from "./client.ts";
import {
  parseBilledStatement,
  parseCardMovements,
  parseCardStatements,
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
        const unbilled = checkPlausible(
          await parseOrPersist(`santander-card-${product.currency}`, payload, (p) =>
            parseCardMovements(p, product.currency),
          ),
        );
        // Billed statement: CLP only for now (estadoCuentaNacional is the national/CLP
        // statement; the USD statement is a separate endpoint not yet integrated).
        const billed =
          product.currency === "CLP" ? await fetchLatestBilled(client, product, today, hooks) : [];
        const coverage: Partial<Record<TxnStatus, { from: IsoDate; to: IsoDate }>> = {};
        if (billed.length > 0) {
          const dates = billed.map((t) => t.date);
          coverage.billed = { from: dates.reduce((a, b) => (a < b ? a : b)), to: today };
        }
        put(subAccountKey({ kind: "credit_card", sub: product.currency }), {
          // Only `billed` coverage is declared (documents the statement window). `unbilled`
          // is deliberately NOT declared: with a single-statement billed fetch, an unbilled
          // txn leaving the feed at statement close isn't reliably observable as billed here,
          // so declaring unbilled coverage would risk false vanish flags. Transitions still
          // fire (they don't depend on coverage).
          coverage,
          facets: {
            transactions: [...unbilled, ...billed],
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

/**
 * Fetch the latest CLP billed statement for a card, as billed CanonicalTxns. Best-effort: the
 * billed feed is supplementary, so a schema/HTTP failure here logs and returns [] rather than
 * discarding the card's (working) unbilled data — EXCEPT an AuthError, which means the token is
 * bad for every call and must propagate so the connection re-harvests. Schema drift still
 * persists the raw payload for diagnosis (fail-closed on the billed portion only).
 */
async function fetchLatestBilled(
  client: SantanderClient,
  product: SantanderProduct,
  today: IsoDate,
  hooks: SantanderHooks,
): Promise<CanonicalTxn[]> {
  try {
    const statements = await parseOrPersist(
      "santander-card-statements",
      await client.fetchCardStatements({ office: product.office, contract: product.contract }),
      parseCardStatements,
    );
    const latest = statements
      .filter((s) => s.currency === "CLP")
      .sort((a, b) => compareIsoDates(b.fecha, a.fecha))[0];
    if (!latest) return [];
    hooks.onProgress?.(`estado de cuenta ${product.glosa} (${latest.fecha})`);
    const billed = await parseOrPersist(
      "santander-billed",
      await client.fetchBilledStatement({
        office: product.office,
        contract: product.contract,
        numExtracto: latest.numExtracto,
      }),
      (p) => parseBilledStatement(p, "CLP"),
    );
    // A billed row's date is the ORIGINAL purchase date, so an installment (e.g. cuota 8/12)
    // legitimately reaches ~2 years back; the wide window still catches gross format flips.
    assertPlausibleDates(
      billed.map((t) => t.date),
      today,
      { maxAgeDays: 800 },
    );
    return billed;
  } catch (err) {
    if (err instanceof AuthError) throw err;
    const detail = err instanceof Error ? err.message : String(err);
    hooks.onProgress?.(
      `estado de cuenta no disponible (${detail.slice(0, 80)}) — sólo por facturar`,
    );
    return [];
  }
}

export type { SantanderCredentials, SantanderProduct };
