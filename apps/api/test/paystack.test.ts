import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PaystackClient, subscriptionReference } from "../src/paystack.js";

const webhookSecret = "sk_test_webhook_secret";
const client = new PaystackClient({ secretKey: "sk_test_x", webhookSecret });

describe("Paystack webhook signature", () => {
  it("accepts a correctly signed payload", () => {
    const body = JSON.stringify({ event: "charge.success", data: { reference: "ref_1" } });
    const signature = createHmac("sha512", webhookSecret).update(body).digest("hex");
    expect(client.verifyWebhookSignature(body, signature)).toBe(true);
  });

  it("rejects a tampered payload", () => {
    const body = JSON.stringify({ event: "charge.success", data: { reference: "ref_1" } });
    const signature = createHmac("sha512", webhookSecret).update(body).digest("hex");
    expect(client.verifyWebhookSignature(JSON.stringify({ event: "charge.success", data: { reference: "ref_2" } }), signature)).toBe(
      false,
    );
  });

  it("rejects a missing signature", () => {
    expect(client.verifyWebhookSignature("{}", undefined)).toBe(false);
  });
});

describe("subscriptionReference", () => {
  it("is deterministic per account holder and billing period", () => {
    const a = subscriptionReference("ah_1", "2026-07");
    const b = subscriptionReference("ah_1", "2026-07");
    const c = subscriptionReference("ah_1", "2026-08");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});
