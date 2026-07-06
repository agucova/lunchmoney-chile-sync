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
