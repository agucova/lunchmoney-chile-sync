// Runs one open-banking-chile scrape as an isolated subprocess and speaks JSON-lines
// on stdout:
//   {"event":"progress","step":string}
//   {"event":"debug","line":string}
//   {"event":"2fa_wait"}                  — bank is waiting for an in-app approval
//   {"event":"result","data":ScrapeResult}
//   {"event":"error","message":string}
// The subprocess boundary exists so the parent can SIGKILL a wedged Chrome session and
// enforce timeouts. Amounts pass through exactly as the scraper produced them — no
// arithmetic happens here.
//
// Usage: bun src/obc-runner.ts --bank <id> [--headful] [--owner T|A|B]
// Parse errors (unknown/invalid flags) exit 1 with the message on stderr; stdout stays
// pure JSON-lines. Credentials come from env (bun auto-loads .env), following the
// scraper's own CLI convention: SANTANDER_RUT/SANTANDER_PASS, BANCOCHILE_RUT/….
import { object } from "@optique/core/constructs";
import { optional, withDefault } from "@optique/core/modifiers";
import { flag, option } from "@optique/core/primitives";
import { choice } from "@optique/core/valueparser";
import { run } from "@optique/run";
import { getBank, listBanks } from "open-banking-chile";
import type { ScrapeResult } from "open-banking-chile";

type RunnerEvent =
  | { event: "progress"; step: string }
  | { event: "debug"; line: string }
  | { event: "2fa_wait" }
  | { event: "result"; data: ScrapeResult }
  | { event: "error"; message: string };

const ENV_PREFIX: Record<string, string> = {
  santander: "SANTANDER",
  bchile: "BANCOCHILE",
  bci: "BCI",
};

const EXIT = { ok: 0, unexpected: 1, usage: 2, scrapeFailed: 3 } as const;

function emit(event: RunnerEvent): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function fail(code: number, message: string): never {
  emit({ event: "error", message });
  process.exit(code);
}

const bankIds = listBanks().map((b) => b.id);

async function main(): Promise<never> {
  const opts = run(
    object({
      bank: option("--bank", choice(bankIds)),
      headful: withDefault(flag("--headful"), false),
      screenshots: withDefault(flag("--screenshots"), false),
      owner: optional(option("--owner", choice(["T", "A", "B"]))),
    }),
    { programName: "obc-runner" },
  );

  const bank = getBank(opts.bank);
  if (!bank) fail(EXIT.usage, `unknown bank "${opts.bank}"`);

  const prefix = ENV_PREFIX[opts.bank] ?? opts.bank.toUpperCase();
  const rut = process.env[`${prefix}_RUT`];
  const password = process.env[`${prefix}_PASS`];
  if (!rut || !password) {
    fail(EXIT.usage, `missing credentials: set ${prefix}_RUT and ${prefix}_PASS`);
  }

  // NixOS: the scraper's findChrome only probes FHS paths; the store path comes via env.
  const chromePath = process.env["OBC_CHROME_PATH"];

  let announced2fa = false;
  const result = await bank.scrape({
    rut,
    password,
    headful: opts.headful,
    saveScreenshots: opts.screenshots,
    ...(chromePath ? { chromePath } : {}),
    ...(opts.owner !== undefined ? { owner: opts.owner } : {}),
    onProgress: (step) => emit({ event: "progress", step }),
    onDebug: (line) => {
      emit({ event: "debug", line });
      if (!announced2fa && /2fa detectado/i.test(line)) {
        announced2fa = true;
        emit({ event: "2fa_wait" });
      }
    },
  });

  emit({ event: "result", data: result });
  process.exit(result.success ? EXIT.ok : EXIT.scrapeFailed);
}

process.on("unhandledRejection", (reason) => {
  fail(
    EXIT.unexpected,
    `unhandled rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`,
  );
});

await main().catch((err: unknown) => {
  fail(EXIT.unexpected, err instanceof Error ? (err.stack ?? err.message) : String(err));
});
