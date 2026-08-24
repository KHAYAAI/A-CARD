import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Stripe integration for USD subscription billing (basic/pro/enterprise —
 * see packages/core/src/billing.ts). Unlike wallet funding (PayFast, ZAR),
 * subscriptions are priced and charged in USD regardless of what currency
 * an account's wallets/cards are denominated in.
 *
 * Uses Stripe's REST API directly (form-encoded, like Paystack's JSON API)
 * rather than the `stripe` npm SDK, to keep this dependency-free the same
 * way paystack.ts and payfast.ts are. Stripe's Checkout Sessions and
 * webhook-signature scheme are long-stable, well-documented APIs (unlike
 * Sudo's), so this is written with the same confidence as paystack.ts, not
 * hedged the way sudo.ts is.
 */

const STRIPE_API = "https://api.stripe.com/v1";

export interface StripeConfig {
  secretKey: string;
  /** From the Stripe dashboard: Developers → Webhooks → your endpoint → Signing secret. */
  webhookSecret: string;
}

export interface StripeCheckoutInput {
  email: string;
  amountUsdCents: number;
  tier: string;
  accountHolderId: string;
  successUrl: string;
  cancelUrl: string;
}

/**
 * The narrow surface app.ts depends on — the real client in production
 * (`createStripeClient`), a fake implementing this interface in tests.
 * Same pattern as `WorkOSClient`/`IssuerCardClient`/`PayFastClient`.
 */
export interface StripeClient {
  createCheckoutSession(input: StripeCheckoutInput): Promise<{ checkoutUrl: string; sessionId: string }>;
  verifyWebhookSignature(rawBody: string, signatureHeader: string | undefined | null): boolean;
}

class RealStripeClient implements StripeClient {
  constructor(private readonly config: StripeConfig) {}

  /**
   * Inline `price_data` (no pre-created Stripe Price object needed) so the
   * amount can come straight from SUBSCRIPTION_TIERS — same reasoning
   * Paystack's `initializeTransaction` used for a dynamic amount.
   */
  async createCheckoutSession(input: StripeCheckoutInput): Promise<{ checkoutUrl: string; sessionId: string }> {
    const body = new URLSearchParams();
    body.set("mode", "subscription");
    body.set("customer_email", input.email);
    body.set("success_url", input.successUrl);
    body.set("cancel_url", input.cancelUrl);
    body.set("client_reference_id", input.accountHolderId);
    body.set("line_items[0][quantity]", "1");
    body.set("line_items[0][price_data][currency]", "usd");
    body.set("line_items[0][price_data][unit_amount]", String(input.amountUsdCents));
    body.set("line_items[0][price_data][recurring][interval]", "month");
    body.set("line_items[0][price_data][product_data][name]", `A-CARD ${input.tier} plan`);
    body.set("metadata[accountHolderId]", input.accountHolderId);
    body.set("metadata[tier]", input.tier);

    const response = await fetch(`${STRIPE_API}/checkout/sessions`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.config.secretKey}`, "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    const parsed = (await response.json()) as { id?: string; url?: string; error?: { message: string } };
    if (!response.ok || !parsed.url || !parsed.id) {
      throw new Error(`Stripe checkout session failed: ${parsed.error?.message ?? response.statusText}`);
    }
    return { checkoutUrl: parsed.url, sessionId: parsed.id };
  }

  /**
   * Stripe's documented scheme: header is `t=<unix ts>,v1=<hex hmac-sha256
   * of "ts.rawBody">` (v0 is deprecated, ignored here). A 5-minute
   * timestamp tolerance guards against a replayed, otherwise-valid payload.
   */
  verifyWebhookSignature(rawBody: string, signatureHeader: string | undefined | null): boolean {
    if (!signatureHeader) return false;
    const parts: Record<string, string> = {};
    for (const kv of signatureHeader.split(",")) {
      const [k, v] = kv.split("=");
      if (k && v) parts[k] = v;
    }
    const timestamp = parts.t;
    const v1 = parts.v1;
    if (!timestamp || !v1) return false;
    if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;

    const expected = createHmac("sha256", this.config.webhookSecret).update(`${timestamp}.${rawBody}`).digest("hex");
    const expectedBuf = Buffer.from(expected, "hex");
    let providedBuf: Buffer;
    try {
      providedBuf = Buffer.from(v1, "hex");
    } catch {
      return false;
    }
    if (providedBuf.length !== expectedBuf.length) return false;
    return timingSafeEqual(providedBuf, expectedBuf);
  }
}

export function createStripeClient(config: StripeConfig): StripeClient {
  return new RealStripeClient(config);
}
