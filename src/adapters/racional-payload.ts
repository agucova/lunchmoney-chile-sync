// Fail-closed parsing of Racional's REST payloads into balance FetchResults.
//
// Two money-bearing endpoints (see docs/racional-api.md): GET /positions (holdings) and
// GET /positions/buying-power (cash). Schemas are .strict() — any upstream field change is
// SchemaDrift and the whole payload is rejected, never partially ingested.
//
// Money boundary: the API emits JSON numbers (doubles). The ONLY float crossing is
// usdFromApiNumber, which renders a double to a fixed 2-dp string (a deterministic ECMA-262
// projection, not arithmetic) and hands it to Money.fromDecimalString. All summation then
// happens in BigInt Money space. Consequence: the stocks balance is Σ round(position), which
// can diverge from Racional's displayed round(Σ position) by at most N × $0.005 (N = holdings
// count). That is the correct trade-off under the repo's hard rule (money never through float
// arithmetic); summing the raw doubles first would match the app to the cent but violate it.

import { z } from "zod";
import { SchemaDriftError } from "../core/errors.ts";
import type { IsoDate } from "../core/dates.ts";
import type { FetchResult } from "../core/model.ts";
import { subAccountKey } from "../core/model.ts";
import { Money } from "../core/money.ts";

// A position value or cash figure above this is implausible drift, not a real balance.
// Kept well under the double integer-precision limit (2^53 cents ≈ $9e13) so toFixed(2)
// stays exact.
const MAX_USD_MAGNITUDE = 1e12;

// Reject pricing older (or, under clock skew, further in the future) than this — catches a
// dead upstream pricing pipeline while tolerating individual halted/stale assets.
const STALENESS_LIMIT_DAYS = 7;
const MS_PER_DAY = 86_400_000;

const PositionSchema = z
  .object({
    assetId: z.string().min(1),
    amountOfShares: z.number().finite().nonnegative(),
    sharePriceOriginalCurrency: z.number().finite().nonnegative(),
    // The money-path field: this is what the adapter sums into the stocks balance.
    amountUSD: z.number().finite().nonnegative(),
    availableAmountOfShares: z.number().finite().nonnegative(),
    availableAmountUSD: z.number().finite().nonnegative(),
    // P&L and percentages are signed and, for promo/zero-cost lots, can legitimately be
    // ±Infinity — not money-path, so validate presence/type without a finite constraint.
    unrealizedPL: z.number(),
    unrealizedPLPercent: z.number(),
    unrealizedDayPL: z.number(),
    unrealizedDayPLPercent: z.number(),
    lastUpdated: z.string().refine((v) => Number.isFinite(Date.parse(v)), "unparseable timestamp"),
    avgCost: z.number(),
    weight: z.number(),
  })
  .strict();

// Empty array = fully divested; legal, not drift.
const PositionsSchema = z.array(PositionSchema);

const BuyingPowerSchema = z
  .object({
    // The money-path field: cash balance the adapter pushes.
    buyingPower: z.number().finite().nonnegative(),
    breakdown: z
      .object({
        cashAvailableForTrade: z.number().finite(),
        cashAvailableForWithdrawal: z.number().finite(),
        amountUSD: z.number().finite(),
        cashFromSellsInTransit: z.number().finite(),
        usedDriveWealthValue: z.boolean(),
        isPro: z.boolean(),
      })
      .strict(),
    accountContext: z
      .object({
        cashSettling: z.number().finite(),
        // buyingPower equals cash ONLY for a cash account. A margin upgrade would make
        // buyingPower a levered figure — drift loudly rather than push it as cash.
        tradingType: z.literal("CASH"),
      })
      .strict(),
  })
  .strict();

/**
 * Render an API double as USD Money via a fixed 2-dp string. Non-finite or implausibly large
 * values are SchemaDrift (not an invariant) so the adapter persists the raw payload and the
 * run is classified as schema_drift — the .finite() schema constraints make this belt-and-braces.
 */
function usdFromApiNumber(value: number, field: string): Money {
  if (!Number.isFinite(value) || Math.abs(value) >= MAX_USD_MAGNITUDE) {
    throw new SchemaDriftError(`racional: implausible USD value for ${field}: ${value}`);
  }
  return Money.fromDecimalString(value.toFixed(2), "USD");
}

function formatIssues(error: z.ZodError, label: string): string {
  return `racional ${label} payload failed validation: ${error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
    .join("; ")}`;
}

/**
 * Parse the two Racional payloads into per-sub-account balance FetchResults, keyed by
 * subAccountKey: "investment" (stocks + cash total), "investment:stocks", "investment:cash".
 * Every entry is balance-only with empty coverage. Throws SchemaDriftError on any drift.
 */
export function parseRacionalPayload(
  positionsRaw: unknown,
  buyingPowerRaw: unknown,
  today: IsoDate,
  fetchedAt: string,
): Map<string, FetchResult> {
  const positions = PositionsSchema.safeParse(positionsRaw);
  if (!positions.success) throw new SchemaDriftError(formatIssues(positions.error, "positions"));
  const buyingPower = BuyingPowerSchema.safeParse(buyingPowerRaw);
  if (!buyingPower.success)
    throw new SchemaDriftError(formatIssues(buyingPower.error, "buying-power"));

  if (positions.data.length > 0) {
    const todayEpoch = Date.parse(`${today}T00:00:00Z`);
    const newest = Math.max(...positions.data.map((p) => Date.parse(p.lastUpdated)));
    const ageDays = Math.abs(newest - todayEpoch) / MS_PER_DAY;
    if (ageDays > STALENESS_LIMIT_DAYS) {
      throw new SchemaDriftError(
        `racional: positions pricing is stale — newest lastUpdated ${new Date(
          newest,
        ).toISOString()} is ${ageDays.toFixed(1)}d from ${today}`,
      );
    }
  }

  const stocks = positions.data.reduce(
    (acc, p) => acc.add(usdFromApiNumber(p.amountUSD, `positions[${p.assetId}].amountUSD`)),
    Money.zero("USD"),
  );
  const cash = usdFromApiNumber(buyingPower.data.buyingPower, "buyingPower");
  const total = stocks.add(cash);

  const balanceResult = (amount: Money): FetchResult => ({
    coverage: {},
    facets: { balance: { amount, asOf: today } },
    sourceMeta: { source: "racional", fetchedAt },
  });

  const results = new Map<string, FetchResult>();
  results.set(subAccountKey({ kind: "investment" }), balanceResult(total));
  results.set(subAccountKey({ kind: "investment", sub: "stocks" }), balanceResult(stocks));
  results.set(subAccountKey({ kind: "investment", sub: "cash" }), balanceResult(cash));
  return results;
}
