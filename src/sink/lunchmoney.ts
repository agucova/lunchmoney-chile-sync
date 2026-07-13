// Lunch Money v2 client — plain fetch + zod (the official v2 JS client lagged the API
// in Phase 0 testing; this covers the exact surface we use, validated).
//
// Verified v2 behaviors this client relies on (docs/phase0-findings.md):
// - POST /transactions returns 201 with transactions[] and skipped_duplicates[]
//   carrying existing_transaction_id — duplicate replays recover the LM id.
// - currency DEFAULTS TO THE BUDGET PRIMARY, not the account currency ⇒ always sent.
// - PUT /manual_accounts/:id updates balance.

import { z } from "zod";
import { SinkError } from "../core/errors.ts";
import type { IsoDate } from "../core/dates.ts";
import type { Money } from "../core/money.ts";

const InsertResponseSchema = z.object({
  transactions: z.array(z.object({ id: z.number(), external_id: z.string().nullish() }).loose()),
  skipped_duplicates: z
    .array(
      z
        .object({
          reason: z.string(),
          request_transactions_index: z.number(),
          existing_transaction_id: z.number(),
        })
        .loose(),
    )
    .default([]),
});

const ManualAccountSchema = z
  .object({
    id: z.number(),
    balance: z.string(),
    currency: z.string(),
    balance_as_of: z.string().nullish(),
  })
  .loose();

export interface InsertTxnRequest {
  readonly date: IsoDate;
  readonly amount: Money;
  readonly payee: string;
  readonly lmAccountId: number;
  readonly externalId: string;
  /** LM leaf category id; omitted from the request when absent (inserts uncategorized). */
  readonly categoryId?: number;
}

export interface InsertOutcome {
  /** LM transaction id, whether freshly inserted or recovered from a duplicate skip. */
  readonly lmTxnId: number;
  readonly deduped: boolean;
}

export class LunchMoneyClient {
  constructor(
    private readonly token: string,
    private readonly baseUrl = "https://api.lunchmoney.dev/v2",
  ) {}

  /** Backoff schedule for 429/5xx (ms); Retry-After wins when the server sends it. */
  private static readonly BACKOFF_MS = [2_000, 10_000, 30_000];

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const doFetch = () =>
      fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(30_000),
      });

    let response = await doFetch();
    for (const backoffMs of LunchMoneyClient.BACKOFF_MS) {
      if (response.status !== 429 && response.status < 500) break;
      const retryAfterSec = Number(response.headers.get("retry-after"));
      const waitMs =
        Number.isFinite(retryAfterSec) && retryAfterSec > 0 ? retryAfterSec * 1_000 : backoffMs;
      await Bun.sleep(waitMs);
      response = await doFetch();
    }
    const text = await response.text();
    if (!response.ok) {
      throw new SinkError(
        `LM ${method} ${path} failed: HTTP ${response.status}`,
        response.status,
        text.slice(0, 500),
      );
    }
    return text === "" ? null : (JSON.parse(text) as unknown);
  }

  /**
   * Insert a batch of transactions; outcomes are returned in request order.
   * Duplicates recover their existing LM id (skipped_duplicates carries
   * request_transactions_index); fresh inserts are matched by external_id.
   */
  async insertTransactions(txns: readonly InsertTxnRequest[]): Promise<InsertOutcome[]> {
    if (txns.length === 0) return [];
    const raw = await this.request("POST", "/transactions", {
      apply_rules: true, // otherwise synced txns never see the user's LM rules (verified: default false)
      transactions: txns.map((txn) => ({
        date: txn.date,
        amount: txn.amount.toDecimalString(),
        currency: txn.amount.currency.toLowerCase(), // ALWAYS explicit (v2 usd default!)
        payee: txn.payee,
        manual_account_id: txn.lmAccountId,
        external_id: txn.externalId,
        ...(txn.categoryId === undefined ? {} : { category_id: txn.categoryId }),
      })),
    });
    const parsed = InsertResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new SinkError(`LM insert response failed validation: ${parsed.error.message}`);
    }
    const byExternalId = new Map(
      parsed.data.transactions
        .filter((txn) => txn.external_id != null)
        .map((txn) => [txn.external_id as string, txn.id]),
    );
    const skippedByIndex = new Map(
      parsed.data.skipped_duplicates.map((skip) => [
        skip.request_transactions_index,
        skip.existing_transaction_id,
      ]),
    );
    return txns.map((txn, index) => {
      const skippedId = skippedByIndex.get(index);
      if (skippedId !== undefined) return { lmTxnId: skippedId, deduped: true };
      const insertedId = byExternalId.get(txn.externalId);
      if (insertedId !== undefined) return { lmTxnId: insertedId, deduped: false };
      throw new SinkError(
        `LM insert response missing outcome for external_id ${txn.externalId} (index ${index})`,
      );
    });
  }

  /**
   * Update a manual account's balance and its as-of date. LM does NOT re-stamp
   * balance_as_of from a balance-only PUT (verified — it keeps the prior date), so we send
   * it explicitly; otherwise the asset shows a fresh balance under a stale date.
   */
  async setBalance(lmAccountId: number, balance: Money, asOf: string): Promise<void> {
    await this.request("PUT", `/manual_accounts/${lmAccountId}`, {
      balance: balance.toDecimalString(),
      balance_as_of: asOf,
    });
  }

  /** Current manual-account state (drift checks). */
  async getManualAccount(lmAccountId: number): Promise<{ balance: string; currency: string }> {
    const raw = await this.request("GET", `/manual_accounts/${lmAccountId}`);
    const parsed = ManualAccountSchema.safeParse(raw);
    if (!parsed.success) {
      throw new SinkError(`LM manual_account response failed validation: ${parsed.error.message}`);
    }
    return { balance: parsed.data.balance, currency: parsed.data.currency };
  }
}
