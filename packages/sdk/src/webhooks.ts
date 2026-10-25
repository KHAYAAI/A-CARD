import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verifying A-CARD webhook signatures: `x-acard-signature: t=<unix>,v1=<hex>`,
 * where v1 = HMAC-SHA256(key, `${t}.${rawBody}`).
 *
 * Always pass the raw request body exactly as received — re-serialized JSON
 * will not match.
 */

export type VerifyFailure =
  | "missing_signature"
  | "malformed_signature"
  | "malformed_timestamp"
  | "timestamp_out_of_tolerance"
  | "bad_signature";

export type VerifyResult = { valid: true } | { valid: false; reason: VerifyFailure };

export interface VerifyOptions {
  /** Maximum clock difference in seconds. Default 300 — replay protection. */
  toleranceSeconds?: number;
  /** Override "now" (unix seconds), for tests. */
  now?: number;
}

function verify(rawBody: string, header: string | null | undefined, key: string, options: VerifyOptions = {}): VerifyResult {
  if (!header) return { valid: false, reason: "missing_signature" };
  const parts = new Map<string, string>();
  for (const piece of header.split(",")) {
    const index = piece.indexOf("=");
    if (index > 0) parts.set(piece.slice(0, index).trim(), piece.slice(index + 1).trim());
  }
  const t = parts.get("t");
  const v1 = parts.get("v1");
  if (!t || !v1) return { valid: false, reason: "malformed_signature" };
  const timestamp = Number(t);
  if (!Number.isFinite(timestamp)) return { valid: false, reason: "malformed_timestamp" };
  const now = options.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > (options.toleranceSeconds ?? 300)) return { valid: false, reason: "timestamp_out_of_tolerance" };

  const expected = createHmac("sha256", key).update(`${timestamp}.${rawBody}`).digest();
  const given = /^[0-9a-f]+$/i.test(v1) ? Buffer.from(v1, "hex") : Buffer.alloc(0);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { valid: false, reason: "bad_signature" };
  return { valid: true };
}

/**
 * Verify an event A-CARD pushed to a merchant's endpoint.
 *
 * Pass the `mwh_…` secret you were given when registering the webhook. A-CARD
 * stores only its SHA-256 digest and signs with that, so this derives the
 * signing key as sha256(secret) for you — verifying with the raw secret
 * directly would always fail.
 */
export function verifyMerchantWebhook(rawBody: string, header: string | null | undefined, secret: string, options?: VerifyOptions): VerifyResult {
  const signingKey = createHash("sha256").update(secret).digest("hex");
  return verify(rawBody, header, signingKey, options);
}

/**
 * Verify an issuer event (`/webhooks/issuer`) — the shared-secret scheme an
 * issuing partner uses, for partners and for anyone proxying issuer traffic.
 */
export function verifyIssuerWebhook(rawBody: string, header: string | null | undefined, secret: string, options?: VerifyOptions): VerifyResult {
  return verify(rawBody, header, secret, options);
}

/** Produce a header in the same format — useful for testing your own handler. */
export function signAcardWebhook(rawBody: string, key: string, timestamp = Math.floor(Date.now() / 1000)): string {
  return `t=${timestamp},v1=${createHmac("sha256", key).update(`${timestamp}.${rawBody}`).digest("hex")}`;
}

/** The event body A-CARD pushes to merchants. */
export interface MerchantEvent<T = Record<string, unknown>> {
  id: string;
  type: "order.placed" | "order.cancelled" | (string & {});
  created_at: string;
  merchant_id: string;
  data: T;
}
