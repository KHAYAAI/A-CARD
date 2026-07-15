import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * Paystack integration for ZAR subscription billing. Paystack (Stripe-owned)
 * is the cleanest developer API for South African collections and supports
 * recurring billing natively via "plans" + "subscriptions" — see
 * https://paystack.com/docs/payments/subscriptions/.
 *
 * This client covers the two calls the platform actually needs at launch:
 * starting a checkout for a plan, and verifying the webhook Paystack sends
 * back on payment/subscription events. It intentionally does not build a
 * full metering/usage-billing system (that's Lago's job, deferred) — this
 * is just "collect a monthly ZAR subscription fee reliably."
 */

const PAYSTACK_API = "https://api.paystack.co";

export interface PaystackConfig {
  secretKey: string;
  /** From the Paystack dashboard: Settings → API Keys & Webhooks → Webhook signature. */
  webhookSecret: string;
}

export class PaystackClient {
  constructor(private readonly config: PaystackConfig) {}

  /** Initialize a transaction for a subscription plan; returns the checkout URL to redirect the customer to. */
  async initializeTransaction(input: {
    email: string;
    amountMinorUnits: number;
    planCode?: string;
    reference: string;
    callbackUrl?: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ authorizationUrl: string; accessCode: string; reference: string }> {
    const response = await fetch(`${PAYSTACK_API}/transaction/initialize`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.config.secretKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        email: input.email,
        amount: input.amountMinorUnits,
        currency: "ZAR",
        reference: input.reference,
        plan: input.planCode,
        callback_url: input.callbackUrl,
        metadata: input.metadata,
      }),
    });
    const body = (await response.json()) as {
      status: boolean;
      message: string;
      data?: { authorization_url: string; access_code: string; reference: string };
    };
    if (!response.ok || !body.status || !body.data) {
      throw new Error(`Paystack initialize failed: ${body.message ?? response.statusText}`);
    }
    return {
      authorizationUrl: body.data.authorization_url,
      accessCode: body.data.access_code,
      reference: body.data.reference,
    };
  }

  /** Server-side verification (poll fallback for when a webhook is missed). */
  async verifyTransaction(reference: string): Promise<{ status: string; amount: number; currency: string }> {
    const response = await fetch(`${PAYSTACK_API}/transaction/verify/${encodeURIComponent(reference)}`, {
      headers: { authorization: `Bearer ${this.config.secretKey}` },
    });
    const body = (await response.json()) as { data: { status: string; amount: number; currency: string } };
    return body.data;
  }

  /** HMAC-SHA512 over the raw request body, per Paystack's webhook signing scheme. */
  verifyWebhookSignature(rawBody: string, signatureHeader: string | undefined | null): boolean {
    if (!signatureHeader) return false;
    const expected = createHmac("sha512", this.config.webhookSecret).update(rawBody).digest("hex");
    const expectedBuf = Buffer.from(expected, "hex");
    let providedBuf: Buffer;
    try {
      providedBuf = Buffer.from(signatureHeader, "hex");
    } catch {
      return false;
    }
    if (providedBuf.length !== expectedBuf.length) return false;
    return timingSafeEqual(providedBuf, expectedBuf);
  }
}

/** Deterministic reference so a retried checkout for the same billing period is idempotent. */
export function subscriptionReference(accountHolderId: string, period: string): string {
  return createHash("sha256").update(`${accountHolderId}:${period}`).digest("hex").slice(0, 24);
}

export type SubscriptionTier = "free" | "basic" | "pro";

export const SUBSCRIPTION_TIERS: Record<SubscriptionTier, { cardsPerMonth: number; priceZarCents: number }> = {
  free: { cardsPerMonth: 5, priceZarCents: 0 },
  basic: { cardsPerMonth: 25, priceZarCents: 14_900 }, // R149/mo
  pro: { cardsPerMonth: 100, priceZarCents: 49_900 }, // R499/mo
};
