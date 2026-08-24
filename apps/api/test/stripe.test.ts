import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStripeClient } from "../src/stripe.js";

/**
 * The Stripe client directly — signature verification (timestamp tolerance,
 * tampering, malformed header) and checkout session creation — separate
 * from api.test.ts's "Stripe billing" describe block, which exercises the
 * HTTP routes end to end.
 */
const CONFIG = { secretKey: "sk_test_123", webhookSecret: "whsec_test" };

function sign(payload: string, secret: string, timestamp = Math.floor(Date.now() / 1000)) {
  const v1 = createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest("hex");
  return { header: `t=${timestamp},v1=${v1}`, timestamp };
}

describe("Stripe webhook signature", () => {
  const client = createStripeClient(CONFIG);

  it("accepts a correctly signed, fresh payload", () => {
    const payload = JSON.stringify({ id: "evt_1" });
    const { header } = sign(payload, CONFIG.webhookSecret);
    expect(client.verifyWebhookSignature(payload, header)).toBe(true);
  });

  it("rejects a tampered payload", () => {
    const payload = JSON.stringify({ id: "evt_1" });
    const { header } = sign(payload, CONFIG.webhookSecret);
    expect(client.verifyWebhookSignature(JSON.stringify({ id: "evt_2" }), header)).toBe(false);
  });

  it("rejects the wrong secret", () => {
    const payload = JSON.stringify({ id: "evt_1" });
    const { header } = sign(payload, "whsec_wrong");
    expect(client.verifyWebhookSignature(payload, header)).toBe(false);
  });

  it("rejects a stale timestamp (replay guard)", () => {
    const payload = JSON.stringify({ id: "evt_1" });
    const staleTimestamp = Math.floor(Date.now() / 1000) - 3600; // an hour old
    const { header } = sign(payload, CONFIG.webhookSecret, staleTimestamp);
    expect(client.verifyWebhookSignature(payload, header)).toBe(false);
  });

  it("rejects a missing or malformed header", () => {
    const payload = JSON.stringify({ id: "evt_1" });
    expect(client.verifyWebhookSignature(payload, undefined)).toBe(false);
    expect(client.verifyWebhookSignature(payload, "not-a-real-header")).toBe(false);
    expect(client.verifyWebhookSignature(payload, "t=123")).toBe(false); // no v1
  });
});

describe("Stripe checkout session", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("builds a subscription-mode session with the plan's USD amount, and surfaces the checkout URL", async () => {
    let captured: URLSearchParams | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        captured = new URLSearchParams(init.body as string);
        return new Response(JSON.stringify({ id: "cs_test_1", url: "https://checkout.stripe.com/c/pay/cs_test_1" }));
      }),
    );
    const client = createStripeClient(CONFIG);
    const result = await client.createCheckoutSession({
      email: "dev@acard.co.za",
      amountUsdCents: 2_800,
      tier: "pro",
      accountHolderId: "ah_1",
      successUrl: "https://app.example.com/billing?upgraded=1",
      cancelUrl: "https://app.example.com/billing?upgraded=0",
    });
    expect(result.checkoutUrl).toBe("https://checkout.stripe.com/c/pay/cs_test_1");
    expect(result.sessionId).toBe("cs_test_1");
    expect(captured?.get("mode")).toBe("subscription");
    expect(captured?.get("line_items[0][price_data][unit_amount]")).toBe("2800");
    expect(captured?.get("line_items[0][price_data][currency]")).toBe("usd");
    expect(captured?.get("line_items[0][price_data][recurring][interval]")).toBe("month");
    expect(captured?.get("metadata[accountHolderId]")).toBe("ah_1");
    expect(captured?.get("metadata[tier]")).toBe("pro");
  });

  it("throws with Stripe's own error message on a failed session creation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: { message: "Invalid API Key provided" } }), { status: 401 })),
    );
    const client = createStripeClient(CONFIG);
    await expect(
      client.createCheckoutSession({
        email: "dev@acard.co.za",
        amountUsdCents: 800,
        tier: "basic",
        accountHolderId: "ah_1",
        successUrl: "https://x/y",
        cancelUrl: "https://x/y",
      }),
    ).rejects.toThrow(/Invalid API Key provided/);
  });
});
