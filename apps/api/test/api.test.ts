import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Platform, signWebhook } from "@acard/core";
import { createApp } from "../src/app.js";

const SECRET = "whsec_test";

let app: ReturnType<typeof createApp>;
let apiKey: string;

async function json(res: Response) {
  return (await res.json()) as any;
}

function authed(path: string, init: RequestInit = {}) {
  return app.request(path, {
    ...init,
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

beforeEach(async () => {
  app = createApp({ platform: new Platform(), issuerWebhookSecret: SECRET });
  const res = await app.request("/v1/signup", {
    method: "POST",
    body: JSON.stringify({ email: "dev@example.co.za", name: "Dev", currency: "ZAR" }),
    headers: { "content-type": "application/json" },
  });
  expect(res.status).toBe(201);
  apiKey = (await json(res)).api_key;
});

describe("API end to end", () => {
  it("rejects requests without a valid API key", async () => {
    const res = await app.request("/v1/wallet");
    expect(res.status).toBe(401);
  });

  it("funds wallet, creates a card, and completes a simulated purchase", async () => {
    let res = await authed("/v1/wallet/fund", { method: "POST", body: JSON.stringify({ amount: 50_000 }) });
    expect(res.status).toBe(201);

    res = await authed("/v1/cards", {
      method: "POST",
      body: JSON.stringify({ label: "agent groceries", single_use: true }),
    });
    expect(res.status).toBe(201);
    const { card } = await json(res);
    expect(card.sandboxPan.startsWith("4242")).toBe(true);

    res = await authed("/v1/simulate/purchase", {
      method: "POST",
      body: JSON.stringify({
        card_id: card.id,
        amount: 12_000,
        currency: "ZAR",
        merchant: { name: "Checkers Sixty60", category: "5411" },
      }),
    });
    const purchase = await json(res);
    expect(purchase.approved).toBe(true);
    expect(purchase.wallet.posted).toBe(38_000);

    // Single-use card auto-closed after capture.
    res = await authed(`/v1/cards/${card.id}`);
    expect((await json(res)).card.status).toBe("closed");

    res = await authed("/v1/transactions");
    const { transactions } = await json(res);
    expect(transactions).toHaveLength(1);
    expect(transactions[0].status).toBe("completed");
  });

  it("declines purchases beyond wallet balance", async () => {
    await authed("/v1/wallet/fund", { method: "POST", body: JSON.stringify({ amount: 1_000 }) });
    const { card } = await json(
      await authed("/v1/cards", { method: "POST", body: JSON.stringify({ single_use: false }) }),
    );
    const purchase = await json(
      await authed("/v1/simulate/purchase", {
        method: "POST",
        body: JSON.stringify({ card_id: card.id, amount: 5_000, merchant: { name: "M", category: "5999" } }),
      }),
    );
    expect(purchase.approved).toBe(false);
    expect(purchase.decline_reason).toBe("insufficient_funds");
  });

  it("routes above-threshold purchases to human approval and honors the decision", async () => {
    await authed("/v1/wallet/fund", { method: "POST", body: JSON.stringify({ amount: 100_000 }) });
    const { card } = await json(
      await authed("/v1/cards", {
        method: "POST",
        body: JSON.stringify({ single_use: false, approval_threshold: 10_000 }),
      }),
    );

    const first = await json(
      await authed("/v1/simulate/purchase", {
        method: "POST",
        body: JSON.stringify({ card_id: card.id, amount: 25_000, merchant: { name: "FlySafair", category: "4511" } }),
      }),
    );
    expect(first.approved).toBe(false);
    expect(first.approval_id).toBeDefined();

    const pending = await json(await authed("/v1/approvals?status=pending"));
    expect(pending.approvals).toHaveLength(1);

    await authed(`/v1/approvals/${first.approval_id}/approve`, { method: "POST" });

    const retry = await json(
      await authed("/v1/simulate/purchase", {
        method: "POST",
        body: JSON.stringify({ card_id: card.id, amount: 25_000, merchant: { name: "FlySafair", category: "4511" } }),
      }),
    );
    expect(retry.approved).toBe(true);
  });

  it("enforces idempotency keys on card creation", async () => {
    const body = JSON.stringify({ label: "same" });
    const first = await authed("/v1/cards", { method: "POST", body, headers: { "idempotency-key": "k1" } });
    const second = await authed("/v1/cards", { method: "POST", body, headers: { "idempotency-key": "k1" } });
    const a = await json(first);
    const b = await json(second);
    expect(b.card.id).toBe(a.card.id);

    const conflict = await authed("/v1/cards", {
      method: "POST",
      body: JSON.stringify({ label: "different" }),
      headers: { "idempotency-key": "k1" },
    });
    expect(conflict.status).toBe(409);
  });

  it("rejects unsigned or badly signed issuer webhooks", async () => {
    const body = JSON.stringify({ id: "evt_x", type: "authorization.request", data: {} });
    let res = await app.request("/webhooks/issuer", { method: "POST", body });
    expect(res.status).toBe(401);
    res = await app.request("/webhooks/issuer", {
      method: "POST",
      body,
      headers: { "x-acard-signature": signWebhook(body, "wrong_secret") },
    });
    expect(res.status).toBe(401);
  });

  it("prevents cross-tenant card access", async () => {
    const other = await json(
      await app.request("/v1/signup", {
        method: "POST",
        body: JSON.stringify({ email: "other@example.com", name: "Other" }),
        headers: { "content-type": "application/json" },
      }),
    );
    const { card } = await json(
      await authed("/v1/cards", { method: "POST", body: JSON.stringify({}) }),
    );
    const res = await app.request(`/v1/cards/${card.id}`, {
      headers: { authorization: `Bearer ${other.api_key}` },
    });
    expect(res.status).toBe(404);
  });

  it("enforces the free plan's monthly card cap", async () => {
    for (let i = 0; i < 5; i++) {
      const res = await authed("/v1/cards", { method: "POST", body: JSON.stringify({ label: `c${i}` }) });
      expect(res.status).toBe(201);
    }
    const res = await authed("/v1/cards", { method: "POST", body: JSON.stringify({ label: "over cap" }) });
    expect(res.status).toBe(402);
    expect((await json(res)).error.code).toBe("plan_limit_exceeded");
  });
});

describe("Paystack billing", () => {
  const paystackSecret = "sk_test_123";
  const webhookSecret = "whsec_paystack_test";
  let billingApp: ReturnType<typeof createApp>;
  let billingKey: string;
  let billingHolderId: string;

  beforeEach(async () => {
    billingApp = createApp({
      platform: new Platform(),
      issuerWebhookSecret: SECRET,
      paystack: { secretKey: paystackSecret, webhookSecret },
    });
    const res = await billingApp.request("/v1/signup", {
      method: "POST",
      body: JSON.stringify({ email: "billing@example.co.za", name: "Billing" }),
      headers: { "content-type": "application/json" },
    });
    const body = await json(res);
    billingKey = body.api_key;
    billingHolderId = body.account_holder.id;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("starts a Paystack checkout for a paid tier", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            status: true,
            message: "ok",
            data: { authorization_url: "https://checkout.paystack.com/abc", access_code: "abc", reference: "ref_1" },
          }),
        ),
      ),
    );

    const res = await billingApp.request("/v1/billing/checkout", {
      method: "POST",
      body: JSON.stringify({ tier: "basic" }),
      headers: { authorization: `Bearer ${billingKey}`, "content-type": "application/json" },
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.checkout_url).toBe("https://checkout.paystack.com/abc");
  });

  it("upgrades the account tier on a verified charge.success webhook", async () => {
    const payload = JSON.stringify({
      event: "charge.success",
      id: "evt_1",
      data: { reference: "ref_1", metadata: { accountHolderId: billingHolderId, tier: "pro" } },
    });
    const signature = createHmac("sha512", webhookSecret).update(payload).digest("hex");

    const res = await billingApp.request("/webhooks/paystack", {
      method: "POST",
      body: payload,
      headers: { "x-paystack-signature": signature },
    });
    expect(res.status).toBe(200);

    // Confirm the upgrade actually raised the plan limit (pro = 100 cards/month).
    for (let i = 0; i < 6; i++) {
      const cardRes = await billingApp.request("/v1/cards", {
        method: "POST",
        body: JSON.stringify({}),
        headers: { authorization: `Bearer ${billingKey}`, "content-type": "application/json" },
      });
      expect(cardRes.status).toBe(201);
    }
  });

  it("rejects a Paystack webhook with a bad signature", async () => {
    const payload = JSON.stringify({ event: "charge.success", data: {} });
    const res = await billingApp.request("/webhooks/paystack", {
      method: "POST",
      body: payload,
      headers: { "x-paystack-signature": "not-a-real-signature" },
    });
    expect(res.status).toBe(401);
  });
});
