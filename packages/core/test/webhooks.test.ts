import { describe, expect, it } from "vitest";
import { signWebhook, verifyWebhook } from "../src/webhooks.js";

const secret = "whsec_test_123";

describe("webhook signatures", () => {
  it("round-trips a valid signature", () => {
    const body = JSON.stringify({ id: "evt_1", type: "authorization.request" });
    const header = signWebhook(body, secret);
    expect(verifyWebhook(body, header, secret).valid).toBe(true);
  });

  it("rejects a tampered body", () => {
    const body = JSON.stringify({ amount: 100 });
    const header = signWebhook(body, secret);
    const result = verifyWebhook(JSON.stringify({ amount: 100_000 }), header, secret);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("bad_signature");
  });

  it("rejects the wrong secret", () => {
    const body = "{}";
    const header = signWebhook(body, secret);
    expect(verifyWebhook(body, header, "whsec_other").valid).toBe(false);
  });

  it("rejects stale timestamps (replay protection)", () => {
    const body = "{}";
    const past = Math.floor(Date.now() / 1000) - 3600;
    const header = signWebhook(body, secret, past);
    const result = verifyWebhook(body, header, secret);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("timestamp_out_of_tolerance");
  });

  it("rejects missing/malformed headers", () => {
    expect(verifyWebhook("{}", undefined, secret).valid).toBe(false);
    expect(verifyWebhook("{}", "nonsense", secret).valid).toBe(false);
    expect(verifyWebhook("{}", "t=abc,v1=00", secret).valid).toBe(false);
  });
});
