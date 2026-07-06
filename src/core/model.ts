// Canonical domain model. Source adapters translate bank payloads into these shapes;
// everything downstream (identity, planner, sink) speaks only this language.

import type { IsoDate } from "./dates.ts";
import type { Money } from "./money.ts";

export type AccountKind = "checking" | "savings" | "cash" | "credit_card" | "investment";

export type SourceId = "obc" | "racional" | "betterplan" | "santander"; // | "khipu" | "floid" as adapters land

/**
 * Lifecycle status of a transaction as observed at the source.
 * posted: settled on a deposit account. unbilled/billed: credit-card lifecycle.
 */
export type TxnStatus = "posted" | "unbilled" | "billed";

/** A transaction in canonical form, still unmatched to any identity. */
export interface CanonicalTxn {
  readonly date: IsoDate;
  readonly amount: Money;
  /** Raw description as the source emitted it (post-trim, pre-normalization). */
  readonly rawDescription: string;
  /** Normalized per src/core/normalize.ts (version recorded at identity mint). */
  readonly normDescription: string;
  readonly status: TxnStatus;
  readonly meta: {
    /** "02/06" = cuota 2 of 6, when the source provides it. */
    readonly installments?: string;
    /** Card last-4 when the source provides it (multi-card connections). */
    readonly cardLast4?: string;
    /** Running account balance after this movement, when the source provides it. */
    readonly runningBalance?: Money;
  };
}

/** What a source observed for one sub-account, with explicit observation window. */
export interface FetchResult {
  /**
   * The window the source actually observed, per status. Absence of a transaction is
   * only evidence within its declared coverage (unbilled is only observable for the
   * current period; fallback sources have shorter history).
   */
  readonly coverage: Partial<Record<TxnStatus, { from: IsoDate; to: IsoDate }>>;
  readonly facets: {
    readonly transactions?: readonly CanonicalTxn[];
    readonly balance?: {
      readonly amount: Money;
      readonly asOf: IsoDate;
    };
    // Future: valuation facet (holdings, returns) for investment sources.
  };
  readonly sourceMeta: {
    readonly source: SourceId;
    readonly fetchedAt: string; // ISO timestamp
  };
}

/**
 * Identifies a sub-account within a connection's fetch result, source-agnostically.
 * kind + one optional disambiguator: cardLast4 (e.g. Santander flat payload splits by
 * movement source tag; BdCh nested payload has per-card arrays) or sub, a source-defined
 * facet label when one kind carries several sub-accounts (racional investment splits into
 * "stocks" and "cash"). This key is a runtime routing key only — it is never persisted, so
 * changing its computation has no state-migration impact.
 */
export interface SubAccountRef {
  readonly kind: AccountKind;
  readonly cardLast4?: string;
  readonly sub?: string;
}

export function subAccountKey(ref: SubAccountRef): string {
  if (ref.cardLast4) return `${ref.kind}:${ref.cardLast4}`;
  if (ref.sub) return `${ref.kind}:${ref.sub}`;
  return ref.kind;
}

/**
 * The sub-account key an account expects from its adapter — the routing key the engine
 * looks up in the fetch result. Lives here (not in the engine) so config validation can
 * reuse it without importing the engine. Structural param: the engine passes an
 * AccountConfig, config validation passes an account-shaped literal.
 */
export function expectedSubAccountKey(account: {
  readonly kind: AccountKind;
  readonly match: { readonly card_last4?: string | undefined; readonly sub?: string | undefined };
}): string {
  if (account.kind === "credit_card" && account.match.card_last4) {
    return subAccountKey({ kind: account.kind, cardLast4: account.match.card_last4 });
  }
  if (account.match.sub) return subAccountKey({ kind: account.kind, sub: account.match.sub });
  return subAccountKey({ kind: account.kind });
}
