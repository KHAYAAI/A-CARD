import { afterEach, describe, expect, it } from "vitest";
import { Platform } from "@acard/core";
import { createApp } from "../src/app.js";

/**
 * The middleware is built once, when createApp() runs, from
 * process.env.ACARD_REQUIRE_HTTPS at that moment — so each case sets it,
 * builds a fresh app, and restores it. This exercises the actual
 * request-level check (X-Forwarded-Proto), not just the session cookie's
 * Secure flag, which only constrains the browser and doesn't protect a
 * Bearer API key.
 *
 * Deliberately NOT keyed on NODE_ENV: the CDK stack's documented plain-HTTP
 * :80 deployment path (no domain configured) still runs with
 * NODE_ENV=production, and its own ALB forwards `x-forwarded-proto: http`
 * on every request — gating on NODE_ENV alone would make that path reject
 * all of its own traffic. CDK only sets ACARD_REQUIRE_HTTPS=true when a
 * domain/certificate is actually configured — see acard-stack.ts.
 */
const SECRET = "whsec_test";
const ORIGINAL = process.env.ACARD_REQUIRE_HTTPS;

afterEach(() => {
  process.env.ACARD_REQUIRE_HTTPS = ORIGINAL;
});

describe("HTTPS enforcement on /v1/*", () => {
  it("when required, refuses a request forwarded as plain HTTP", async () => {
    process.env.ACARD_REQUIRE_HTTPS = "true";
    const app = createApp({ platform: new Platform(), issuerWebhookSecret: SECRET });
    const res = await app.request("/v1/wallet", { headers: { "x-forwarded-proto": "http" } });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("https_required");
  });

  it("when required, allows a request forwarded as HTTPS through to normal auth handling", async () => {
    process.env.ACARD_REQUIRE_HTTPS = "true";
    const app = createApp({ platform: new Platform(), issuerWebhookSecret: SECRET });
    const res = await app.request("/v1/wallet", { headers: { "x-forwarded-proto": "https" } });
    // No HTTPS block; falls through to the real auth guard, which refuses for lack of a key — not 400 https_required.
    expect(res.status).toBe(401);
  });

  it("when required, allows a request with no proto header at all (e.g. no proxy in front)", async () => {
    process.env.ACARD_REQUIRE_HTTPS = "true";
    const app = createApp({ platform: new Platform(), issuerWebhookSecret: SECRET });
    const res = await app.request("/v1/wallet");
    expect(res.status).toBe(401); // reaches the auth guard, not blocked by the HTTPS check
  });

  it("when not required (e.g. the plain-HTTP :80 deployment path, or local dev), plain HTTP is not blocked", async () => {
    process.env.ACARD_REQUIRE_HTTPS = "false";
    const app = createApp({ platform: new Platform(), issuerWebhookSecret: SECRET });
    const res = await app.request("/v1/wallet", { headers: { "x-forwarded-proto": "http" } });
    expect(res.status).toBe(401); // reaches the auth guard normally
  });

  it("unset (default) behaves the same as not required — plain HTTP still reaches the auth guard", async () => {
    delete process.env.ACARD_REQUIRE_HTTPS;
    const app = createApp({ platform: new Platform(), issuerWebhookSecret: SECRET });
    const res = await app.request("/v1/wallet", { headers: { "x-forwarded-proto": "http" } });
    expect(res.status).toBe(401);
  });

  it("never blocks /health, even when required, over plain HTTP — the ALB target-group check needs this", async () => {
    process.env.ACARD_REQUIRE_HTTPS = "true";
    const app = createApp({ platform: new Platform(), issuerWebhookSecret: SECRET });
    const res = await app.request("/health", { headers: { "x-forwarded-proto": "http" } });
    expect(res.status).toBe(200);
  });
});
