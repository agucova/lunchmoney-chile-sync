// Driver for the Santander token harvester subprocess (src/santander-harvester.ts): runs it,
// parses its JSON-lines events, classifies failures into the typed taxonomy, and returns a
// HarvestedToken (expiry derived from the access-token JWT). The subprocess boundary lets us
// SIGKILL a wedged Chrome and enforce a hard timeout, exactly like the OBC adapter.

import { z } from "zod";
import {
  AuthError,
  SchemaDriftError,
  SourceUnavailableError,
  TwoFactorTimeoutError,
} from "../../core/errors.ts";
import { accessTokenExpiry, type BrowserHarvester, type HarvestedToken } from "./auth.ts";

const HARVESTER_PATH = new URL("../../santander-harvester.ts", import.meta.url).pathname;

/** Login ~30s; a 2FA approval can add minutes. Hard cap beyond both. */
const DEFAULT_TIMEOUT_MS = 8 * 60 * 1000;

/** If the JWT carries no decodable exp, use the token once and re-mint next run. */
const FALLBACK_TTL_MS = 10 * 60 * 1000;

const RunnerEventSchema = z.discriminatedUnion("event", [
  z.object({ event: z.literal("progress"), step: z.string() }),
  z.object({ event: z.literal("debug"), line: z.string() }),
  z.object({ event: z.literal("2fa_wait") }),
  z.object({
    event: z.literal("result"),
    data: z.object({ accessToken: z.string().min(1), refreshToken: z.string().nullable() }),
  }),
  z.object({ event: z.literal("error"), message: z.string() }),
]);

export interface HarvestHooks {
  onProgress?: (step: string) => void;
  onTwoFactorWait?: () => void;
  log?: (message: string) => void;
}

export interface HarvestOptions {
  timeoutMs?: number;
  /** Runner script to spawn; defaults to the real harvester. Injected in tests. */
  runnerPath?: string;
}

const AUTH_HINTS = /clave|credencial|bloquead|rut.*incorrect|contrase/i;
const TWO_FACTOR_HINTS = /2fa|segundo factor|rechazad|aprobaci|clave din/i;

function classifyFailure(message: string, sawTwoFactorWait: boolean): Error {
  if (sawTwoFactorWait || TWO_FACTOR_HINTS.test(message)) return new TwoFactorTimeoutError(message);
  if (AUTH_HINTS.test(message)) return new AuthError(message);
  return new SourceUnavailableError(message);
}

/**
 * Build a BrowserHarvester bound to one connection's credentials. The subprocess reads
 * SANTANDER_RUT/SANTANDER_PASS from its env, so we pass the resolved values explicitly
 * (decoupling the env-var names the connection config references).
 */
export function makeBrowserHarvester(
  creds: { rut: string; password: string },
  hooks: HarvestHooks = {},
  options: HarvestOptions = {},
): BrowserHarvester {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const runnerPath = options.runnerPath ?? HARVESTER_PATH;
  return async (): Promise<HarvestedToken> => {
    const proc = Bun.spawn(["bun", runnerPath], {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        SANTANDER_RUT: creds.rut,
        SANTANDER_PASS: creds.password,
      },
    });
    const killTimer = setTimeout(() => proc.kill(9), timeoutMs);

    let result: { accessToken: string; refreshToken: string | null } | undefined;
    let errorMessage: string | undefined;
    let sawTwoFactorWait = false;
    const debugTail: string[] = [];

    try {
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      const exitCode = await proc.exited;

      for (const line of stdout.split("\n")) {
        if (line.trim() === "") continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          throw new SchemaDriftError(`harvester emitted non-JSON line: ${line.slice(0, 200)}`);
        }
        const event = RunnerEventSchema.safeParse(parsed);
        if (!event.success) {
          throw new SchemaDriftError(`harvester emitted unknown event: ${line.slice(0, 200)}`);
        }
        switch (event.data.event) {
          case "progress":
            hooks.onProgress?.(event.data.step);
            break;
          case "debug":
            debugTail.push(event.data.line);
            if (debugTail.length > 20) debugTail.shift();
            break;
          case "2fa_wait":
            sawTwoFactorWait = true;
            hooks.onTwoFactorWait?.();
            break;
          case "result":
            result = event.data.data;
            break;
          case "error":
            errorMessage = event.data.message;
            break;
        }
      }

      if (!result) {
        const detail =
          errorMessage ??
          (exitCode === null
            ? "harvester killed by timeout"
            : `harvester exited ${exitCode} without a token: ${stderr.slice(0, 300)}`);
        throw classifyFailure(detail, sawTwoFactorWait);
      }

      const expiry = accessTokenExpiry(result.accessToken);
      if (!expiry) {
        hooks.log?.("santander: harvested access token is not a decodable JWT; using short TTL");
      }
      return {
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        accessTokenExpiresAt: expiry ?? new Date(Date.now() + FALLBACK_TTL_MS).toISOString(),
      };
    } finally {
      clearTimeout(killTimer);
      proc.kill();
    }
  };
}
