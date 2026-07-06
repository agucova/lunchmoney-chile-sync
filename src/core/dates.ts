// Date parsing for bank payloads. Formats are DECLARED per (bank, source) — never
// sniffed per value — so an upstream format change fails loudly as SchemaDrift instead
// of silently mis-dating movements. Canonical form is an ISO date string (no time);
// banks operate in America/Santiago and we never attach a timezone.

import { SchemaDriftError, invariant } from "./errors.ts";

/** Canonical ISO date, e.g. "2026-07-05". */
export type IsoDate = string & { readonly __brand: "IsoDate" };

export type BankDateFormat = "iso" | "dd-mm-yyyy" | "dd/mm/yyyy";

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DDMM_RE = /^(\d{2})-(\d{2})-(\d{4})$/;
const DDMM_SLASH_RE = /^(\d{2})\/(\d{2})\/(\d{4})$/;

function daysInMonth(year: number, month: number): number {
  // month is 1-based; Date.UTC day 0 of next month = last day of this month
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function checkedIso(year: number, month: number, day: number, raw: string): IsoDate {
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    throw new SchemaDriftError(`impossible calendar date: ${JSON.stringify(raw)}`);
  }
  const mm = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return `${year}-${mm}-${dd}` as IsoDate;
}

/**
 * Parse a bank-emitted date in the declared format. Throws SchemaDriftError on any
 * mismatch — a batch containing one bad date is a bad batch.
 */
export function parseBankDate(raw: string, format: BankDateFormat): IsoDate {
  const value = raw.trim();
  if (format === "iso") {
    const m = ISO_RE.exec(value);
    if (!m) throw new SchemaDriftError(`expected ISO date, got ${JSON.stringify(raw)}`);
    return checkedIso(Number(m[1]), Number(m[2]), Number(m[3]), raw);
  }
  const m = FORMAT_RES[format].exec(value);
  if (!m) throw new SchemaDriftError(`expected ${format} date, got ${JSON.stringify(raw)}`);
  return checkedIso(Number(m[3]), Number(m[2]), Number(m[1]), raw);
}

const FORMAT_RES: Record<BankDateFormat, RegExp> = {
  iso: ISO_RE,
  "dd-mm-yyyy": DDMM_RE,
  "dd/mm/yyyy": DDMM_SLASH_RE,
};

export function matchesBankDateFormat(value: string, format: BankDateFormat): boolean {
  return FORMAT_RES[format].test(value);
}

/**
 * Parse a bank-emitted date against a declared SET of admissible formats — for sources
 * whose format is path-dependent upstream (e.g. BCI account movements arrive ISO from the
 * intercepted API but dd-mm-yyyy from the HTML fallback). The set is still a declaration,
 * not sniffing: exactly one declared format may syntactically match, anything else is drift.
 */
export function parseBankDateAny(
  raw: string,
  formats: readonly [BankDateFormat, ...BankDateFormat[]],
): IsoDate {
  const value = raw.trim();
  const matching = formats.filter((format) => matchesBankDateFormat(value, format));
  if (matching.length === 0) {
    throw new SchemaDriftError(
      `date ${JSON.stringify(raw)} matches none of the declared formats [${formats.join(", ")}]`,
    );
  }
  const format = matching[0];
  if (matching.length > 1 || format === undefined) {
    throw new SchemaDriftError(
      `date ${JSON.stringify(raw)} is ambiguous across declared formats [${formats.join(", ")}]`,
    );
  }
  return parseBankDate(value, format);
}

export function isIsoDate(value: string): value is IsoDate {
  return ISO_RE.test(value) && parseBankDate(value, "iso") === value;
}

export function assertIsoDate(value: string): IsoDate {
  invariant(isIsoDate(value), `not an ISO date: ${JSON.stringify(value)}`);
  return value;
}

/** Lexicographic comparison works for ISO dates by construction. */
export function compareIsoDates(a: IsoDate, b: IsoDate): -1 | 0 | 1 {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** An ISO date shifted by a (possibly negative) number of days. */
export function addDays(date: IsoDate, days: number): IsoDate {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const shifted = new Date(Date.UTC(y, m - 1, d + days));
  const mm = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(shifted.getUTCDate()).padStart(2, "0");
  return `${shifted.getUTCFullYear()}-${mm}-${dd}` as IsoDate;
}

/** Days between two ISO dates (b - a), for date-window matching. */
export function daysBetween(a: IsoDate, b: IsoDate): number {
  const [ay, am, ad] = a.split("-").map(Number) as [number, number, number];
  const [by, bm, bd] = b.split("-").map(Number) as [number, number, number];
  const utcA = Date.UTC(ay, am - 1, ad);
  const utcB = Date.UTC(by, bm - 1, bd);
  return Math.round((utcB - utcA) / 86_400_000);
}

/**
 * Batch-level plausibility check: every movement date must fall inside
 * [today - maxAgeDays, today + maxFutureDays]. Catches format flips that still parse
 * (e.g. a dd-mm ↔ mm-dd confusion shifting dates months away) and clock nonsense.
 */
export function assertPlausibleDates(
  dates: readonly IsoDate[],
  today: IsoDate,
  { maxAgeDays = 400, maxFutureDays = 7 }: { maxAgeDays?: number; maxFutureDays?: number } = {},
): void {
  for (const date of dates) {
    const delta = daysBetween(date, today); // positive = past
    if (delta > maxAgeDays || delta < -maxFutureDays) {
      throw new SchemaDriftError(
        `implausible movement date ${date} (today ${today}); format drift upstream?`,
      );
    }
  }
}

/** Today's date in America/Santiago, as canonical IsoDate. */
export function todayInSantiago(now: Date = new Date()): IsoDate {
  const formatted = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Santiago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  return assertIsoDate(formatted);
}
