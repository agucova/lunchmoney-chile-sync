// santander source adapter: pure HTTP against the bank's native JSON API, no browser.
// One inventory call discovers every product (contracts, currencies, balances); per-product
// calls fetch checking movements and card movements per currency leg.
//
// Sub-account keying is kind:CURRENCY ("checking:CLP", "credit_card:USD") — one Santander
// connection carries two checking accounts and two card legs distinguished only by
// currency. The credit line (LCR) is reported via onProgress and skipped: it has no
// mapped LM account and no movement feed wired yet.
//
// Card sub-accounts merge two feeds: the unbilled "últimos movimientos" (all currencies) and
// the latest billed statement — CLP via the structured estadoCuentaNacional, USD via the
// estadoDeCuenta PDF (its only source; extracted with pdftotext and reconciled against the
// statement totals). The billed feed adds installment tags, historical backfill, and
// unbilled→billed transitions. It's best-effort: any failure (drift, non-reconciling PDF,
// missing pdftotext) degrades to unbilled-only rather than dropping the card. Cards declare
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
import { AuthError, SchemaDriftError, SourceUnavailableError } from "../../core/errors.ts";
import type { CanonicalTxn, FetchResult, TxnStatus } from "../../core/model.ts";
import { subAccountKey } from "../../core/model.ts";
import { persistRawPayload } from "../raw-payload.ts";
import { SantanderClient, type SantanderCredentials } from "./client.ts";
import {
  type CardStatement,
  parseBilledStatement,
  parseCardMovements,
  parseCardStatements,
  parseCheckingTransactions,
  parseInventory,
  type SantanderProduct,
} from "./payload.ts";
import { extractPdfText, extractStatementPdf, parseUsdStatementText } from "./usd-statement.ts";

export interface SantanderHooks {
  onProgress?: (step: string) => void;
}

export interface SantanderFetchOptions {
  /**
   * How far back checking movements are requested. The bank caps this, so the fetch tries the
   * requested window and, if the endpoint rejects it, falls back to a known-safe 60 days.
   */
  windowDays?: number;
  /**
   * How many recent billed statements to fetch per card currency (default 1 = current period).
   * Raise for a first-time backfill (cuentasDisponibles exposes ~12 months). Each statement
   * reconciles independently and is best-effort — one bad statement doesn't drop the others.
   */
  billedStatements?: number;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  today?: IsoDate;
}

const DEFAULT_WINDOW_DAYS = 60;
/** Known-safe checking window (validated live); the fallback when a larger request is rejected. */
const SAFE_WINDOW_DAYS = 60;

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
  const windowDays = options.windowDays ?? DEFAULT_WINDOW_DAYS;
  const billedStatements = Math.max(1, options.billedStatements ?? 1);
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
        const { opening, txns } = await fetchChecking(client, product, today, windowDays, hooks);
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
        // Billed statement: CLP via the structured estadoCuentaNacional; USD via the
        // estadoDeCuenta PDF (the only USD source). Both best-effort (see helpers), fetching up
        // to `billedStatements` recent statements for a first-time backfill.
        const billed =
          product.currency === "CLP"
            ? await fetchBilledClp(client, product, today, billedStatements, hooks)
            : await fetchBilledUsd(client, product, today, billedStatements, hooks);
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
 * Fetch checking movements, trying the requested window and, if the endpoint rejects it (the
 * bank caps how far back it serves), falling back to a known-safe 60 days. Returns the opening
 * date actually used and the (plausibility-checked) transactions.
 */
async function fetchChecking(
  client: SantanderClient,
  product: SantanderProduct,
  today: IsoDate,
  windowDays: number,
  hooks: SantanderHooks,
): Promise<{ opening: IsoDate; txns: CanonicalTxn[] }> {
  const candidates =
    windowDays > SAFE_WINDOW_DAYS ? [windowDays, SAFE_WINDOW_DAYS] : [Math.max(1, windowDays)];
  let lastErr: unknown;
  for (let i = 0; i < candidates.length; i++) {
    const days = candidates[i] as number;
    const opening = addDays(today, -days);
    try {
      const payload = await client.fetchCheckingTransactions({
        office: product.office,
        contract: product.contract,
        currency: product.currency,
        opening,
        closing: today,
      });
      const txns = await parseOrPersist(`santander-checking-${product.currency}`, payload, (p) =>
        parseCheckingTransactions(p, product.currency),
      );
      assertPlausibleDates(
        txns.map((t) => t.date),
        today,
        { maxAgeDays: days + 30 },
      );
      if (days !== windowDays) {
        hooks.onProgress?.(`ventana ${windowDays}d no aceptada — usando ${days}d`);
      }
      return { opening, txns };
    } catch (err) {
      lastErr = err;
      // Only a transport/HTTP rejection is retried with a smaller window; drift is a data bug.
      if (err instanceof SourceUnavailableError && i < candidates.length - 1) continue;
      throw err;
    }
  }
  throw lastErr;
}

/**
 * CLP billed statements (structured estadoCuentaNacional), up to `count` most recent. Each
 * statement reconciles/parses independently and is best-effort per statement, so one bad or
 * missing statement doesn't drop the rest or the card's unbilled data. AuthError propagates
 * (the token is bad for everything); schema drift persists the raw payload.
 */
async function fetchBilledClp(
  client: SantanderClient,
  product: SantanderProduct,
  today: IsoDate,
  count: number,
  hooks: SantanderHooks,
): Promise<CanonicalTxn[]> {
  const statements = await listStatements(client, product, "CLP", count, hooks);
  const all: CanonicalTxn[] = [];
  for (const statement of statements) {
    try {
      hooks.onProgress?.(`estado de cuenta ${product.glosa} (${statement.fecha})`);
      const billed = await parseOrPersist(
        "santander-billed",
        await client.fetchBilledStatement({
          office: product.office,
          contract: product.contract,
          numExtracto: statement.numExtracto,
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
      all.push(...billed);
    } catch (err) {
      if (err instanceof AuthError) throw err;
      hooks.onProgress?.(
        `estado de cuenta ${statement.fecha} no disponible (${errText(err)}) — omitido`,
      );
    }
  }
  return all;
}

/**
 * USD billed statements via the estadoDeCuenta PDF (the only USD source), up to `count` most
 * recent: decode the PDF, extract text (pdftotext), parse + reconcile against the header
 * totals. Best-effort per statement like the CLP path.
 */
async function fetchBilledUsd(
  client: SantanderClient,
  product: SantanderProduct,
  today: IsoDate,
  count: number,
  hooks: SantanderHooks,
): Promise<CanonicalTxn[]> {
  const statements = await listStatements(client, product, "USD", count, hooks);
  const all: CanonicalTxn[] = [];
  for (const statement of statements) {
    try {
      hooks.onProgress?.(`estado de cuenta internacional ${product.glosa} (${statement.fecha})`);
      const response = await client.fetchUsdStatement({
        office: product.office,
        contract: product.contract,
        fecha: statement.fecha,
      });
      let billed: CanonicalTxn[];
      try {
        const pdf = extractStatementPdf(response); // SchemaDrift on a bad wrapper
        const text = await extractPdfText(pdf); // plain Error if pdftotext is unavailable
        billed = parseUsdStatementText(text); // SchemaDrift if it doesn't reconcile
      } catch (err) {
        if (err instanceof SchemaDriftError) {
          const path = await persistRawPayload("santander-usd-statement", response);
          throw new SchemaDriftError(`${err.message} (raw payload: ${path})`, path, err);
        }
        throw err;
      }
      assertPlausibleDates(
        billed.map((t) => t.date),
        today,
        { maxAgeDays: 400 },
      );
      all.push(...billed);
    } catch (err) {
      if (err instanceof AuthError) throw err;
      hooks.onProgress?.(
        `estado de cuenta internacional ${statement.fecha} no disponible (${errText(err)}) — omitido`,
      );
    }
  }
  return all;
}

/** Up to `count` most recent statements of a currency; [] (logged) if the list fetch fails. */
async function listStatements(
  client: SantanderClient,
  product: SantanderProduct,
  currency: "CLP" | "USD",
  count: number,
  hooks: SantanderHooks,
): Promise<CardStatement[]> {
  try {
    const statements = await parseOrPersist(
      "santander-card-statements",
      await client.fetchCardStatements({ office: product.office, contract: product.contract }),
      parseCardStatements,
    );
    return statements
      .filter((s) => s.currency === currency)
      .sort((a, b) => compareIsoDates(b.fecha, a.fecha))
      .slice(0, count);
  } catch (err) {
    if (err instanceof AuthError) throw err;
    hooks.onProgress?.(`estados de cuenta ${currency} no disponibles (${errText(err)})`);
    return [];
  }
}

function errText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 80);
}

export type { SantanderCredentials, SantanderProduct };
