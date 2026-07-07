// The harvester DRIVER against fake runner subprocesses — exercises the JSON-lines protocol,
// error classification, and JWT-expiry derivation without launching a real browser. (The
// real Puppeteer runner is validated live, not here.)
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { makeBrowserHarvester } from "../src/adapters/santander/harvest.ts";
import { AuthError, SourceUnavailableError, TwoFactorTimeoutError } from "../src/core/errors.ts";

const DIR = `${process.env["TMPDIR"] ?? "/tmp"}/santander-harvest-test`;
const CREDS = { rut: "12345678-9", password: "hunter2" };

/** A JWT whose exp is `deltaSec` from now (unsigned; only the exp claim matters). */
function jwt(deltaSec: number): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({ exp: Math.floor(Date.now() / 1000) + deltaSec }),
  ).toString("base64url");
  return `${header}.${payload}.sig`;
}

/** Write a fake runner that emits the given lines then exits with `code`. */
async function fakeRunner(name: string, lines: string[], code = 0): Promise<string> {
  const path = `${DIR}/${name}.ts`;
  const body =
    lines.map((l) => `process.stdout.write(${JSON.stringify(`${l}\n`)});`).join("\n") +
    `\nprocess.exit(${code});\n`;
  await Bun.write(path, body);
  return path;
}

beforeAll(async () => {
  await Bun.write(`${DIR}/.keep`, "");
});

afterAll(async () => {
  await Bun.$`rm -rf ${DIR}`.quiet().nothrow();
});

describe("makeBrowserHarvester (driver)", () => {
  test("parses a result event and derives expiry from the access-token JWT", async () => {
    const access = jwt(1800);
    const runnerPath = await fakeRunner("ok", [
      JSON.stringify({ event: "progress", step: "abriendo" }),
      JSON.stringify({ event: "result", data: { accessToken: access, refreshToken: "RT9" } }),
    ]);
    const steps: string[] = [];
    const harvest = makeBrowserHarvester(
      CREDS,
      { onProgress: (s) => steps.push(s) },
      { runnerPath },
    );
    const token = await harvest();
    expect(token.accessToken).toBe(access);
    expect(token.refreshToken).toBe("RT9");
    // Expiry within a second of exp.
    const skew = Math.abs(Date.parse(token.accessTokenExpiresAt) - (Date.now() + 1800_000));
    expect(skew).toBeLessThan(2000);
    expect(steps).toContain("abriendo");
  });

  test("a non-JWT access token falls back to a short TTL rather than failing", async () => {
    const runnerPath = await fakeRunner("nonjwt", [
      JSON.stringify({
        event: "result",
        data: { accessToken: "opaque-token", refreshToken: null },
      }),
    ]);
    const logs: string[] = [];
    const harvest = makeBrowserHarvester(CREDS, { log: (m) => logs.push(m) }, { runnerPath });
    const token = await harvest();
    expect(token.accessToken).toBe("opaque-token");
    expect(token.refreshToken).toBeNull();
    expect(Date.parse(token.accessTokenExpiresAt)).toBeGreaterThan(Date.now());
    expect(logs.some((l) => /not a decodable JWT/.test(l))).toBe(true);
  });

  test("a 2fa_wait before the result fires the hook and still resolves", async () => {
    const access = jwt(1800);
    const runnerPath = await fakeRunner("twofa", [
      JSON.stringify({ event: "2fa_wait" }),
      JSON.stringify({ event: "result", data: { accessToken: access, refreshToken: "RT" } }),
    ]);
    let waited = false;
    const harvest = makeBrowserHarvester(
      CREDS,
      { onTwoFactorWait: () => (waited = true) },
      { runnerPath },
    );
    const token = await harvest();
    expect(waited).toBe(true);
    expect(token.accessToken).toBe(access);
  });

  test("an auth-flavored error becomes AuthError", async () => {
    const runnerPath = await fakeRunner(
      "auth",
      [JSON.stringify({ event: "error", message: "error del banco: clave incorrecta" })],
      3,
    );
    const harvest = makeBrowserHarvester(CREDS, {}, { runnerPath });
    expect(harvest()).rejects.toThrow(AuthError);
  });

  test("a 2fa timeout error becomes TwoFactorTimeoutError", async () => {
    const runnerPath = await fakeRunner(
      "2fatimeout",
      [
        JSON.stringify({ event: "2fa_wait" }),
        JSON.stringify({ event: "error", message: "2FA rechazado o login cancelado" }),
      ],
      3,
    );
    const harvest = makeBrowserHarvester(CREDS, {}, { runnerPath });
    expect(harvest()).rejects.toThrow(TwoFactorTimeoutError);
  });

  test("an exit without a result classifies as SourceUnavailable", async () => {
    const runnerPath = await fakeRunner("silent", [
      JSON.stringify({ event: "progress", step: "abriendo" }),
    ]);
    const harvest = makeBrowserHarvester(CREDS, {}, { runnerPath });
    expect(harvest()).rejects.toThrow(SourceUnavailableError);
  });

  test("passes resolved creds into the subprocess env", async () => {
    const runnerPath = `${DIR}/echo-creds.ts`;
    await Bun.write(
      runnerPath,
      `const rut = process.env.SANTANDER_RUT, pass = process.env.SANTANDER_PASS;\n` +
        `process.stdout.write(JSON.stringify({ event: "result", data: { accessToken: ` +
        `"rut:" + rut + ";pass:" + pass, refreshToken: null } }) + "\\n");\n`,
    );
    const harvest = makeBrowserHarvester({ rut: "R123", password: "P456" }, {}, { runnerPath });
    const token = await harvest();
    expect(token.accessToken).toBe("rut:R123;pass:P456");
  });
});
