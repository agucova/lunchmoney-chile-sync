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
interface BrowserStorage {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
}
declare const localStorage: BrowserStorage;
declare const sessionStorage: BrowserStorage;

const BANK_URL = "https://banco.santander.cl/personas";

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

/** JWT shape: three base64url segments, header starts with `eyJ`. */
const JWT_RE = /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/**
 * Capture the session token from multiple sources, most-reliable first:
 *   - the `Authorization: Bearer` header on the SPA's own API calls (headers are always
 *     readable — the token-endpoint RESPONSE body gets evicted by Chrome before we can read
 *     it, so header capture is the load-bearing path for the access token);
 *   - the token-endpoint response body (best-effort; the only place the refresh token lives);
 * `get()` prefers a complete pair (access + refresh) and otherwise returns access-only.
 */
function captureToken(page: Page): {
  get(): CapturedToken | null;
  seen: string[];
} {
  let bearerAccess: string | null = null;
  let responsePair: CapturedToken | null = null;
  const seen: string[] = [];

  page.on("request", (req) => {
    if (bearerAccess) return;
    const auth = req.headers()["authorization"];
    const match = auth ? /Bearer\s+(\S+)/i.exec(auth) : null;
    if (match?.[1] && JWT_RE.test(match[1])) bearerAccess = match[1];
  });

  page.on("response", (response) => {
    const req = response.request();
    const url = response.url();
    const isTokenCall = req.method() === "POST" && /\/oauth2\/token/.test(url);
    if (url.includes("apideveloper.santander.cl") || isTokenCall) {
      seen.push(`${req.method()} ${response.status()} ${url.split("?")[0]}`);
    }
    if (!isTokenCall || response.status() !== 200) return;
    void response
      .text()
      .then((text) => {
        let obj: { access_token?: unknown; refresh_token?: unknown };
        try {
          obj = JSON.parse(text);
        } catch {
          return;
        }
        if (typeof obj.access_token === "string" && obj.access_token.length > 0) {
          responsePair = {
            accessToken: obj.access_token,
            refreshToken: typeof obj.refresh_token === "string" ? obj.refresh_token : null,
          };
        }
      })
      .catch(() => {
        // body evicted; header capture covers the access token
      });
  });

  return {
    get: () =>
      responsePair ?? (bearerAccess ? { accessToken: bearerAccess, refreshToken: null } : null),
    seen,
  };
}

/**
 * Fallback source: after login the SPA may persist tokens in web storage — either a bare JWT
 * value or a JSON blob carrying access_token/refresh_token. Returns null if nothing usable is
 * present yet.
 */
async function extractTokenFromStorage(page: Page): Promise<CapturedToken | null> {
  const entries = await page
    .evaluate(() => {
      const out: Array<[string, string]> = [];
      for (const store of [localStorage, sessionStorage]) {
        for (let i = 0; i < store.length; i++) {
          const key = store.key(i);
          if (!key) continue;
          const value = store.getItem(key);
          if (value) out.push([key, value]);
        }
      }
      return out;
    })
    .catch(() => [] as Array<[string, string]>);

  let accessToken: string | null = null;
  let refreshToken: string | null = null;
  for (const [key, value] of entries) {
    if (!accessToken && JWT_RE.test(value)) accessToken = value;
    if (!refreshToken && /refresh/i.test(key) && value.length > 20 && !value.startsWith("{")) {
      refreshToken = value;
    }
    if (value.startsWith("{")) {
      try {
        const obj = JSON.parse(value) as { access_token?: unknown; refresh_token?: unknown };
        if (!accessToken && typeof obj.access_token === "string") accessToken = obj.access_token;
        if (!refreshToken && typeof obj.refresh_token === "string")
          refreshToken = obj.refresh_token;
      } catch {
        // not JSON after all
      }
    }
  }
  return accessToken ? { accessToken, refreshToken } : null;
}

/** The token with a refresh present, if any; used to prefer a complete pair over access-only. */
function pickBest(...candidates: Array<CapturedToken | null>): CapturedToken | null {
  const present = candidates.filter((c): c is CapturedToken => c !== null);
  return present.find((c) => c.refreshToken) ?? present[0] ?? null;
}

/** Dashboard reached: the private area / a logout affordance / the greeting. */
async function isLoggedIn(page: Page): Promise<boolean> {
  if (/\/private|mibanco\.santander\.cl/i.test(page.url())) return true;
  const text = await combinedText(page).catch(() => "");
  return /cerrar sesión|cerrar sesion|hola,/.test(text);
}

/** On failure, emit what we can see so a blind headless run is diagnosable. */
async function emitDiagnostics(page: Page, seen: string[]): Promise<void> {
  try {
    emit({ event: "debug", line: `url: ${page.url()}` });
  } catch {
    // page gone
  }
  emit({ event: "debug", line: `auth-host calls: ${seen.length ? seen.join(" | ") : "none"}` });
  try {
    const text = (await combinedText(page)).replace(/\s+/g, " ").slice(0, 400);
    emit({ event: "debug", line: `page text: ${text}` });
  } catch {
    // no readable text
  }
  const shot = process.env["SANTANDER_HARVEST_SHOT"];
  if (shot) {
    try {
      await page.screenshot({ path: shot, fullPage: true });
      emit({ event: "debug", line: `screenshot: ${shot}` });
    } catch {
      // screenshot failed; the other diagnostics stand
    }
  }
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

    // Fail path that first emits diagnostics (URL, auth-host calls, page text, screenshot),
    // so a blind headless failure is explainable without a second login.
    const failWithDiag = async (message: string): Promise<never> => {
      await emitDiagnostics(page, token.seen);
      fail(EXIT.loginFailed, message);
    };

    // Wait for the token from network capture + web storage. Prefer a complete pair
    // (access + refresh); once logged in, allow a short grace for the refresh source before
    // settling for access-only. Accommodates a 2FA approval in the middle.
    const hardDeadline = Date.now() + (twoFaTimeoutSec() + 60) * 1_000;
    const REFRESH_GRACE_MS = 8_000;
    let announced2fa = false;
    let loggedInSince: number | null = null;
    for (;;) {
      const loggedIn = await isLoggedIn(page);
      if (loggedIn && loggedInSince === null) loggedInSince = Date.now();

      const best = pickBest(token.get(), loggedIn ? await extractTokenFromStorage(page) : null);
      if (best?.refreshToken) {
        emit({ event: "debug", line: "token capturado (con refresh)" });
        return best;
      }
      if (best && loggedInSince !== null && Date.now() - loggedInSince > REFRESH_GRACE_MS) {
        emit({ event: "debug", line: "token capturado (solo access)" });
        return best;
      }
      if (Date.now() > hardDeadline) await failWithDiag("timeout esperando el token de sesión");

      const text = await combinedText(page).catch(() => "");
      if (!announced2fa && TWO_FA_KEYWORDS.some((kw) => text.includes(kw))) {
        announced2fa = true;
        emit({ event: "2fa_wait" });
        emit({ event: "debug", line: "2fa detectado — esperando aprobación" });
      }
      if (REJECTION_KEYWORDS.some((kw) => text.includes(kw))) {
        await failWithDiag("2FA rechazado o login cancelado");
      }
      // A login error only counts before login lands and while not mid-2FA (both the 2FA and
      // the dashboard mention "clave"/menu words the pattern could false-match).
      if (!announced2fa && !loggedIn) {
        const match = LOGIN_ERROR_RE.exec(text);
        if (match) await failWithDiag(`error del banco: ${match[0]}`);
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
