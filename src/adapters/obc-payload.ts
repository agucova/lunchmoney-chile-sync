// Fail-closed parsing of open-banking-chile payloads into FetchResults.
//
// Every quirk here was OBSERVED in Phase 0 (docs/phase0-findings.md) — except BCI, whose
// grammar is code-derived from the pinned scraper (commit 085faafd; no real capture yet) —
// and is encoded deliberately narrowly: anything outside this grammar is SchemaDrift, and
// the whole batch is rejected rather than guessed at.
// - Santander emits the flat v2 shape: everything in accounts[0].movements, split by
//   `source` tag; no creditCards[]. BdCh emits the nested v3 shape with creditCards[].
// - BCI is a hybrid: flat movements like Santander, plus cupo-only creditCards[] entries
//   whose movements are always empty; movement balances are always literal 0.
// - Date formats differ per (bank, source): Santander account+billed are ISO,
//   Santander unbilled is dd-mm-yyyy, BdCh is dd-mm-yyyy. BCI account movements are
//   path-dependent upstream (ISO from the intercepted API, dd-mm-yyyy from the HTML
//   fallback), so their declaration is a set of admissible formats.
// - BdCh movement balances arrive as strings; amounts are integer CLP everywhere.
// - BCI international-USD card movements carry no currency marker and would ingest as
//   CLP — undetectable here; the supervised first run must check for them.
// - Schemas are .strict(): an upstream field addition is a drift we want to notice.

import { z } from "zod";
import {
  type BankDateFormat,
  assertPlausibleDates,
  type IsoDate,
  parseBankDateAny,
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

/** How a bank's creditCards[] entries are to be read. */
type CreditCardsShape = "absent" | "per-card" | "cupo-only";

interface BankShape {
  /** Admissible date format(s) per movement source — declared, never sniffed. */
  readonly dates: Record<Movement["source"], readonly [BankDateFormat, ...BankDateFormat[]]>;
  /**
   * absent: any creditCards entry is drift. per-card: each entry is a sub-account keyed
   * by label last-4. cupo-only: entries carry cupo metadata only (ignored, like bchile's
   * cupo); an entry with movements is drift — the flat path already carries the card
   * movements, so a populated nested path could double-emit the same transactions.
   */
  readonly creditCards: CreditCardsShape;
  /**
   * Drift tripwire: the checking sub-account must show evidence (a balance or ≥1 posted
   * movement). BCI emits a success payload with one empty account when post-login
   * navigation fails, which would otherwise pass as a silent no-op run.
   */
  readonly requireCheckingEvidence?: boolean;
  /**
   * Widens the movement-date plausibility window past the 400-day default for banks
   * whose payloads legitimately reach further back (BCI's intercepted API returns
   * roughly two years of checking history).
   */
  readonly maxMovementAgeDays?: number;
}

/** Per-bank payload shape declarations — observed (Phase 0) or, for bci, code-derived. */
const BANK_SHAPES: Record<string, BankShape> = {
  santander: {
    dates: {
      account: ["iso"],
      credit_card_billed: ["iso"],
      credit_card_unbilled: ["dd-mm-yyyy"],
    },
    creditCards: "absent",
  },
  bchile: {
    dates: {
      account: ["dd-mm-yyyy"],
      credit_card_billed: ["dd-mm-yyyy"],
      credit_card_unbilled: ["dd-mm-yyyy"],
    },
    creditCards: "per-card",
  },
  bci: {
    dates: {
      account: ["iso", "dd-mm-yyyy"],
      credit_card_billed: ["dd-mm-yyyy"],
      credit_card_unbilled: ["dd-mm-yyyy"],
    },
    creditCards: "cupo-only",
    requireCheckingEvidence: true,
    // Observed 2026-07: the BFF API returned movements back to ~24 months; 800 days
    // leaves headroom without letting decade-off flips through.
    maxMovementAgeDays: 800,
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

function toCanonical(movement: Movement, shape: BankShape): CanonicalTxn {
  const rawDescription = movement.description.trim();
  const runningBalance = parseBalance(movement.balance);
  return {
    date: parseBankDateAny(movement.date, shape.dates[movement.source]),
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
  const shape = BANK_SHAPES[bank];
  if (!shape) throw new SchemaDriftError(`no payload-shape declaration for bank ${bank}`);
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

  const plausibility = shape.maxMovementAgeDays
    ? { maxAgeDays: shape.maxMovementAgeDays }
    : undefined;

  for (const account of data.accounts ?? []) {
    const canonical = account.movements.map((m) => toCanonical(m, shape));
    assertPlausibleDates(
      canonical.map((t) => t.date),
      today,
      plausibility,
    );

    // Santander's flat shape mixes checking + CC movements in one account entry;
    // split by lifecycle status (which follows the source tag).
    const checkingTxns = canonical.filter((t) => t.status === "posted");
    const cardTxns = canonical.filter((t) => t.status !== "posted");

    const balance = parseBalance(account.balance);
    if (shape.requireCheckingEvidence && checkingTxns.length === 0 && !balance) {
      throw new SchemaDriftError(
        `${bank} checking scrape produced no evidence (no balance, no movements) — upstream navigation failure?`,
      );
    }
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
    if (shape.creditCards === "absent") {
      throw new SchemaDriftError(
        `${bank} payload contains creditCards[] but its shape declares none`,
      );
    }
    if (shape.creditCards === "cupo-only") {
      if ((card.movements ?? []).length > 0) {
        throw new SchemaDriftError(
          `${bank} cupo-only credit card ${JSON.stringify(card.label)} carries movements; ` +
            `flat + nested paths would double-emit`,
        );
      }
      continue;
    }
    const canonical = (card.movements ?? []).map((m) => toCanonical(m, shape));
    assertPlausibleDates(
      canonical.map((t) => t.date),
      today,
      plausibility,
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
