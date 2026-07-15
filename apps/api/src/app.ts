import { Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import {
  currentBillingPeriod,
  DomainError,
  Platform,
  redactCard,
  signWebhook,
  SUBSCRIPTION_TIERS,
  verifyWebhook,
  type AccountHolder,
  type Currency,
  type SubscriptionTier,
} from "@acard/core";
import { PaystackClient, subscriptionReference } from "./paystack.js";

/**
 * A-CARD REST API.
 *
 * Auth model: `Authorization: Bearer <api key secret>` for /v1 routes.
 * Signup is unauthenticated and returns the first API key. The issuer
 * webhook is authenticated by HMAC signature, not API key.
 */

export interface AppConfig {
  platform: Platform;
  /** Shared secret with the (mock) issuer for webhook signatures. */
  issuerWebhookSecret: string;
  /** Called after any request that might have mutated platform state (persistence hook). */
  onMutation?: () => void;
  /** Paystack integration for ZAR subscription billing (optional — omit to run unmetered). */
  paystack?: { secretKey: string; webhookSecret: string };
  /** Where Paystack should send the customer back after checkout. */
  dashboardUrl?: string;
}

type Env = { Variables: { holder: AccountHolder } };

const currencySchema = z.enum(["ZAR", "USD", "NGN", "KES"]);

const signupSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1),
  currency: currencySchema.optional(),
});

const fundSchema = z.object({
  amount: z.number().int().positive(),
  reference: z.string().optional(),
});

const createCardSchema = z.object({
  label: z.string().optional(),
  single_use: z.boolean().optional(),
  limits: z
    .object({
      per_transaction: z.number().int().positive().optional(),
      total: z.number().int().positive().optional(),
      velocity: z
        .object({ amount: z.number().int().positive(), window_seconds: z.number().int().positive() })
        .optional(),
    })
    .optional(),
  allowed_merchant_categories: z.array(z.string()).optional(),
  approval_threshold: z.number().int().positive().optional(),
});

const simulateAuthSchema = z.object({
  card_id: z.string(),
  amount: z.number().int().positive(),
  currency: currencySchema.default("ZAR"),
  merchant: z.object({
    name: z.string(),
    category: z.string().default("5999"),
    country: z.string().optional(),
  }),
});

const issuerEventSchema = z.object({
  id: z.string(),
  type: z.enum(["authorization.request", "transaction.capture", "authorization.reversal"]),
  data: z.record(z.unknown()),
});

export function createApp(config: AppConfig) {
  const { platform, issuerWebhookSecret, onMutation, dashboardUrl } = config;
  const paystack = config.paystack ? new PaystackClient(config.paystack) : undefined;
  const app = new Hono<Env>();

  app.use("*", cors());

  // Persist after any request that could have changed state — cheap, and the
  // snapshot writer already coalesces bursts (see apps/api/src/persistence.ts).
  app.use("*", async (c, next) => {
    await next();
    if (onMutation && c.req.method !== "GET" && c.res.status < 400) onMutation();
  });

  app.get("/health", (c) => c.json({ ok: true, service: "acard-api" }));

  // ---- public: signup -------------------------------------------------------

  app.post("/v1/signup", async (c) => {
    const body = signupSchema.parse(await c.req.json());
    const holder = platform.signup(body);
    const issued = platform.apiKeys.issue(holder.id, "default");
    return c.json(
      {
        account_holder: holder,
        api_key: issued.secret,
        api_key_id: issued.key.id,
      },
      201,
    );
  });

  // ---- API-key auth for everything else under /v1 ---------------------------

  app.use("/v1/*", async (c, next) => {
    if (c.req.path === "/v1/signup") return next();
    const header = c.req.header("authorization") ?? "";
    const secret = header.startsWith("Bearer ") ? header.slice(7) : "";
    const key = platform.apiKeys.authenticate(secret);
    if (!key) return c.json({ error: { code: "unauthorized", message: "invalid API key" } }, 401);
    c.set("holder", platform.getAccountHolder(key.accountHolderId));
    return next();
  });

  // ---- idempotency for mutating /v1 requests --------------------------------

  app.use("/v1/*", async (c, next) => {
    if (c.req.method !== "POST") return next();
    const key = c.req.header("idempotency-key");
    if (!key) return next();
    const holder = c.get("holder");
    const scoped = `${holder?.id ?? "anon"}:${c.req.path}:${key}`;
    const payload = await c.req.raw.clone().text();
    const hash = platform.idempotency.hashRequest(payload);
    const lookup = platform.idempotency.get(scoped, hash);
    if (lookup.hit) {
      return c.json(lookup.response.body as object, lookup.response.status as 200);
    }
    if (lookup.conflict) {
      return c.json(
        { error: { code: "idempotency_conflict", message: "idempotency key reused with a different payload" } },
        409,
      );
    }
    await next();
    if (c.res.status < 500) {
      const responseBody = await c.res.clone().json().catch(() => null);
      platform.idempotency.put(scoped, hash, c.res.status, responseBody);
    }
  });

  // ---- wallet ----------------------------------------------------------------

  app.get("/v1/wallet", (c) => {
    const holder = c.get("holder");
    return c.json({ wallet: platform.walletBalance(holder.id) });
  });

  app.post("/v1/wallet/fund", async (c) => {
    const holder = c.get("holder");
    const body = fundSchema.parse(await c.req.json());
    const tx = platform.fundWallet(holder.id, body.amount, body.reference);
    return c.json({ ledger_transaction: tx, wallet: platform.walletBalance(holder.id) }, 201);
  });

  // ---- cards -----------------------------------------------------------------

  app.post("/v1/cards", async (c) => {
    const holder = c.get("holder");
    const body = createCardSchema.parse(await c.req.json().catch(() => ({})));
    const card = platform.createCard({
      accountHolderId: holder.id,
      label: body.label,
      singleUse: body.single_use,
      limits: body.limits
        ? {
            perTransaction: body.limits.per_transaction,
            total: body.limits.total,
            velocity: body.limits.velocity
              ? { amount: body.limits.velocity.amount, windowSeconds: body.limits.velocity.window_seconds }
              : undefined,
          }
        : undefined,
      allowedMerchantCategories: body.allowed_merchant_categories,
      approvalThreshold: body.approval_threshold,
    });
    // Sandbox returns full card credentials once at creation, like issuer
    // sandboxes do. Production would return an issuer-hosted credential URL.
    return c.json({ card }, 201);
  });

  app.get("/v1/cards", (c) => {
    const holder = c.get("holder");
    return c.json({ cards: platform.listCards(holder.id).map(redactCard) });
  });

  app.get("/v1/cards/:id", (c) => {
    const holder = c.get("holder");
    const card = platform.getCard(c.req.param("id"));
    if (card.accountHolderId !== holder.id) {
      return c.json({ error: { code: "not_found", message: "card not found" } }, 404);
    }
    return c.json({ card: redactCard(card) });
  });

  app.post("/v1/cards/:id/close", (c) => {
    const holder = c.get("holder");
    const card = platform.getCard(c.req.param("id"));
    if (card.accountHolderId !== holder.id) {
      return c.json({ error: { code: "not_found", message: "card not found" } }, 404);
    }
    return c.json({ card: redactCard(platform.closeCard(card.id)) });
  });

  // ---- transactions ------------------------------------------------------------

  app.get("/v1/transactions", (c) => {
    const holder = c.get("holder");
    const cardId = c.req.query("card_id");
    return c.json({
      transactions: platform.listTransactions({ accountHolderId: holder.id, cardId: cardId || undefined }),
    });
  });

  // ---- approvals ----------------------------------------------------------------

  app.get("/v1/approvals", (c) => {
    const holder = c.get("holder");
    const status = c.req.query("status") as "pending" | undefined;
    return c.json({ approvals: platform.approvals.list({ accountHolderId: holder.id, status }) });
  });

  app.post("/v1/approvals/:id/approve", (c) => {
    const holder = c.get("holder");
    const approval = platform.approvals.get(c.req.param("id"));
    if (approval.accountHolderId !== holder.id) {
      return c.json({ error: { code: "not_found", message: "approval not found" } }, 404);
    }
    return c.json({ approval: platform.decideApproval(approval.id, "approved", holder.email) });
  });

  app.post("/v1/approvals/:id/deny", (c) => {
    const holder = c.get("holder");
    const approval = platform.approvals.get(c.req.param("id"));
    if (approval.accountHolderId !== holder.id) {
      return c.json({ error: { code: "not_found", message: "approval not found" } }, 404);
    }
    return c.json({ approval: platform.decideApproval(approval.id, "denied", holder.email) });
  });

  // ---- API keys -------------------------------------------------------------------

  app.post("/v1/keys", async (c) => {
    const holder = c.get("holder");
    const body = z.object({ name: z.string().default("api key") }).parse(await c.req.json().catch(() => ({})));
    const issued = platform.apiKeys.issue(holder.id, body.name);
    return c.json({ api_key: issued.secret, api_key_id: issued.key.id }, 201);
  });

  // ---- billing (freemium tiers, ZAR collection via Paystack) ------------------------

  app.get("/v1/billing/plans", (c) => c.json({ plans: SUBSCRIPTION_TIERS }));

  app.post("/v1/billing/checkout", async (c) => {
    if (!paystack) {
      return c.json({ error: { code: "billing_not_configured", message: "Paystack is not configured on this deployment" } }, 501);
    }
    const holder = c.get("holder");
    const { tier } = z.object({ tier: z.enum(["basic", "pro"]) }).parse(await c.req.json());
    const plan = SUBSCRIPTION_TIERS[tier as SubscriptionTier];
    const reference = subscriptionReference(holder.id, currentBillingPeriod());
    const checkout = await paystack.initializeTransaction({
      email: holder.email,
      amountMinorUnits: plan.priceZarCents,
      reference,
      callbackUrl: dashboardUrl,
      metadata: { accountHolderId: holder.id, tier },
    });
    return c.json({ checkout_url: checkout.authorizationUrl, reference: checkout.reference });
  });

  app.post("/webhooks/paystack", async (c) => {
    if (!paystack) return c.json({ error: { code: "billing_not_configured", message: "Paystack is not configured" } }, 501);
    const rawBody = await c.req.text();
    if (!paystack.verifyWebhookSignature(rawBody, c.req.header("x-paystack-signature"))) {
      return c.json({ error: { code: "invalid_signature", message: "bad Paystack signature" } }, 401);
    }
    const event = JSON.parse(rawBody) as {
      event: string;
      id?: string;
      data: { reference?: string; metadata?: { accountHolderId?: string; tier?: SubscriptionTier } };
    };
    const eventId = String(event.id ?? event.data.reference ?? "");
    if (eventId && !platform.idempotency.markEvent(`paystack:${eventId}`)) {
      return c.json({ received: true, duplicate: true });
    }
    if (event.event === "charge.success") {
      const { accountHolderId, tier } = event.data.metadata ?? {};
      if (accountHolderId && tier) platform.setSubscriptionTier(accountHolderId, tier);
    }
    return c.json({ received: true });
  });

  // ---- issuer webhook (the real-time authorization hot path) ------------------------

  app.post("/webhooks/issuer", async (c) => {
    const rawBody = await c.req.text();
    const verification = verifyWebhook(rawBody, c.req.header("x-acard-signature"), issuerWebhookSecret);
    if (!verification.valid) {
      return c.json({ error: { code: "invalid_signature", message: verification.reason } }, 401);
    }

    const event = issuerEventSchema.parse(JSON.parse(rawBody));

    if (event.type === "authorization.request") {
      const data = z
        .object({
          authorization_id: z.string(),
          card_id: z.string(),
          amount: z.number().int().positive(),
          currency: currencySchema,
          merchant: z.object({ name: z.string(), category: z.string(), country: z.string().optional() }),
        })
        .parse(event.data);
      // Idempotent by authorization id inside platform.authorize.
      const decision = platform.authorize({
        authorizationId: data.authorization_id,
        cardId: data.card_id,
        amount: data.amount,
        currency: data.currency,
        merchant: data.merchant,
      });
      return c.json({
        approved: decision.approved,
        decline_reason: decision.declineReason,
        approval_id: decision.approvalId,
      });
    }

    // Non-authorization events are settled at-most-once by event id.
    if (!platform.idempotency.markEvent(event.id)) {
      return c.json({ received: true, duplicate: true });
    }

    if (event.type === "transaction.capture") {
      const data = z
        .object({ authorization_id: z.string(), final_amount: z.number().int().positive().optional() })
        .parse(event.data);
      platform.capture(data.authorization_id, data.final_amount);
      return c.json({ received: true });
    }

    // authorization.reversal
    const data = z.object({ authorization_id: z.string() }).parse(event.data);
    platform.reverse(data.authorization_id);
    return c.json({ received: true });
  });

  // ---- sandbox simulator ---------------------------------------------------------
  // Plays the role of the issuing partner: builds a signed webhook and feeds it
  // through the real webhook route, so the full verification + decision path is
  // exercised exactly as production would.

  app.post("/v1/simulate/purchase", async (c) => {
    const holder = c.get("holder");
    const body = simulateAuthSchema.parse(await c.req.json());
    const card = platform.getCard(body.card_id);
    if (card.accountHolderId !== holder.id) {
      return c.json({ error: { code: "not_found", message: "card not found" } }, 404);
    }

    const authorizationId = `sauth_${crypto.randomUUID()}`;
    const authEvent = JSON.stringify({
      id: `evt_${crypto.randomUUID()}`,
      type: "authorization.request",
      data: {
        authorization_id: authorizationId,
        card_id: body.card_id,
        amount: body.amount,
        currency: body.currency,
        merchant: body.merchant,
      },
    });
    const authResponse = await app.request("/webhooks/issuer", {
      method: "POST",
      body: authEvent,
      headers: { "x-acard-signature": signWebhook(authEvent, issuerWebhookSecret) },
    });
    const decision = (await authResponse.json()) as {
      approved: boolean;
      decline_reason?: string;
      approval_id?: string;
    };

    if (decision.approved) {
      const captureEvent = JSON.stringify({
        id: `evt_${crypto.randomUUID()}`,
        type: "transaction.capture",
        data: { authorization_id: authorizationId },
      });
      await app.request("/webhooks/issuer", {
        method: "POST",
        body: captureEvent,
        headers: { "x-acard-signature": signWebhook(captureEvent, issuerWebhookSecret) },
      });
    }

    return c.json({
      authorization_id: authorizationId,
      approved: decision.approved,
      decline_reason: decision.decline_reason,
      approval_id: decision.approval_id,
      wallet: platform.walletBalance(holder.id),
    });
  });

  // ---- error handling ---------------------------------------------------------------

  app.onError((error, c) => {
    if (error instanceof DomainError) {
      return c.json({ error: { code: error.code, message: error.message } }, error.status as 400);
    }
    if (error instanceof z.ZodError) {
      return c.json({ error: { code: "invalid_request", message: error.issues[0]?.message ?? "invalid request", issues: error.issues } }, 400);
    }
    console.error(error);
    return c.json({ error: { code: "internal", message: "internal error" } }, 500);
  });

  return app;
}

export type { Currency };
