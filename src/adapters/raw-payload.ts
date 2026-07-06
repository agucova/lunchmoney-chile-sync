// Persist a raw source payload that failed validation, for offline diagnosis. Shared by
// every adapter's fail-closed path: on schema drift we keep the exact bytes that broke the
// parser. On the server this points into the systemd StateDirectory; locally fixtures/raw
// (gitignored — it may contain personal data).

export async function persistRawPayload(label: string, payload: unknown): Promise<string> {
  const dir = process.env["SYNC_DRIFT_DIR"] ?? "fixtures/raw";
  const path = `${dir}/drift-${label}-${Date.now()}.json`;
  await Bun.write(path, JSON.stringify(payload, null, 2));
  return path;
}

/**
 * Persist raw binary payloads (e.g. gRPC-web/protobuf frames) verbatim, so a mis-decoded
 * message can be re-inspected byte-for-byte — a JSON dump of a half-decoded protobuf is useless.
 * Writes one `.bin` per named part and returns the directory path.
 */
export async function persistRawBytes(
  label: string,
  parts: Record<string, Uint8Array>,
): Promise<string> {
  const dir = process.env["SYNC_DRIFT_DIR"] ?? "fixtures/raw";
  const stamp = `${label}-${Date.now()}`;
  await Promise.all(
    Object.entries(parts).map(([name, bytes]) =>
      Bun.write(`${dir}/drift-${stamp}-${name}.bin`, bytes),
    ),
  );
  return `${dir}/drift-${stamp}-*.bin`;
}
