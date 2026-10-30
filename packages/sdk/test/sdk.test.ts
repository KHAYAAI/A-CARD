import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serve } from "@hono/node-server";
import { Platform } from "@acard/core";
import { createApp } from "../../../apps/api/src/app.js";
import { InMemoryMerchantAuth, InMemoryMerchantDirectory } from "../../../apps/api/src/merchant/index.js";
import {
  Acard,
  AcardError,
  AcardMerchant,
  isAwaitingApproval,
  verifyIssuerWebhook,
  verifyMerchantWebhook,
  type MerchantEvent,
  type Order,
} from "../src/index.js";

/**
 * The SDK against a real API over real HTTP: a Hono server on an ephemeral
 * port, the in-memory platform behind it, and — for webhooks — a real HTTP
 * endpoint standing in for a merchant's POS. No fetch is mocked except where
 * a test deliberately simulates a dropped connection.
 */

let api: ReturnType<typeof serve>;
let baseUrl: string;
let platform: Platform;
let acard: Acard;
let apiKey: string;

beforeAll(async () => {
  platform = new Platform();
  const app = createApp({
    platform,
    issuerWebhookSecret: "whsec_sdk_test",
    merchants: new InMemoryMerchantDirectory(platform.merchants),
    merchantAuth: new InMemoryMerchantAuth(platform.merchantAuth),
  });
  await new Promise<void>((resolve) => {
    api = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info) => {
      baseUrl = `http://127.0.0.1:${info.port}`;
      resolve();
    });
  });
  const signup = await Acard.signup({ email: "sdk@khaya.example", name: "Khaya Logistics", currency: "ZAR" }, { baseUrl });
  expect(signup.api_key.startsWith("ak_")).toBe(true);
  apiKey = signup.api_key;
  acard = new Acard({ apiKey, baseUrl });
  await acard.wallet.fund(50_000_000);
});

afterAll(() => {
  api?.close();
});

describe("cards, purchases and declines", () => {
  it("issues a scoped card and authorizes a purchase inside its limits", async () => {
    const card = await acard.cards.create({
      label: "fleet-agent-07",
      single_use: false,
      limits: { per_transaction: 500_000, total: 4_000_000 },
      allowed_merchant_categories: ["5541", "5542", "7538"],
    });
    expect(card.status).toBe("active");
    expect(card.sandboxPan).toBeDefined();

    const result = await acard.sandbox.purchase({ card_id: card.id, amount: 185_000, merchant: { name: "Highveld Tyre & Fuel", category: "5541" } });
    expect(result.approved).toBe(true);
    expect(result.wallet.currency).toBe("ZAR");

    // A decline is a result, not an exception.
    const tv = await acard.sandbox.purchase({ card_id: card.id, amount: 90_000, merchant: { name: "Game Electronics", category: "5732" } });
    expect(tv.approved).toBe(false);
    expect(tv.decline_reason).toBe("merchant_category_not_allowed");

    const big = await acard.sandbox.purchase({ card_id: card.id, amount: 600_000, merchant: { name: "Highveld Tyre & Fuel", category: "5541" } });
    expect(big.decline_reason).toBe("per_transaction_limit_exceeded");

    const history = await acard.transactions.list({ cardId: card.id });
    expect(history.map((t) => t.declineReason).filter(Boolean)).toEqual(
      expect.arrayContaining(["merchant_category_not_allowed", "per_transaction_limit_exceeded"]),
    );
    expect((await acard.cards.get(card.id)).id).toBe(card.id);
    expect((await acard.cards.list()).some((c) => c.id === card.id)).toBe(true);
    expect((await acard.cards.close(card.id)).status).toBe("closed");
  });

  it("holds a charge for a human, waits for the decision, and the grant is spent once", async () => {
    const card = await acard.cards.create({ label: "procurement-bot-03", single_use: false, approval_threshold: 800_000 });
    const purchase = { card_id: card.id, amount: 1_840_000, merchant: { name: "Rand Build Supply", category: "5211" } };

    const held = await acard.sandbox.purchase(purchase);
    expect(isAwaitingApproval(held)).toBe(true);
    const approvalId = held.approval_id!;

    // A human approves while the agent is waiting.
    setTimeout(() => void acard.approvals.approve(approvalId), 150);
    const decided = await acard.approvals.waitForDecision(approvalId, { intervalMs: 50, timeoutMs: 5_000 });
    expect(decided.status).toBe("approved");

    const retried = await acard.sandbox.purchase(purchase);
    expect(retried.approved).toBe(true);

    // The grant was consumed: the same charge again is held again.
    const again = await acard.sandbox.purchase(purchase);
    expect(isAwaitingApproval(again)).toBe(true);
  });
});

describe("errors", () => {
  it("raises AcardError with the stable code, status and validation issues", async () => {
    const missing = await acard.cards.get("card_does_not_exist").catch((e) => e);
    expect(missing).toBeInstanceOf(AcardError);
    expect(missing.status).toBe(404);
    expect(missing.code).toBe("not_found");
    expect(missing.retryable).toBe(false);

    const invalid = await acard.cards.create({ limits: { total: -1 } }).catch((e) => e);
    expect(invalid.code).toBe("invalid_request");
    expect(invalid.issues.length).toBeGreaterThan(0);

    const unauthenticated = await new Acard({ apiKey: "ak_live_not_a_key", baseUrl }).cards.list().catch((e) => e);
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.code).toBe("unauthorized");
  });
});

describe("idempotency and retries", () => {
  it("an explicit key replays the original result instead of creating twice", async () => {
    const a = await acard.cards.create({ label: "same-op" }, { idempotencyKey: "op-card-1" });
    const b = await acard.cards.create({ label: "same-op" }, { idempotencyKey: "op-card-1" });
    expect(b.id).toBe(a.id);
    const conflict = await acard.cards.create({ label: "different" }, { idempotencyKey: "op-card-1" }).catch((e) => e);
    expect(conflict.code).toBe("idempotency_conflict");
  });

  it("an automatic retry after a dropped response never creates a second card", async () => {
    const before = (await acard.cards.list()).length;
    let dropped = false;
    // The request reaches the server and succeeds, but the response is "lost"
    // on the way back, as when a connection resets. The SDK must retry with
    // the same idempotency key and get the original card.
    const flaky: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      if (!dropped && init?.method === "POST") {
        dropped = true;
        throw new TypeError("socket hang up");
      }
      return response;
    };
    const client = new Acard({ apiKey: apiKey, baseUrl, fetch: flaky });
    const card = await client.cards.create({ label: "after-reset" });
    expect(dropped).toBe(true);
    const after = await acard.cards.list();
    expect(after.length).toBe(before + 1);
    expect(after.filter((c) => c.label === "after-reset").map((c) => c.id)).toEqual([card.id]);
  });
});

describe("A-MERCHANT: search, order, and the merchant's own integration", () => {
  let pos: Server;
  let posUrl: string;
  const received: Array<{ body: string; signature: string | undefined; event: string | undefined }> = [];

  beforeAll(async () => {
    pos = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        received.push({ body, signature: req.headers["x-acard-signature"] as string, event: req.headers["x-acard-event"] as string });
        res.writeHead(200).end("ok");
      });
    });
    await new Promise<void>((resolve) => pos.listen(0, "127.0.0.1", resolve));
    posUrl = `http://127.0.0.1:${(pos.address() as AddressInfo).port}/acard`;
  });

  afterAll(() => pos?.close());

  it("finds verified supply, places an order, and the POS receives a webhook it can verify", async () => {
    // Operator onboarding (admin) through the API.
    const register = await fetch(`${baseUrl}/v1/merchants`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        name: "Rand Build Supply",
        merchant_category_code: "5211",
        address: { addressLine: "12 Old Pretoria Rd", city: "Midrand", province: "Gauteng", country: "ZA", lat: -25.99, lng: 28.13 },
        service_radius_km: 40,
        kyb: { registration_number: "2015/123456/07", contact_email: "orders@randbuild.example" },
      }),
    });
    const merchantId = ((await register.json()) as any).merchant.id as string;
    await fetch(`${baseUrl}/v1/merchants/${merchantId}/kyb`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ status: "verified" }),
    });

    // The merchant's own POS integration, with its own machine key.
    const { secret: merchantKey } = platform.merchantAuth.createApiKey(merchantId, { name: "Till 1", scope: "read_write", createdBy: "owner@randbuild.example" });
    const shop = new AcardMerchant({ apiKey: merchantKey, baseUrl });
    await shop.catalog.sync([
      { sku: "CEM-425-50", name: "Cement 42.5N 50kg", unit: "bag", unit_price_cents: 11_500, availability: "in_stock", quantity_available: 900, lead_time_days: 1 },
    ]);
    await shop.catalog.restate([{ sku: "CEM-425-50", availability: "in_stock", quantity_available: 850 }]);
    const { secret: webhookSecret } = await shop.webhook.set(posUrl);
    expect(webhookSecret.startsWith("mwh_")).toBe(true);

    // The agent searches and orders.
    const search = await acard.merchants.search({ q: "cement", quantity: 500, lat: -26.2041, lng: 28.0473, radius_km: 40 });
    expect(search.offers).toHaveLength(1);
    const offer = search.offers[0]!;
    expect(offer.freshness).toBe("fresh");
    expect(offer.totalCents).toBe(500 * 11_500);

    const order = await acard.merchants.placeOrder(offer.merchant.id, {
      lines: [{ item_id: offer.item.id, quantity: 500 }],
      fulfilment: { method: "delivery", address: "Khaya Logistics, Germiston" },
    });
    expect(order.status).toBe("placed");

    // The push is fire-and-forget on the server; give it a moment to land.
    for (let i = 0; i < 50 && received.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    expect(received).toHaveLength(1);
    const delivery = received[0]!;
    expect(delivery.event).toBe("order.placed");

    // The contract docs/reference/webhooks.md promises: verify with the secret you were given.
    expect(verifyMerchantWebhook(delivery.body, delivery.signature, webhookSecret)).toEqual({ valid: true });
    // ...and verifying with the raw secret as if it were the key does NOT work.
    expect(verifyIssuerWebhook(delivery.body, delivery.signature, webhookSecret)).toEqual({ valid: false, reason: "bad_signature" });
    expect(verifyMerchantWebhook(delivery.body.replace("placed", "PLACED"), delivery.signature, webhookSecret).valid).toBe(false);

    const event = JSON.parse(delivery.body) as MerchantEvent<{ order: Order }>;
    expect(event.data.order.id).toBe(order.id);

    // The merchant moves it forward; the buyer sees it.
    const accepted = await shop.orders.advance(order.id, { status: "accepted", promised_at: "2026-11-01T10:00:00Z" });
    expect(accepted.status).toBe("accepted");
    expect((await acard.orders.get(order.id)).status).toBe("accepted");
    expect((await shop.orders.list({ status: "accepted" })).map((o) => o.id)).toContain(order.id);
  });
});

describe("x402", () => {
  it("pays for a resource over x402 through a card, and reports the card's tab", async () => {
    const { AfpLedger } = await import("@acard/core");
    const { InMemoryAfpLedger } = await import("../../../apps/api/src/afp/index.js");
    const { InMemoryPlatformService } = await import("../../../apps/api/src/service/index.js");
    const { createX402Payer, SANDBOX_SIGNER, USDC_BY_NETWORK } = await import("../../../apps/api/src/x402/index.js");

    // A v2 x402 server: 402 with PAYMENT-REQUIRED, then 200 with PAYMENT-RESPONSE.
    const requirement = {
      scheme: "exact",
      network: "eip155:84532",
      amount: "2500",
      asset: USDC_BY_NETWORK["eip155:84532"]!.address,
      payTo: "0x1111111111111111111111111111111111111111",
      maxTimeoutSeconds: 60,
    };
    const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64");
    const resource: Server = createServer((req, res) => {
      if (!req.headers["payment-signature"]) {
        res.writeHead(402, { "payment-required": b64({ x402Version: 2, accepts: [requirement] }) });
        return res.end("{}");
      }
      res.writeHead(200, { "content-type": "application/json", "payment-response": b64({ success: true, transaction: "0xfeed", network: requirement.network }) });
      res.end(JSON.stringify({ answer: 42 }));
    });
    await new Promise<void>((r) => resource.listen(0, "127.0.0.1", r));
    const resourceUrl = `http://127.0.0.1:${(resource.address() as AddressInfo).port}/answer`;

    const x402Platform = new Platform();
    const service = new InMemoryPlatformService(x402Platform);
    const ledger = new InMemoryAfpLedger(new AfpLedger());
    const x402Config = { signer: SANDBOX_SIGNER, payerAddress: "0x2222222222222222222222222222222222222222", networks: ["eip155:84532"], allowPrivateNetworks: true };
    const app = createApp({ platform: service, issuerWebhookSecret: "whsec_sdk_x402", afp: { ledger, rails: [], x402: createX402Payer(service, ledger, x402Config) } });
    let server!: ReturnType<typeof serve>;
    const url = await new Promise<string>((resolve) => {
      server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info) => resolve(`http://127.0.0.1:${info.port}`));
    });
    try {
      const { api_key } = await Acard.signup({ email: "x402@sdk.example", name: "x402 SDK", currency: "USD" }, { baseUrl: url });
      const client = new Acard({ apiKey: api_key, baseUrl: url });
      await client.wallet.fund(1_000, "USD");
      const card = await client.cards.create({ currency: "USD", single_use: false, x402_allowed_hosts: ["127.0.0.1"] });
      expect(card.x402AllowedHosts).toEqual(["127.0.0.1"]);

      const result = await client.x402.pay({ card_id: card.id, url: resourceUrl, max_usd: "0.01" });
      expect(result).toMatchObject({ status: "paid", charged_cents: 1, price: { usd: "0.002500" }, settlement: { transaction: "0xfeed" } });
      expect(JSON.parse(result.resource!.body!)).toEqual({ answer: 42 });

      const tooMuch = await client.x402.pay({ card_id: card.id, url: resourceUrl, max_usd: "0.001" });
      expect(tooMuch).toMatchObject({ status: "declined", decline_reason: "x402_price_above_max" });

      expect(await client.x402.tab(card.id)).toEqual({
        card_id: card.id,
        payments: 1,
        paid_atomic: "2500",
        paid_usd: "0.002500",
        charged_cents: 1,
        credit_atomic: "7500",
      });
    } finally {
      server.close();
      resource.close();
    }
  });
});
