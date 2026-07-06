// obc source adapter: drives the scraper subprocess (src/obc-runner.ts) and turns its
// JSON-lines events + payload into per-sub-account FetchResults.
//
// The subprocess boundary lets us SIGKILL a wedged Chrome session and enforce a hard
// timeout. Failures are classified into the typed error taxonomy so the sync engine
// can apply the right failover policy.

import { z } from "zod";
import type { ObcConnectionConfig } from "../config.ts";
import { requireEnv } from "../config.ts";
import { todayInSantiago } from "../core/dates.ts";
import {
  AuthError,
  SchemaDriftError,
  SourceUnavailableError,
  TwoFactorTimeoutError,
} from "../core/errors.ts";
import type { FetchResult } from "../core/model.ts";
import { parseObcPayload } from "./obc-payload.ts";
import { persistRawPayload } from "./raw-payload.ts";

const RUNNER_PATH = new URL("../obc-runner.ts", import.meta.url).pathname;

/** Scrape ~1min; a conditional 2FA wait adds up to 10min. Hard cap beyond both. */
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

const RunnerEventSchema = z.discriminatedUnion("event", [
  z.object({ event: z.literal("progress"), step: z.string() }),
  z.object({ event: z.literal("debug"), line: z.string() }),
  z.object({ event: z.literal("2fa_wait") }),
  z.object({ event: z.literal("result"), data: z.unknown() }),
  z.object({ event: z.literal("error"), message: z.string() }),
]);

export interface ObcHooks {
  onProgress?: (step: string) => void;
  /** Fired once when the bank is waiting for an in-app approval. */
  onTwoFactorWait?: () => void;
}

const AUTH_HINTS = /clave|contraseñ|credencial|bloquead|password|rut inv/i;
const TWO_FACTOR_HINTS = /2fa|segundo factor|no fue aprobad|tiempo de espera.*aprobaci/i;

function classifyScrapeFailure(message: string): Error {
  if (TWO_FACTOR_HINTS.test(message)) return new TwoFactorTimeoutError(message);
  if (AUTH_HINTS.test(message)) return new AuthError(message);
  return new SourceUnavailableError(message);
}

/**
 * Run one scrape for a connection and return per-sub-account FetchResults
 * (keyed by subAccountKey). Throws classified SyncErrors.
 */
export async function fetchObcConnection(
  connection: ObcConnectionConfig,
  hooks: ObcHooks = {},
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<Map<string, FetchResult>> {
  // Fail fast on missing secrets before launching a browser.
  requireEnv(connection.rut_env);
  requireEnv(connection.password_env);

  const proc = Bun.spawn(["bun", RUNNER_PATH, "--bank", connection.obc_bank], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const killTimer = setTimeout(() => {
    proc.kill(9);
  }, timeoutMs);

  let resultPayload: unknown;
  let errorMessage: string | undefined;
  let sawTwoFactorWait = false;
  const debugTail: string[] = [];

  try {
    const stdoutText = new Response(proc.stdout).text();
    const stderrText = new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    const [stdout, stderr] = await Promise.all([stdoutText, stderrText]);

    for (const line of stdout.split("\n")) {
      if (line.trim() === "") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw new SchemaDriftError(`obc runner emitted non-JSON line: ${line.slice(0, 200)}`);
      }
      const event = RunnerEventSchema.safeParse(parsed);
      if (!event.success) {
        throw new SchemaDriftError(`obc runner emitted unknown event: ${line.slice(0, 200)}`);
      }
      switch (event.data.event) {
        case "progress":
          hooks.onProgress?.(event.data.step);
          break;
        case "debug":
          debugTail.push(event.data.line);
          if (debugTail.length > 40) debugTail.shift();
          break;
        case "2fa_wait":
          sawTwoFactorWait = true;
          hooks.onTwoFactorWait?.();
          break;
        case "result":
          resultPayload = event.data.data;
          break;
        case "error":
          errorMessage = event.data.message;
          break;
      }
    }

    if (resultPayload === undefined) {
      const detail =
        errorMessage ??
        (exitCode === null
          ? "runner killed by timeout"
          : `runner exited ${exitCode} without a result: ${stderr.slice(0, 300)}`);
      if (sawTwoFactorWait) throw new TwoFactorTimeoutError(detail);
      throw classifyScrapeFailure(detail);
    }

    // The runner exits 3 when the scraper reported success:false; the payload then
    // carries the bank's error message.
    const failure = (resultPayload as { success?: boolean; error?: string }) ?? {};
    if (failure.success !== true) {
      const detail = failure.error ?? debugTail.slice(-5).join(" | ");
      if (sawTwoFactorWait && TWO_FACTOR_HINTS.test(detail)) {
        throw new TwoFactorTimeoutError(detail);
      }
      throw classifyScrapeFailure(detail);
    }

    try {
      return parseObcPayload(
        connection.obc_bank,
        resultPayload,
        todayInSantiago(),
        new Date().toISOString(),
      );
    } catch (err) {
      if (err instanceof SchemaDriftError) {
        const path = await persistRawPayload(connection.obc_bank, resultPayload);
        throw new SchemaDriftError(`${err.message} (raw payload: ${path})`, path, err);
      }
      throw err;
    }
  } finally {
    clearTimeout(killTimer);
    proc.kill();
  }
}
