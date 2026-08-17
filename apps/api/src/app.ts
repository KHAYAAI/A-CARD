import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { z } from "zod";
import {
  currentBillingPeriod,
  DomainError,
  redactCard,
  roleAtLeast,
  signWebhook,
  SUBSCRIPTION_TIERS,
  verifyWebhook,
  type AccountHolder,
  type ApiKey,
  type Currency,
  type PublicUser,
  type Role,
  type SubscriptionTier,
} from "@acard/core";
import { PaystackClient, subscriptionReference } from "./paystack.js";
import { EmbeddedWalletClient, type EmbeddedWalletConfig } from "./embeddedWallet.js";
import { InMemoryPlatformService, hashRequestPayload, type PlatformService } from "./service/index.js";

/**
 * A-CARD REST API.
 *
 * Auth model: `Authorization: Bearer <api key secret>` for /v1 routes.
 * Signup is unauthenticated and returns the first API key. The issuer
 * webhook is authenticated by HMAC signature, not API key.
 *
 * The API depends only on the async `PlatformService` port, so it runs
 * unchanged against the in-memory sandbox or the Postgres multi-writer store.
 */

export interface AppConfig {
  /** The async platform service. A raw in-memory `Platform` is auto-wrapped. */
  platform: PlatformService | import("@acard/core").Platform;
  /** Shared secret with the (mock) issuer for webhook signatures. */
  issuerWebhookSecret: string;
  /** Called after any request that might have mutated platform state (snapshot persistence hook). */
  onMutation?: () => void;
  /** Paystack integration for ZAR subscription billing (optional — omit to run unmetered). */
  paystack?: { secretKey: string; webhookSecret: string };
  /**
   * Embedded-wallet provider (optional — omit to run without crypto wallets
   * at all). When set, every new account gets a wallet auto-provisioned on
   * signup so nobody has to create one themselves; external wallets can
   * always be linked in addition, regardless of this setting.
   */
  embeddedWallet?: EmbeddedWalletConfig;
  /** Where Paystack should send the customer back after checkout. */
  dashboardUrl?: string;
}

function asService(platform: AppConfig["platform"]): PlatformService {
  // A bare `Platform` (has `serialize`) is wrapped; a `PlatformService` passes through.
  return "serialize" in platform ? new InMemoryPlatformService(platform) : platform;
}

type Env = { Variables: { holder: AccountHolder; role: Role; apiKey?: ApiKey; sessionUser?: PublicUser } };

const SESSION_COOKIE = "acard_session";
const currencySchema = z.enum(["ZAR", "USD", "NGN", "KES"]);

const accountTypeSchema = z.enum(["personal", "enterprise"]);

const registerSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1),
  password: z.string().min(8),
  currency: currencySchema.optional(),
  account_type: accountTypeSchema.optional(),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  account_holder_id: z.string().optional(),
});

const mfaVerifySchema = z.object({
  challenge_token: z.string().min(1),
  code: z.string().min(1),
});

const mfaCodeSchema = z.object({ code: z.string().min(1) });

const mfaDisableSchema = z.object({ password: z.string().min(1), code: z.string().min(1) });

const issueKeySchema = z.object({
  name: z.string().default("api key"),
  scope: z.enum(["full", "read_only"]).default("full"),
  /** Cumulative card budget this key may provision, in minor units. */
  spend_cap_cents: z.number().int().positive().optional(),
});

const addMemberSchema = z.object({
  email: z.string().email(),
  name: z.string().optional(),
  password: z.string().min(8).optional(),
  role: z.enum(["owner", "admin", "member", "viewer"]),
});

const signupSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1),
  currency: currencySchema.optional(),
  account_type: accountTypeSchema.optional(),
});

const departmentSchema = z.object({
  name: z.string().min(1),
  monthly_budget: z.number().int().positive(),
  lead: z.string().optional(),
});

const policySchema = z.object({
  blocked_merchant_categories: z.array(z.string()).default([]),
  approval_threshold: z.number().int().positive().optional(),
});

const chainSchema = z.enum(["ethereum", "polygon", "solana"]);

const linkWalletSchema = z.object({
  chain: chainSchema,
  address: z.string().min(1),
  connector: z.enum(["metamask", "walletconnect", "coinbase", "other"]),
  label: z.string().optional(),
});

const fundSchema = z.object({
  amount: z.number().int().positive(),
  currency: currencySchema.optional(),
  reference: z.string().optional(),
});

const createCardSchema = z.object({
  label: z.string().optional(),
  currency: currencySchema.optional(),
  department_id: z.string().optional(),
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
  // Defaults to the card's own currency once the card is loaded.
  currency: currencySchema.optional(),
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
  const { issuerWebhookSecret, onMutation, dashboardUrl } = config;
  const platform = asService(config.platform);
  const paystack = config.paystack ? new PaystackClient(config.paystack) : undefined;
  const embeddedWallet = config.embeddedWallet ? new EmbeddedWalletClient(config.embeddedWallet) : undefined;
  const app = new Hono<Env>();

  // Auto-provision the default embedded wallet for a brand-new account. Best-effort:
  // a provider hiccup must not block signup, so failures are logged, not thrown.
  const provisionEmbeddedWallet = async (accountHolderId: string) => {
    if (!embeddedWallet) return;
    try {
      const wallet = await embeddedWallet.createWallet(accountHolderId);
      await platform.recordEmbeddedWallet(accountHolderId, wallet.chain, wallet.address);
    } catch (error) {
      console.error("embedded wallet provisioning failed", error);
    }
  };

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
    const holder = await platform.signup({ email: body.email, name: body.name, currency: body.currency, accountType: body.account_type });
    const issued = await platform.issueApiKey(holder.id, "default");
    await provisionEmbeddedWallet(holder.id);
    return c.json(
      {
        account_holder: holder,
        api_key: issued.secret,
        api_key_id: issued.id,
      },
      201,
    );
  });

  // ---- auth: register / login / session (dashboard, human RBAC) -------------
  // These sit before the /v1 auth guard: register + login are public.

  const secureCookies = process.env.NODE_ENV === "production";
  const setSessionCookie = (c: Context<Env>, token: string) =>
    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: "Lax",
      path: "/",
      secure: secureCookies,
      maxAge: 60 * 60 * 24 * 7,
    });
  const bearerSession = (c: Context<Env>) => {
    const h = c.req.header("authorization") ?? "";
    const b = h.startsWith("Bearer ") ? h.slice(7) : "";
    return b.startsWith("sess_") ? b : undefined;
  };

  app.post("/v1/auth/register", async (c) => {
    const body = registerSchema.parse(await c.req.json());
    const result = await platform.registerAccount({
      email: body.email,
      name: body.name,
      password: body.password,
      currency: body.currency,
      accountType: body.account_type,
    });
    setSessionCookie(c, result.sessionToken);
    await provisionEmbeddedWallet(result.accountHolder.id);
    return c.json(
      { user: result.user, account_holder: result.accountHolder, role: result.context.role, session_token: result.sessionToken },
      201,
    );
  });

  app.post("/v1/auth/login", async (c) => {
    const body = loginSchema.parse(await c.req.json());
    const result = await platform.login({
      email: body.email,
      password: body.password,
      accountHolderId: body.account_holder_id,
    });
    if (result.status === "mfa_required") {
      // No session and no cookie yet — the challenge is not an authenticated state.
      return c.json({ mfa_required: true, challenge_token: result.challengeToken }, 200);
    }
    setSessionCookie(c, result.sessionToken);
    return c.json({
      user: result.context.user,
      account_holder_id: result.context.accountHolderId,
      role: result.context.role,
      session_token: result.sessionToken,
    });
  });

  // Second step of an MFA login: public, because the caller has no session yet.
  app.post("/v1/auth/mfa/verify", async (c) => {
    const body = mfaVerifySchema.parse(await c.req.json());
    const { sessionToken, context } = await platform.verifyMfaChallenge(body.challenge_token, body.code);
    setSessionCookie(c, sessionToken);
    return c.json({
      user: context.user,
      account_holder_id: context.accountHolderId,
      role: context.role,
      session_token: sessionToken,
    });
  });

  // ---- API-key OR session auth for everything else under /v1 ----------------

  const PUBLIC_V1 = new Set(["/v1/signup", "/v1/auth/register", "/v1/auth/login", "/v1/auth/mfa/verify"]);
  app.use("/v1/*", async (c, next) => {
    if (PUBLIC_V1.has(c.req.path)) return next();
    const header = c.req.header("authorization") ?? "";
    const bearer = header.startsWith("Bearer ") ? header.slice(7) : "";

    // Programmatic tenant credential (agents, CLI, MCP): full access.
    if (bearer.startsWith("ak_")) {
      const principal = await platform.authenticateApiKey(bearer);
      if (!principal) return c.json({ error: { code: "unauthorized", message: "invalid API key" } }, 401);
      c.set("holder", principal.holder);
      c.set("apiKey", principal.key);
      // A read-only key is exactly a viewer: reads pass, every write route's
      // existing `requireRole` gate rejects it. No second permission system.
      c.set("role", principal.key.scope === "read_only" ? "viewer" : "owner");
      return next();
    }

    // Human session: bearer sess_ token or the httpOnly cookie.
    const sessionToken = bearer.startsWith("sess_") ? bearer : getCookie(c, SESSION_COOKIE);
    if (sessionToken) {
      const ctx = await platform.resolveSession(sessionToken);
      if (ctx) {
        const holder = await platform.getAccountHolder(ctx.accountHolderId);
        if (holder) {
          c.set("holder", holder);
          c.set("role", ctx.role);
          c.set("sessionUser", ctx.user);
          return next();
        }
      }
    }
    return c.json({ error: { code: "unauthorized", message: "authentication required" } }, 401);
  });

  const requireRole = (min: Role) =>
    async (c: { get: (k: "role") => Role; json: (b: unknown, s?: number) => Response }, next: () => Promise<void>) => {
      const role = c.get("role");
      if (!role || !roleAtLeast(role, min)) {
        return c.json({ error: { code: "forbidden", message: `this action requires the ${min} role or higher` } }, 403);
      }
      return next();
    };

  app.get("/v1/auth/me", async (c) => {
    const holder = c.get("holder");
    return c.json({ account_holder: holder, role: c.get("role"), wallets: await platform.walletBalances(holder.id) });
  });

  // ---- MFA enrolment (authenticated; the verify step above is public) --------
  // Enrolment acts on the signed-in *user*, so it needs a session — an API key
  // authenticates an org, not a person, and has no second factor to enrol.

  const sessionUserId = (c: Context<Env>): string => {
    const user = c.get("sessionUser");
    if (!user) {
      throw new DomainError("session_required", "MFA is managed by a signed-in user, not an API key", 403);
    }
    return user.id;
  };

  app.post("/v1/auth/mfa/setup", async (c) => {
    const { secret, keyUri } = await platform.beginMfaEnrolment(sessionUserId(c));
    return c.json({ secret, otpauth_url: keyUri });
  });

  app.post("/v1/auth/mfa/enable", async (c) => {
    const body = mfaCodeSchema.parse(await c.req.json());
    const { recoveryCodes } = await platform.confirmMfaEnrolment(sessionUserId(c), body.code);
    // Shown exactly once — they are stored only as hashes.
    return c.json({ enabled: true, recovery_codes: recoveryCodes });
  });

  app.post("/v1/auth/mfa/disable", async (c) => {
    const body = mfaDisableSchema.parse(await c.req.json());
    await platform.disableMfa(sessionUserId(c), body.password, body.code);
    return c.json({ enabled: false });
  });

  app.post("/v1/auth/logout", async (c) => {
    const token = bearerSession(c) ?? getCookie(c, SESSION_COOKIE);
    if (token) await platform.logout(token);
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ ok: true });
  });

  app.get("/v1/auth/members", requireRole("admin"), async (c) => {
    const holder = c.get("holder");
    return c.json({ members: await platform.listMembers(holder.id) });
  });

  app.post("/v1/auth/members", requireRole("admin"), async (c) => {
    const holder = c.get("holder");
    const body = addMemberSchema.parse(await c.req.json());
    const member = await platform.addMember({ accountHolderId: holder.id, ...body });
    return c.json({ member }, 201);
  });

  // ---- enterprise: departments, policy, audit -------------------------------

  app.get("/v1/departments", async (c) => {
    const holder = c.get("holder");
    return c.json({ departments: await platform.listDepartmentSpend(holder.id) });
  });

  app.post("/v1/departments", requireRole("admin"), async (c) => {
    const holder = c.get("holder");
    const body = departmentSchema.parse(await c.req.json());
    const department = await platform.createDepartment({ accountHolderId: holder.id, name: body.name, monthlyBudget: body.monthly_budget, lead: body.lead });
    return c.json({ department }, 201);
  });

  app.patch("/v1/departments/:id", requireRole("admin"), async (c) => {
    const holder = c.get("holder");
    const list = await platform.listDepartments(holder.id);
    if (!list.some((d) => d.id === c.req.param("id"))) {
      return c.json({ error: { code: "not_found", message: "department not found" } }, 404);
    }
    const body = departmentSchema.partial().parse(await c.req.json());
    const department = await platform.updateDepartment(c.req.param("id"), { name: body.name, monthlyBudget: body.monthly_budget, lead: body.lead });
    return c.json({ department });
  });

  app.get("/v1/policy", async (c) => {
    const holder = c.get("holder");
    const policy = await platform.getPolicy(holder.id);
    return c.json({
      policy: { blocked_merchant_categories: policy.blockedMerchantCategories, approval_threshold: policy.approvalThreshold },
    });
  });

  app.put("/v1/policy", requireRole("admin"), async (c) => {
    const holder = c.get("holder");
    const body = policySchema.parse(await c.req.json());
    const policy = await platform.setPolicy(holder.id, {
      blockedMerchantCategories: body.blocked_merchant_categories,
      approvalThreshold: body.approval_threshold,
    });
    return c.json({
      policy: { blocked_merchant_categories: policy.blockedMerchantCategories, approval_threshold: policy.approvalThreshold },
    });
  });

  // Audit log = every authorization decision (approved, declined, held) for the org.
  app.get("/v1/audit", async (c) => {
    const holder = c.get("holder");
    return c.json({ audit: await platform.listTransactions({ accountHolderId: holder.id }) });
  });

  // ---- idempotency for mutating /v1 requests --------------------------------

  app.use("/v1/*", async (c, next) => {
    if (c.req.method !== "POST") return next();
    const key = c.req.header("idempotency-key");
    if (!key) return next();
    const holder = c.get("holder");
    const scoped = `${holder?.id ?? "anon"}:${c.req.path}:${key}`;
    const payload = await c.req.raw.clone().text();
    const hash = hashRequestPayload(payload);
    const lookup = await platform.idempotencyGet(scoped, hash);
    if (lookup.hit) {
      return c.json(lookup.body as object, lookup.status as 200);
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
      await platform.idempotencyPut(scoped, hash, c.res.status, responseBody);
    }
  });

  // ---- wallet ----------------------------------------------------------------

  app.get("/v1/wallet", async (c) => {
    const holder = c.get("holder");
    const currency = c.req.query("currency") as Currency | undefined;
    const wallets = await platform.walletBalances(holder.id);
    // `wallet` is the requested currency (or the org's primary) for convenience;
    // `wallets` is every currency the org holds (ZAR, USD, …).
    const wallet = currency
      ? await platform.walletBalance(holder.id, currency)
      : wallets.find((w) => w.currency === holder.currency) ?? wallets[0];
    return c.json({ wallet, wallets });
  });

  app.post("/v1/wallet/fund", requireRole("member"), async (c) => {
    const holder = c.get("holder");
    const body = fundSchema.parse(await c.req.json());
    const { ledgerTransaction, wallet } = await platform.fundWallet(holder.id, body.amount, body.currency, body.reference);
    return c.json({ ledger_transaction: ledgerTransaction, wallet, wallets: await platform.walletBalances(holder.id) }, 201);
  });

  // ---- crypto wallets: embedded by default, external optional ----------------
  // Every account gets an embedded wallet auto-provisioned at signup (see
  // provisionEmbeddedWallet above) — nobody has to create one. These routes
  // let a user additionally link a wallet they already control.

  app.get("/v1/wallets/crypto", async (c) => {
    const holder = c.get("holder");
    return c.json({ wallets: await platform.listLinkedWallets(holder.id) });
  });

  app.post("/v1/wallets/crypto/link", requireRole("member"), async (c) => {
    const holder = c.get("holder");
    const body = linkWalletSchema.parse(await c.req.json());
    const wallet = await platform.linkExternalWallet({ accountHolderId: holder.id, ...body });
    return c.json({ wallet }, 201);
  });

  app.post("/v1/wallets/crypto/:id/default", requireRole("member"), async (c) => {
    const holder = c.get("holder");
    const wallet = await platform.setDefaultWallet(holder.id, c.req.param("id"));
    return c.json({ wallet });
  });

  app.delete("/v1/wallets/crypto/:id", requireRole("member"), async (c) => {
    const holder = c.get("holder");
    await platform.unlinkWallet(holder.id, c.req.param("id"));
    return c.json({ ok: true });
  });

  // ---- cards -----------------------------------------------------------------

  app.post("/v1/cards", requireRole("member"), async (c) => {
    const holder = c.get("holder");
    const body = createCardSchema.parse(await c.req.json().catch(() => ({})));
    const card = await platform.createCard({
      accountHolderId: holder.id,
      label: body.label,
      currency: body.currency,
      departmentId: body.department_id,
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
      apiKeyId: c.get("apiKey")?.id,
    });
    // Sandbox returns full card credentials once at creation, like issuer
    // sandboxes do. Production would return an issuer-hosted credential URL.
    return c.json({ card }, 201);
  });

  app.get("/v1/cards", async (c) => {
    const holder = c.get("holder");
    return c.json({ cards: (await platform.listCards(holder.id)).map(redactCard) });
  });

  app.get("/v1/cards/:id", async (c) => {
    const holder = c.get("holder");
    const card = await platform.getCard(c.req.param("id"));
    if (!card || card.accountHolderId !== holder.id) {
      return c.json({ error: { code: "not_found", message: "card not found" } }, 404);
    }
    return c.json({ card: redactCard(card) });
  });

  app.post("/v1/cards/:id/close", requireRole("member"), async (c) => {
    const holder = c.get("holder");
    const card = await platform.getCard(c.req.param("id"));
    if (!card || card.accountHolderId !== holder.id) {
      return c.json({ error: { code: "not_found", message: "card not found" } }, 404);
    }
    return c.json({ card: redactCard(await platform.closeCard(card.id)) });
  });

  // ---- transactions ------------------------------------------------------------

  app.get("/v1/transactions", async (c) => {
    const holder = c.get("holder");
    const cardId = c.req.query("card_id");
    return c.json({
      transactions: await platform.listTransactions({ accountHolderId: holder.id, cardId: cardId || undefined }),
    });
  });

  // ---- approvals ----------------------------------------------------------------

  app.get("/v1/approvals", async (c) => {
    const holder = c.get("holder");
    const status = c.req.query("status") as "pending" | undefined;
    return c.json({ approvals: await platform.listApprovals({ accountHolderId: holder.id, status }) });
  });

  app.post("/v1/approvals/:id/approve", requireRole("member"), async (c) => {
    const holder = c.get("holder");
    const approval = await platform.getApproval(c.req.param("id"));
    if (!approval || approval.accountHolderId !== holder.id) {
      return c.json({ error: { code: "not_found", message: "approval not found" } }, 404);
    }
    return c.json({ approval: await platform.decideApproval(approval.id, "approved", holder.email) });
  });

  app.post("/v1/approvals/:id/deny", requireRole("member"), async (c) => {
    const holder = c.get("holder");
    const approval = await platform.getApproval(c.req.param("id"));
    if (!approval || approval.accountHolderId !== holder.id) {
      return c.json({ error: { code: "not_found", message: "approval not found" } }, 404);
    }
    return c.json({ approval: await platform.decideApproval(approval.id, "denied", holder.email) });
  });

  // ---- API keys -------------------------------------------------------------------

  app.post("/v1/keys", requireRole("admin"), async (c) => {
    const holder = c.get("holder");
    const body = issueKeySchema.parse(await c.req.json().catch(() => ({})));
    const issued = await platform.issueApiKey(holder.id, body.name, {
      scope: body.scope,
      spendCapCents: body.spend_cap_cents,
    });
    return c.json(
      {
        api_key: issued.secret,
        api_key_id: issued.id,
        scope: issued.scope,
        spend_cap_cents: issued.spendCapCents ?? null,
      },
      201,
    );
  });

  app.get("/v1/keys", requireRole("admin"), async (c) => {
    return c.json({ keys: await platform.listApiKeys(c.get("holder").id) });
  });

  app.delete("/v1/keys/:id", requireRole("admin"), async (c) => {
    await platform.revokeApiKey(c.get("holder").id, c.req.param("id"));
    return c.json({ revoked: true });
  });

  // ---- billing (freemium tiers, ZAR collection via Paystack) ------------------------

  app.get("/v1/billing/plans", (c) => c.json({ plans: SUBSCRIPTION_TIERS }));

  app.post("/v1/billing/checkout", requireRole("admin"), async (c) => {
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
    if (eventId && !(await platform.markEvent(`paystack:${eventId}`))) {
      return c.json({ received: true, duplicate: true });
    }
    if (event.event === "charge.success") {
      const { accountHolderId, tier } = event.data.metadata ?? {};
      if (accountHolderId && tier) await platform.setSubscriptionTier(accountHolderId, tier);
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
      const decision = await platform.authorize({
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
    if (!(await platform.markEvent(event.id))) {
      return c.json({ received: true, duplicate: true });
    }

    if (event.type === "transaction.capture") {
      const data = z
        .object({ authorization_id: z.string(), final_amount: z.number().int().positive().optional() })
        .parse(event.data);
      await platform.capture(data.authorization_id, data.final_amount);
      return c.json({ received: true });
    }

    // authorization.reversal
    const data = z.object({ authorization_id: z.string() }).parse(event.data);
    await platform.reverse(data.authorization_id);
    return c.json({ received: true });
  });

  // ---- sandbox simulator ---------------------------------------------------------
  // Plays the role of the issuing partner: builds a signed webhook and feeds it
  // through the real webhook route, so the full verification + decision path is
  // exercised exactly as production would.

  app.post("/v1/simulate/purchase", requireRole("member"), async (c) => {
    const holder = c.get("holder");
    const body = simulateAuthSchema.parse(await c.req.json());
    const card = await platform.getCard(body.card_id);
    if (!card || card.accountHolderId !== holder.id) {
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
        currency: body.currency ?? card.currency,
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
      wallet: await platform.walletBalance(holder.id, card.currency),
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
