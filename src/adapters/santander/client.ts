// Pure-HTTP client for Santander's native JSON API (the same one their web frontend
// calls). No browser is involved here: every endpoint below accepts a plain OAuth2
// bearer token — the Akamai gate exists only on the token endpoint, which is the token
// manager's problem, not this client's.
//
// URLs, headers and body constants are verbatim from the 2026-07 HAR capture and were
// live-verified by replay from this codebase. The odd-looking constants (the fixed
// x-B3-SpanId, InfoDispositivo: "InfoDispositivo") are hardcoded exactly like that in
// the bank's own frontend bundle.

import {
  AuthError,
  invariant,
  SchemaDriftError,
  SourceUnavailableError,
} from "../../core/errors.ts";
import type { IsoDate } from "../../core/dates.ts";
import type { CurrencyCode } from "../../core/money.ts";

const INVENTORY_URL = "https://api-dsk.santander.cl/perdsk/datosCliente/cruceProductosOnline";
const CHECKING_TXNS_URL =
  "https://openbanking.santander.cl/account_balances_transactions_and_withholdings_retail/v1/current-accounts/transactions";
const CARD_MOVEMENTS_URL =
  "https://api-dsk.santander.cl/perdsk/tarjetasDeCredito/consultaUltimosMovimientos";
const CARD_STATEMENTS_URL =
  "https://api-dsk.santander.cl/perdsk/tarjetasDeCredito/cuentasDisponibles";
const BILLED_STATEMENT_URL =
  "https://api-dsk.santander.cl/perdsk/tarjetasDeCredito/estadoCuentaNacional";

/** Static app key embedded in the bank's frontend bundle (not a secret). */
const SANTANDER_CLIENT_ID = "O2XRSU4kVspEGbLDDGfFC5BOTrGKh5Ts";

/** Altamira entity code for Banco Santander Chile (card requests' Entrada.Entidad). */
const ENTIDAD_SANTANDER_CL = "0035";

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:153.0) Gecko/20100101 Firefox/153.0";

const COMMON_HEADERS = {
  Accept: "application/json, text/plain, */*",
  "Content-Type": "application/json",
  Origin: "https://mibanco.santander.cl",
  Referer: "https://mibanco.santander.cl/",
  "User-Agent": USER_AGENT,
  "X-Santander-Client-Id": SANTANDER_CLIENT_ID,
} as const;

/** The openbanking host additionally requires these (also frontend constants). */
const CHECKING_EXTRA_HEADERS = {
  "X-Client-Code": "STD-PER-FPP",
  "X-Organization-Code": "Santander",
  "x-schema-id": "GHOBP",
  "x-B3-SpanId": "AL43243287438243P",
} as const;

/**
 * Format a configured RUT ("12.345.678-9", "12345678-9", …) as the API's 11-char
 * zero-padded RutCliente/NUMERODOCUMENTO (digits + verifier, no separators).
 */
export function formatRutCliente(rut: string): string {
  const compact = rut.replace(/[.\-\s]/g, "").toUpperCase();
  invariant(/^\d{7,10}[0-9K]$/.test(compact), `not a plausible RUT: ${JSON.stringify(rut)}`);
  return compact.padStart(11, "0");
}

export interface SantanderCredentials {
  /** OAuth2 access token minted at the (Akamai-gated) token endpoint. */
  readonly accessToken: string;
  /** 11-char RutCliente (see formatRutCliente). */
  readonly rutCliente: string;
}

export class SantanderClient {
  constructor(
    private readonly credentials: SantanderCredentials,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** Product inventory: contracts, currencies, balances for every active product. */
  fetchInventory(): Promise<unknown> {
    const rut = this.credentials.rutCliente;
    return this.post(INVENTORY_URL, "inventory", {
      cabecera: {
        HOST: { "USUARIO-ALT": "GHOBP", "TERMINAL-ALT": "", "CANAL-ID": "078" },
        CanalFisico: "003",
        CanalLogico: "74",
        RutCliente: rut,
        RutUsuario: rut,
        InfoDispositivo: "003",
        InfoGeneral: { NumeroServidor: "01" },
      },
      INPUT: {
        "ID-RECALL": "",
        "USUARIO-ALT": "GHOBP",
        ENTIDAD: "",
        TIPODOCUMENTO: "",
        NUMERODOCUMENTO: rut,
        CANALACONSULTAR: "",
        CRUCEACONSULTAR: "",
        ESTADORELACION: "",
      },
    });
  }

  /** Checking-account movements for [opening, closing] (both inclusive, ISO). */
  fetchCheckingTransactions(args: {
    office: string;
    contract: string;
    currency: CurrencyCode;
    opening: IsoDate;
    closing: IsoDate;
  }): Promise<unknown> {
    return this.post(
      CHECKING_TXNS_URL,
      "checking",
      {
        accountId: `${args.office}${args.contract}`,
        currency: args.currency,
        commercialGroup: "",
        openingDate: args.opening,
        closingDate: args.closing,
      },
      CHECKING_EXTRA_HEADERS,
    );
  }

  /** Recent card movements for one currency leg of a card contract. */
  fetchCardMovements(args: {
    office: string;
    contract: string;
    currency: CurrencyCode;
  }): Promise<unknown> {
    const rut = this.credentials.rutCliente;
    return this.post(CARD_MOVEMENTS_URL, "card", {
      Cabecera: {
        HOST: { "USUARIO-ALT": "GHOBP", "TERMINAL-ALT": "", "CANAL-ID": "003" },
        CanalFisico: "",
        CanalLogico: "",
        RutCliente: rut,
        RutUsuario: rut,
        IpCliente: "",
        InfoDispositivo: "InfoDispositivo",
      },
      Entrada: {
        Entidad: ENTIDAD_SANTANDER_CL,
        Centro: args.office,
        Cuenta: args.contract,
        Moneda: args.currency,
      },
    });
  }

  /** Available billed statements for a card contract (per currency, newest first). */
  fetchCardStatements(args: { office: string; contract: string }): Promise<unknown> {
    return this.post(CARD_STATEMENTS_URL, "card-statements", {
      cabecera: this.cardCabecera(),
      INPUT: {
        "USUARIO-ALT": "GHOBP",
        "CANAL-ID": "003",
        CODENT: ENTIDAD_SANTANDER_CL,
        CENTALT: args.office,
        CUENTA: args.contract,
        PAN: "",
      },
    });
  }

  /** Billed line items for one statement of a card contract (CLP national statement). */
  fetchBilledStatement(args: {
    office: string;
    contract: string;
    numExtracto: string;
  }): Promise<unknown> {
    return this.post(BILLED_STATEMENT_URL, "billed-statement", {
      cabecera: this.cardCabecera(),
      INPUT: {
        "USUARIO-ALT": "GHOBP",
        "TERMINAL-ALT": "",
        "CANAL-ID": "003",
        FILLER: "",
        CodEnt: ENTIDAD_SANTANDER_CL,
        CentAlt: args.office,
        Cuenta: args.contract,
        Pan: "",
        NumExtracto: args.numExtracto,
        NumMov: "",
        FilasRecuperar: "",
        "ID-RECALL": "",
      },
    });
  }

  /** The `cabecera` block shared by the card statement/billed endpoints. */
  private cardCabecera(): Record<string, unknown> {
    const rut = this.credentials.rutCliente;
    return {
      HOST: { "USUARIO-ALT": "GHOBP", "TERMINAL-ALT": "", "CANAL-ID": "003" },
      CanalFisico: "",
      CanalLogico: "",
      RutCliente: rut,
      RutUsuario: rut,
      InfoDispositivo: "InfoDispositivo",
    };
  }

  private async post(
    url: string,
    label: string,
    body: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          ...COMMON_HEADERS,
          ...extraHeaders,
          Authorization: `Bearer ${this.credentials.accessToken}`,
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new SourceUnavailableError(`santander ${label} request failed: ${String(err)}`, err);
    }
    if (response.status === 401 || response.status === 403) {
      throw new AuthError(`santander ${label} rejected the access token (${response.status})`);
    }
    if (!response.ok) {
      const excerpt = (await response.text().catch(() => "")).slice(0, 200);
      throw new SourceUnavailableError(
        `santander ${label} returned HTTP ${response.status}: ${excerpt}`,
      );
    }
    try {
      return await response.json();
    } catch {
      throw new SchemaDriftError(`santander ${label} returned a non-JSON body`);
    }
  }
}
