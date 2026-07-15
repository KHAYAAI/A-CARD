import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Webhook signing, Stripe-style: HMAC-SHA256 over `${timestamp}.${rawBody}`,
 * transported as `t=<unix>,v1=<hex>` in the `x-acard-signature` header.
 * Verification is timing-safe and rejects stale timestamps to stop replay.
 */

const DEFAULT_TOLERANCE_SECONDS = 300;

export function signWebhook(rawBody: string, secret: string, timestamp = Math.floor(Date.now() / 1000)): string {
  const mac = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  return `t=${timestamp},v1=${mac}`;
}

export function verifyWebhook(
  rawBody: string,
  header: string | undefined | null,
  secret: string,
  opts: { toleranceSeconds?: number; now?: number } = {},
): { valid: boolean; reason?: string } {
  if (!header) return { valid: false, reason: "missing_signature" };

  const parts = new Map<string, string>();
  for (const piece of header.split(",")) {
    const idx = piece.indexOf("=");
    if (idx > 0) parts.set(piece.slice(0, idx).trim(), piece.slice(idx + 1).trim());
  }
  const timestampRaw = parts.get("t");
  const signature = parts.get("v1");
  if (!timestampRaw || !signature) return { valid: false, reason: "malformed_signature" };

  const timestamp = Number(timestampRaw);
  if (!Number.isFinite(timestamp)) return { valid: false, reason: "malformed_timestamp" };

  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const tolerance = opts.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  if (Math.abs(now - timestamp) > tolerance) return { valid: false, reason: "timestamp_out_of_tolerance" };

  const expected = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest();
  let provided: Buffer;
  try {
    provided = Buffer.from(signature, "hex");
  } catch {
    return { valid: false, reason: "malformed_signature" };
  }
  if (provided.length !== expected.length) return { valid: false, reason: "bad_signature" };
  if (!timingSafeEqual(provided, expected)) return { valid: false, reason: "bad_signature" };
  return { valid: true };
}
