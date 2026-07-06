// gRPC-web transport for grpc.betterplan.cl. Hand-framed (5-byte prefix), pure Bun fetch.
//
// Cloudflare fronts this host and rejects non-browser requests, so every call carries the
// browser header set (a real User-Agent + Origin/Referer). Classification is layered because
// failures arrive at three levels (see docs/betterplan-api.md):
//   - Transport: a Cloudflare 403 is an HTML page, not a gRPC frame — never feed it to a decoder.
//   - HTTP: 401 → auth; 429/5xx/network → transient (one retry).
//   - gRPC: HTTP 200 carries a trailer frame with grpc-status; 16 → auth, 0 → ok, else transient.

import { AuthError, SchemaDriftError, SourceUnavailableError } from "../core/errors.ts";

const GRPC_BASE = "https://grpc.betterplan.cl";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:153.0) Gecko/20100101 Firefox/153.0";
const REQUEST_TIMEOUT_MS = 30_000;
const RETRY_BACKOFF_MS = 2_000;

export interface GrpcDeps {
  readonly accessToken: string;
  readonly fetchImpl: typeof fetch;
}

interface Frame {
  readonly trailer: boolean;
  readonly payload: Uint8Array;
}

function frameRequest(payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(5 + payload.length);
  const view = new DataView(out.buffer);
  out[0] = 0x00; // uncompressed data frame
  view.setUint32(1, payload.length, false); // big-endian length
  out.set(payload, 5);
  return out;
}

function parseFrames(buf: Uint8Array): Frame[] {
  const frames: Frame[] = [];
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let pos = 0;
  while (pos + 5 <= buf.length) {
    const flags = buf[pos] as number;
    const len = view.getUint32(pos + 1, false);
    const start = pos + 5;
    if (start + len > buf.length) break; // truncated frame
    frames.push({ trailer: (flags & 0x80) !== 0, payload: buf.subarray(start, start + len) });
    pos = start + len;
  }
  return frames;
}

/** Parse `grpc-status`/`grpc-message` from a trailer frame body ("grpc-status:0\r\n..."). */
function parseTrailer(payload: Uint8Array): { status: number; message: string } {
  const text = new TextDecoder().decode(payload);
  const statusMatch = text.match(/grpc-status:\s*(\d+)/i);
  const messageMatch = text.match(/grpc-message:\s*([^\r\n]*)/i);
  return {
    status: statusMatch ? Number(statusMatch[1]) : -1,
    message: messageMatch?.[1]?.trim() ?? "",
  };
}

async function invokeOnce(method: string, request: Uint8Array, deps: GrpcDeps): Promise<Response> {
  return deps.fetchImpl(`${GRPC_BASE}/${method}`, {
    method: "POST",
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "application/grpc-web+proto",
      "Accept-Language": "en-US,en;q=0.9",
      "Accept-Encoding": "identity",
      "Content-Type": "application/grpc-web+proto",
      "x-grpc-web": "1",
      Authorization: `Bearer ${deps.accessToken}`,
      Origin: "https://portal.betterplan.cl",
      Referer: "https://portal.betterplan.cl/",
      "Sec-Fetch-Dest": "empty",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "same-site",
    },
    body: frameRequest(request),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

/**
 * Invoke a unary gRPC-web method and return the response message bytes. `request` is the encoded
 * protobuf (empty Uint8Array for no-arg methods). Throws classified SyncErrors; the response
 * bytes are for the caller to decode.
 */
export async function grpcInvoke(
  method: string,
  request: Uint8Array,
  deps: GrpcDeps,
): Promise<Uint8Array> {
  let response: Response | undefined;
  let networkErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS));
    try {
      response = await invokeOnce(method, request, deps);
    } catch (err) {
      response = undefined;
      networkErr = err;
      continue;
    }
    if (attempt === 0 && (response.status === 429 || response.status >= 500)) continue;
    break;
  }
  if (!response) {
    throw new SourceUnavailableError(`betterplan ${method} network error`, networkErr);
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (response.status === 401) {
    throw new AuthError(`betterplan ${method} rejected the access token (HTTP 401)`);
  }
  if (response.status !== 200 || !contentType.includes("grpc")) {
    // Cloudflare challenge (403 HTML) or any non-gRPC body: transient, and never decoded.
    const snippet = (await response.text()).slice(0, 200).replace(/\s+/g, " ");
    throw new SourceUnavailableError(
      `betterplan ${method} non-grpc response (HTTP ${response.status}, ${contentType}): ${snippet}`,
    );
  }

  const body = new Uint8Array(await response.arrayBuffer());
  const frames = parseFrames(body);
  const trailer = frames.find((f) => f.trailer);
  const message = frames.find((f) => !f.trailer);

  if (trailer) {
    const { status, message: gmsg } = parseTrailer(trailer.payload);
    if (status === 16) throw new AuthError(`betterplan ${method} UNAUTHENTICATED (grpc-status 16)`);
    if (status !== 0) {
      throw new SourceUnavailableError(
        `betterplan ${method} grpc-status ${status}${gmsg ? `: ${gmsg}` : ""}`,
      );
    }
  } else if (!message) {
    // No trailer and no message — the frame structure is not what we expect.
    throw new SchemaDriftError(`betterplan ${method}: unframed response (${body.length} bytes)`);
  }

  return message ? message.payload : new Uint8Array(0);
}
