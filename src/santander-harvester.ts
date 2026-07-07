// Harvests a Santander OAuth token by driving a real browser login, then exits — the ONE
// place a browser is needed (the token endpoint is Akamai-gated; only a real browser
// produces the telemetry it demands). Everything downstream is pure HTTP.
//
// It captures the token at the NETWORK layer (`page.on("response")`) and stops the moment
// the token endpoint fires — no data-page navigation, so it avoids the drift-prone carousel
// and card-tab selectors OBC needs. Speaks JSON-lines on stdout, exactly like obc-runner.ts,
// so the parent can SIGKILL a wedged Chrome and enforce a hard timeout:
//   {"event":"progress","step":string}
//   {"event":"debug","line":string}
//   {"event":"2fa_wait"}                  — bank is waiting for an in-app / dynamic-key approval
//   {"event":"result","data":{accessToken,refreshToken}}
//   {"event":"error","message":string}
//
// Credentials come from env (bun auto-loads .env): SANTANDER_RUT, SANTANDER_PASS. The Chrome
// binary is found on FHS paths or via OBC_CHROME_PATH (the nix store path), same as obc-runner.
//
// The login selectors mirror open-banking-chile's proven Santander flow (iframe#login-frame,
// #rut clean-formatted, #pass); replicated rather than imported because OBC bundles them
// privately and exposes only a monolithic scrape().

import { existsSync } from "node:fs";
import puppeteer from "puppeteer-core";
import type { Browser, Frame, Page } from "puppeteer-core";

// The project's lib excludes DOM (pure-bun surface). These `page.evaluate` callbacks run in
// Chrome, so declare the few browser globals they touch MODULE-LOCALLY — a global DOM lib
// reference would leak stricter fetch/BodyInit types into the rest of the codebase.
interface BrowserEl {
  readonly innerText?: string;
  readonly disabled?: boolean;
  click(): void;
}
declare const document: {
  readonly body: { readonly innerText?: string } | null;
  querySelector(selectors: string): BrowserEl | null;
  querySelectorAll(selectors: string): ArrayLike<BrowserEl> & Iterable<BrowserEl>;
};
declare const navigator: Record<string, unknown>;

const BANK_URL = "https://banco.santander.cl/personas";
const TOKEN_URL_PREFIX =
  "https://apideveloper.santander.cl/sancl/privado/party_authentication_restricted/party_auth_dss/v1/oauth2/token";

const CHROME_CANDIDATES = [
  "/usr/bin/google-chrome-stable",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium-browser",
  "/usr/bin/chromium",
  "/snap/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
];

const LAUNCH_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--disable-gpu",
  "--window-size=1280,900",
  "--disable-blink-features=AutomationControlled",
];
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const TWO_FA_KEYWORDS = [
  "clave dinámica",
  "clave dinamica",
  "superclave",
  "segundo factor",
  "código de verificación",
  "codigo de verificacion",
  "ingresa tu token",
];
const REJECTION_KEYWORDS = ["rechazad", "denegad", "cancelad"];
const LOGIN_ERROR_RE =
  /(clave.*(err[oó]nea|incorrecta)|rut.*(err[oó]neo|incorrecto)|credencial|bloquead|intenta nuevamente|autenticaci[oó]n)/i;

type RunnerEvent =
  | { event: "progress"; step: string }
  | { event: "debug"; line: string }
  | { event: "2fa_wait" }
  | { event: "result"; data: { accessToken: string; refreshToken: string | null } }
  | { event: "error"; message: string };

const EXIT = { ok: 0, unexpected: 1, usage: 2, loginFailed: 3 } as const;

function emit(event: RunnerEvent): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function fail(code: number, message: string): never {
  emit({ event: "error", message });
  process.exit(code);
}

function findChrome(): string | null {
  const custom = process.env["OBC_CHROME_PATH"];
  if (custom && existsSync(custom)) return custom;
  return CHROME_CANDIDATES.find((p) => existsSync(p)) ?? null;
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function getLoginFrame(page: Page): Promise<Frame | null> {
  const handle = await page.$("iframe#login-frame");
  return handle ? await handle.contentFrame() : null;
}

async function combinedText(page: Page): Promise<string> {
  let text = await page.evaluate(() => (document.body?.innerText || "").toLowerCase());
  const frame = await getLoginFrame(page);
  if (frame) {
    try {
      text += `\n${await frame.evaluate(() => (document.body?.innerText || "").toLowerCase())}`;
    } catch {
      // frame detached mid-read; the page-level text stands
    }
  }
  return text;
}

async function fillLogin(page: Page, rut: string, password: string): Promise<void> {
  const frame = await getLoginFrame(page);
  const ctx: Page | Frame = frame ?? page;
  if (frame) emit({ event: "debug", line: "login iframe detected" });
  await ctx.waitForSelector("#rut", { timeout: 15_000 });
  await ctx.waitForSelector("#pass", { timeout: 15_000 });

  const rutClean = rut.replace(/[.-]/g, "");
  const rutField = await ctx.$("#rut");
  if (!rutField) fail(EXIT.loginFailed, "no se encontró el campo de RUT");
  await rutField.click({ clickCount: 3 });
  await rutField.type(rutClean, { delay: 45 });
  await delay(400);

  const passField = await ctx.$("#pass");
  if (!passField) fail(EXIT.loginFailed, "no se encontró el campo de clave");
  await passField.click();
  await passField.type(password, { delay: 45 });
  await delay(300);

  // Submit: the form's own button, else Enter.
  const submitted = await ctx.evaluate(() => {
    const btn = document.querySelector(
      "button[type=submit], #login-submit, .btn-login, button.mat-raised-button",
    );
    if (btn && !btn.disabled) {
      btn.click();
      return true;
    }
    return false;
  });
  if (!submitted) await page.keyboard.press("Enter");
}

interface CapturedToken {
  accessToken: string;
  refreshToken: string | null;
}

/** Install a network-level capture of the token endpoint's JSON response. */
function captureToken(page: Page): { get(): CapturedToken | null } {
  let captured: CapturedToken | null = null;
  page.on("response", (response) => {
    const req = response.request();
    if (req.method() !== "POST" || !response.url().startsWith(TOKEN_URL_PREFIX)) return;
    if (response.status() !== 200) return;
    void response
      .json()
      .then((body: unknown) => {
        const obj = body as { access_token?: unknown; refresh_token?: unknown };
        if (typeof obj?.access_token === "string" && obj.access_token.length > 0) {
          captured = {
            accessToken: obj.access_token,
            refreshToken: typeof obj.refresh_token === "string" ? obj.refresh_token : null,
          };
        }
      })
      .catch(() => {
        // body already consumed / not JSON — a later capture may still succeed
      });
  });
  return { get: () => captured };
}

function twoFaTimeoutSec(): number {
  const raw = Number.parseInt(process.env["SANTANDER_2FA_TIMEOUT_SEC"] ?? "180", 10);
  return Math.min(600, Math.max(30, Number.isFinite(raw) ? raw : 180));
}

async function harvest(rut: string, password: string): Promise<CapturedToken> {
  const executablePath = findChrome();
  if (!executablePath) {
    fail(
      EXIT.unexpected,
      "no se encontró Chrome/Chromium (instala Chrome o define OBC_CHROME_PATH)",
    );
  }
  const headful = process.env["SANTANDER_HEADFUL"] === "1";

  let browser: Browser | undefined;
  try {
    browser = await puppeteer.launch({ executablePath, headless: !headful, args: LAUNCH_ARGS });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.setUserAgent(USER_AGENT);
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
    });

    const token = captureToken(page);

    emit({ event: "progress", step: "Abriendo sitio del banco..." });
    await page.goto(BANK_URL, { waitUntil: "networkidle2", timeout: 30_000 });
    await delay(2_000);

    // Open the login form (button id, else by visible text).
    const opened = await page.evaluate(() => {
      const byId = document.querySelector("#btnIngresar");
      if (byId) {
        byId.click();
        return true;
      }
      const texts = ["ingresar", "acceso clientes", "banco en linea", "iniciar sesión"];
      for (const el of Array.from(document.querySelectorAll("button, a"))) {
        const t = el.innerText?.trim().toLowerCase() ?? "";
        if (texts.some((x) => t.includes(x))) {
          el.click();
          return true;
        }
      }
      return false;
    });
    if (!opened) fail(EXIT.loginFailed, "no se encontró el botón de ingreso");
    await delay(3_500);

    emit({ event: "progress", step: "Ingresando credenciales..." });
    await fillLogin(page, rut, password);
    emit({ event: "progress", step: "Iniciando sesión..." });

    // Wait for the token to appear, accommodating a 2FA approval in the middle.
    const hardDeadline = Date.now() + (twoFaTimeoutSec() + 60) * 1_000;
    let announced2fa = false;
    for (;;) {
      const got = token.get();
      if (got) return got;
      if (Date.now() > hardDeadline) fail(EXIT.loginFailed, "timeout esperando el token de sesión");

      const text = await combinedText(page).catch(() => "");
      if (!announced2fa && TWO_FA_KEYWORDS.some((kw) => text.includes(kw))) {
        announced2fa = true;
        emit({ event: "2fa_wait" });
        emit({ event: "debug", line: "2fa detectado — esperando aprobación" });
      }
      if (REJECTION_KEYWORDS.some((kw) => text.includes(kw))) {
        fail(EXIT.loginFailed, "2FA rechazado o login cancelado");
      }
      // Only trust a login-error match once we're not mid-2FA (the 2FA screen mentions "clave").
      if (!announced2fa) {
        const match = LOGIN_ERROR_RE.exec(text);
        if (match) fail(EXIT.loginFailed, `error del banco: ${match[0]}`);
      }
      await delay(1_500);
    }
  } finally {
    await browser?.close().catch(() => {});
  }
}

async function main(): Promise<never> {
  const rut = process.env["SANTANDER_RUT"];
  const password = process.env["SANTANDER_PASS"];
  if (!rut || !password) {
    fail(EXIT.usage, "faltan credenciales: define SANTANDER_RUT y SANTANDER_PASS");
  }
  const token = await harvest(rut, password);
  emit({
    event: "result",
    data: { accessToken: token.accessToken, refreshToken: token.refreshToken },
  });
  process.exit(EXIT.ok);
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
