// Fail-closed parsing of open-banking-chile payloads into FetchResults.
//
// Every quirk here was OBSERVED in Phase 0 (docs/phase0-findings.md) and is encoded
// deliberately narrowly — anything outside this grammar is SchemaDrift, and the whole
// batch is rejected rather than guessed at:
// - Santander emits the flat v2 shape: everything in accounts[0].movements, split by
//   `source` tag; no creditCards[]. BdCh emits the nested v3 shape with creditCards[].
// - Date formats differ per (bank, source): Santander account+billed are ISO,
//   Santander unbilled is dd-mm-yyyy, BdCh is dd-mm-yyyy.
// - BdCh movement balances arrive as strings; amounts are integer CLP everywhere.
// - Schemas are .strict(): an upstream field addition is a drift we want to notice.

import { z } from "zod";
import {
  type BankDateFormat,
  assertPlausibleDates,
  type IsoDate,
  parseBankDate,
} from "../core/dates.ts";
import { SchemaDriftError } from "../core/errors.ts";
import type { CanonicalTxn, FetchResult, SubAccountRef, TxnStatus } from "../core/model.ts";
import { subAccountKey } from "../core/model.ts";
import { Money } from "../core/money.ts";
import { normalizeDescription } from "../core/normalize.ts";

// The scraper renders both banks' movements in whole CLP; there is no currency field
// in its payloads. USD accounts, when we add them, arrive via a different path.
const SCRAPER_CURRENCY = "CLP";

const MovementSchema = z
  .object({
    date: z.string().min(1),
    description: z.string(),
    amount: z.number().int({ message: "movement amount must be integer CLP" }),
    balance: z.union([z.number(), z.string()]).nullish(),
    source: z.enum(["account", "credit_card_billed", "credit_card_unbilled"]),
    owner: z.enum(["titular", "adicional"]).optional(),
    card: z.string().optional(),
    installments: z
      .string()
      .regex(/^\d{2}\/\d{2}$/)
      .optional(),
    totalAmount: z.number().optional(),
  })
  .strict();

const AccountSchema = z
  .object({
    label: z.string().nullish(),
    balance: z.union([z.number().int(), z.string()]).nullish(),
    movements: z.array(MovementSchema),
  })
  .strict();

const CupoSchema = z
  .object({
    used: z.number(),
    available: z.number(),
    total: z.number(),
    currency: z.string().optional(),
  })
  .strict();

const CreditCardSchema = z
  .object({
    label: z.string(),
    national: CupoSchema.optional(),
    international: CupoSchema.optional(),
    billingPeriod: z.string().nullish(),
    nextBillingDate: z.string().nullish(),
    nextDueDate: z.string().nullish(),
    periodExpenses: z.number().nullish(),
    lastStatement: z
      .object({
        billingDate: z.string(),
        billedAmount: z.number(),
        dueDate: z.string(),
        minimumPayment: z.number().optional(),
      })
      .strict()
      .nullish(),
    movements: z.array(MovementSchema).optional(),
  })
  .strict();

const ScrapeResultSchema = z
  .object({
    success: z.literal(true),
    bank: z.string(),
    accounts: z.array(AccountSchema).optional(),
    creditCards: z.array(CreditCardSchema).optional(),
    movements: z.array(MovementSchema).optional(), // deprecated v2 field
    balance: z.number().nullish(), // deprecated v2 field
    error: z.string().optional(),
    debug: z.string().optional(),
    screenshot: z.string().optional(),
  })
  .strict();

type Movement = z.infer<typeof MovementSchema>;

/** Per-(bank, source) date format declarations — observed, not sniffed. */
const DATE_FORMATS: Record<string, Record<Movement["source"], BankDateFormat>> = {
  santander: {
    account: "iso",
    credit_card_billed: "iso",
    credit_card_unbilled: "dd-mm-yyyy",
  },
  bchile: {
    account: "dd-mm-yyyy",
    credit_card_billed: "dd-mm-yyyy",
    credit_card_unbilled: "dd-mm-yyyy",
  },
};

const STATUS_BY_SOURCE: Record<Movement["source"], TxnStatus> = {
  account: "posted",
  credit_card_billed: "billed",
  credit_card_unbilled: "unbilled",
};

function parseBalance(value: number | string | null | undefined): Money | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") {
    if (!Number.isInteger(value)) {
      throw new SchemaDriftError(`non-integer CLP balance: ${value}`);
    }
    return Money.fromMinorNumber(value, SCRAPER_CURRENCY);
  }
  return Money.fromDecimalString(value, SCRAPER_CURRENCY);
}

function toCanonical(movement: Movement, bank: string): CanonicalTxn {
  const formats = DATE_FORMATS[bank];
  if (!formats) throw new SchemaDriftError(`no date-format declaration for bank ${bank}`);
  const rawDescription = movement.description.trim();
  const runningBalance = parseBalance(movement.balance);
  return {
    date: parseBankDate(movement.date, formats[movement.source]),
    amount: Money.fromMinorNumber(movement.amount, SCRAPER_CURRENCY),
    rawDescription,
    normDescription: normalizeDescription(rawDescription),
    status: STATUS_BY_SOURCE[movement.source],
    meta: {
      ...(movement.installments ? { installments: movement.installments } : {}),
      ...(movement.card ? { cardLast4: movement.card.replace(/\D/g, "").slice(-4) } : {}),
      ...(runningBalance && !runningBalance.isZero ? { runningBalance } : {}),
    },
  };
}

function coverageOf(
  txns: readonly CanonicalTxn[],
  today: IsoDate,
): Partial<Record<TxnStatus, { from: IsoDate; to: IsoDate }>> {
  const coverage: Partial<Record<TxnStatus, { from: IsoDate; to: IsoDate }>> = {};
  for (const status of ["posted", "unbilled", "billed"] as const) {
    const dates = txns.filter((t) => t.status === status).map((t) => t.date);
    if (dates.length > 0) {
      coverage[status] = { from: dates.reduce((a, b) => (a < b ? a : b)), to: today };
    }
  }
  return coverage;
}

function cardLast4FromLabel(label: string): string | undefined {
  const match = /\*{2,}\s*(\d{4})\b/.exec(label);
  return match?.[1];
}

/**
 * Parse a successful scrape payload into per-sub-account FetchResults.
 * Throws SchemaDriftError on anything outside the observed grammar.
 */
export function parseObcPayload(
  bank: string,
  payload: unknown,
  today: IsoDate,
  fetchedAt: string,
): Map<string, FetchResult> {
  const parsed = ScrapeResultSchema.safeParse(payload);
  if (!parsed.success) {
    throw new SchemaDriftError(
      `obc ${bank} payload failed validation: ${parsed.error.issues
        .slice(0, 5)
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")}`,
    );
  }
  const data = parsed.data;
  const results = new Map<string, FetchResult>();
  const sourceMeta = { source: "obc" as const, fetchedAt };

  const put = (ref: SubAccountRef, result: FetchResult) => {
    const key = subAccountKey(ref);
    if (results.has(key)) {
      throw new SchemaDriftError(`duplicate sub-account ${key} in ${bank} payload`);
    }
    results.set(key, result);
  };

  for (const account of data.accounts ?? []) {
    const canonical = account.movements.map((m) => toCanonical(m, bank));
    assertPlausibleDates(
      canonical.map((t) => t.date),
      today,
    );

    // Santander's flat shape mixes checking + CC movements in one account entry;
    // split by lifecycle status (which follows the source tag).
    const checkingTxns = canonical.filter((t) => t.status === "posted");
    const cardTxns = canonical.filter((t) => t.status !== "posted");

    const balance = parseBalance(account.balance);
    put(
      { kind: "checking" },
      {
        coverage: coverageOf(checkingTxns, today),
        facets: {
          transactions: checkingTxns,
          ...(balance ? { balance: { amount: balance, asOf: today } } : {}),
        },
        sourceMeta,
      },
    );

    if (cardTxns.length > 0) {
      // Flat-shape cards carry no label/cupo; the sub-account is the bare CC kind.
      put(
        { kind: "credit_card" },
        { coverage: coverageOf(cardTxns, today), facets: { transactions: cardTxns }, sourceMeta },
      );
    }
  }

  for (const card of data.creditCards ?? []) {
    const canonical = (card.movements ?? []).map((m) => toCanonical(m, bank));
    assertPlausibleDates(
      canonical.map((t) => t.date),
      today,
    );
    const last4 = cardLast4FromLabel(card.label);
    if (!last4) {
      throw new SchemaDriftError(`credit card label without last-4: ${JSON.stringify(card.label)}`);
    }
    put(
      { kind: "credit_card", cardLast4: last4 },
      { coverage: coverageOf(canonical, today), facets: { transactions: canonical }, sourceMeta },
    );
  }

  if (results.size === 0) {
    throw new SchemaDriftError(`obc ${bank} payload contained no sub-accounts`);
  }
  return results;
}
