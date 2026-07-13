// Payee → Lunch Money category, applied at plan time so synced transactions land
// already categorized (instead of relying on LM's server-side rules). Rules are ordered;
// the first whose pattern matches the payee wins, and a payee that matches nothing is
// left uncategorized. Patterns and category ids live in config (gitignored — the ids are
// account-specific), so this module stays pure and data-driven.

/** A compiled rule: a case-insensitive payee test mapped to an LM leaf category id. */
export interface CategoryRule {
  readonly pattern: RegExp;
  readonly categoryId: number;
}

/** A rule as written in config, before its pattern is compiled to a regex. */
export interface RawCategoryRule {
  readonly pattern: string;
  readonly category_id: number;
}

/**
 * Compile config rules to regex once, preserving order. Patterns are validated at config
 * load (see config.ts), so a bad pattern fails closed there rather than here.
 */
export function compileCategoryRules(raw: readonly RawCategoryRule[]): CategoryRule[] {
  return raw.map((rule) => ({
    pattern: new RegExp(rule.pattern, "i"),
    categoryId: rule.category_id,
  }));
}

/**
 * The first matching rule's category id, or undefined when nothing matches (the transaction
 * is then inserted without a category, exactly as before this feature existed).
 */
export function categorizePayee(payee: string, rules: readonly CategoryRule[]): number | undefined {
  for (const rule of rules) {
    if (rule.pattern.test(payee)) return rule.categoryId;
  }
  return undefined;
}
