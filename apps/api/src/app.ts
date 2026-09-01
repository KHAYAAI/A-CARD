import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { z } from "zod";
import {
  DomainError,
  redactCard,
  roleAtLeast,
  signWebhook,
  SUBSCRIPTION_TIERS,
  verifyWebhook,
  publicMerchant,
  type AccountHolder,
  type ApiKey,
  type Currency,
  type PublicUser,
  type Role,
  type SubscriptionTier,
  type MerchantRole,
  type MerchantSessionContext,
  type MerchantStatus,
  createIntent as createAfpIntent,
  routeIntent,
} from "@acard/core";
import { createPayFastClient, type PayFastClient, type PayFastConfig } from "./payfast.js";
import { EmbeddedWalletClient, type EmbeddedWalletConfig } from "./embeddedWallet.js";
import { createWorkOSClient, domainFromEmail, type WorkOSClient, type WorkOSConfig } from "./workos.js";
import { createSudoClient, type IssuerCardClient, type SudoConfig } from "./sudo.js";
import { InMemoryPlatformService, hashRequestPayload, type PlatformService } from "./service/index.js";
import type { MerchantAuthPort, MerchantDirectoryPort } from "./merchant/types.js";
import { createMerchantAuthKitClient, type MerchantAuthKitClient, type MerchantAuthKitConfig } from "./merchantAuthKit.js";
import { createKybDocumentStore, type KybDocumentStore, type KybDocumentStoreConfig } from "./kybDocuments.js";
import { RailAmbiguousOutcomeError, type RailAdapter } from "./rails/index.js";
import type { AfpLedgerPort } from "./afp/index.js";

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
  /**
   * PayFast integration for real ZAR wallet funding (optional — omit to keep
   * the instant sandbox-credit behavior on `/v1/wallet/fund`). When set,
   * `/v1/wallet/fund` is disabled (crediting your own wallet for free would
   * be a real hole once this is live) in favor of
   * `/v1/wallet/fund/checkout` + the `/webhooks/payfast` ITN handler, which
   * only credits the wallet once PayFast confirms settlement.
   */
  payfast?: PayFastConfig | PayFastClient;
  /**
   * Embedded-wallet provider (optional — omit to run without crypto wallets
   * at all). When set, every new account gets a wallet auto-provisioned on
   * signup so nobody has to create one themselves; external wallets can
   * always be linked in addition, regardless of this setting.
   */
  embeddedWallet?: EmbeddedWalletConfig;
  /**
   * WorkOS SSO (optional — omit to run without it). Purely additive: existing
   * email/password login (with its own TOTP MFA) stays primary for every
   * account. Accepts either a `WorkOSConfig` (the real client is constructed)
   * or a `WorkOSClient` directly, so tests can inject a fake without hitting
   * the network.
   */
  workos?: WorkOSConfig | WorkOSClient;
  /**
   * Real card issuer (optional — omit to stay on the sandbox mock issuer,
   * which is what every card creation does today: a deterministic `4242…`
   * test PAN, no network call). When set, card creation also provisions a
   * real card with the issuer and links it via `Card.issuerCardId`, and the
   * `/webhooks/issuer` authorization path resolves a card by that reference
   * as well as by our own id — see `sudo.ts` for the current, unverified
   * wire format that needs confirming against the issuer's actual API
   * reference before this goes live with real money.
   */
  sudo?: SudoConfig | IssuerCardClient;
  /**
   * A-MERCHANT directory (optional — omit and no `/v1/merchants/*` route is
   * mounted at all). This is the supply-side read side: merchant profiles,
   * catalogs, inventory state, and agent discovery. It deliberately has no
   * order, payment-acceptance, or settlement surface — an agent discovers
   * here and then pays with an ordinary A-CARD card through the existing
   * flow, which is what keeps this layer clear of funds custody.
   */
  merchants?: MerchantDirectoryPort;
  /**
   * The merchant-portal identity service (optional — omit and the whole
   * portal surface, `/merchant-auth/*` and `/merchant-portal/*`, is
   * unmounted). Requires `merchants` too: there is nothing to log a
   * merchant user into without a directory record for them.
   */
  merchantAuth?: MerchantAuthPort;
  /**
   * WorkOS AuthKit for the merchant portal (optional — omit and portal
   * invites can still be generated via the operator console, but the login
   * link they produce has nowhere to send the merchant; `/merchant-auth/*`
   * stays unmounted). A config object builds the real client; a
   * `MerchantAuthKitClient` (tests) passes through.
   */
  merchantAuthKit?: MerchantAuthKitConfig | MerchantAuthKitClient;
  /**
   * Object storage for merchant KYB registration documents (optional — omit
   * and the operator console still works, but the upload button has nowhere
   * to send a file). Requires `merchants`. A config object builds the real
   * S3 client; a `KybDocumentStore` (tests) passes through.
   */
  kybDocuments?: KybDocumentStoreConfig | KybDocumentStore;
  /**
   * AFP — the Agent Financial Platform (optional — omit and /v1/afp/* is
   * unmounted). A routing engine plus a cross-rail ledger over whatever
   * `RailAdapter`s are configured; see apps/api/src/rails/. The ledger
   * itself is required whenever any rails are, since a rail with nowhere
   * to post its outcome isn't safely usable.
   */
  afp?: { ledger: AfpLedgerPort; rails: RailAdapter[] };
  /** Where PayFast checkout should send the customer back, and where the SSO callback redirects with a session. */
  dashboardUrl?: string;
}

function asService(platform: AppConfig["platform"]): PlatformService {
  // A bare `Platform` (has `serialize`) is wrapped; a `PlatformService` passes through.
  return "serialize" in platform ? new InMemoryPlatformService(platform) : platform;
}

function asWorkOSClient(config: WorkOSConfig | WorkOSClient): WorkOSClient {
  // A config object (has `apiKey`) builds the real client; a `WorkOSClient` (tests) passes through.
  return "apiKey" in config ? createWorkOSClient(config) : config;
}

function asIssuerClient(config: SudoConfig | IssuerCardClient): IssuerCardClient {
  // A config object (has `baseUrl`) builds the real client; an `IssuerCardClient` (tests) passes through.
  return "baseUrl" in config ? createSudoClient(config) : config;
}

function asPayFastClient(config: PayFastConfig | PayFastClient): PayFastClient {
  // A config object (has `merchantId`) builds the real client; a `PayFastClient` (tests) passes through.
  return "merchantId" in config ? createPayFastClient(config) : config;
}

function asMerchantAuthKitClient(config: MerchantAuthKitConfig | MerchantAuthKitClient): MerchantAuthKitClient {
  // A config object (has `apiKey`) builds the real client; a `MerchantAuthKitClient` (tests) passes through.
  return "apiKey" in config ? createMerchantAuthKitClient(config) : config;
}

function asKybDocumentStore(config: KybDocumentStoreConfig | KybDocumentStore): KybDocumentStore {
  // A config object (has `bucket`) builds the real client; a `KybDocumentStore` (tests) passes through.
  return "bucket" in config ? createKybDocumentStore(config) : config;
}

type Env = {
  Variables: {
    holder: AccountHolder;
    role: Role;
    apiKey?: ApiKey;
    sessionUser?: PublicUser;
    /** Set only on `/v1/merchant-portal/*` routes — a wholly separate identity from `holder` above. */
    merchantSession?: MerchantSessionContext;
  };
};

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

const ssoSetupSchema = z.object({
  /** Override the domain routed to this org's SSO connection; defaults to the caller's own email domain. */
  domain: z.string().min(1).optional(),
});

const ssoAuthorizeSchema = z.object({ email: z.string().email() });

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

const payfastCheckoutSchema = z.object({
  amount: z.number().int().positive(),
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


// ---- A-MERCHANT ------------------------------------------------------------

const addressSchema = z.object({
  addressLine: z.string().min(1),
  city: z.string().min(1),
  province: z.string().min(1),
  country: z.string().min(1).default("ZA"),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

const agentAccessSchema = z.enum(["open", "allowlist"]);
const availabilitySchema = z.enum(["in_stock", "low_stock", "out_of_stock", "made_to_order"]);

const registerMerchantSchema = z.object({
  name: z.string().min(1),
  trading_name: z.string().optional(),
  merchant_category_code: z.string().min(3),
  address: addressSchema,
  service_radius_km: z.number().min(0).optional(),
  currency: currencySchema.optional(),
  agent_access: agentAccessSchema.optional(),
  allowed_account_holder_ids: z.array(z.string()).optional(),
  kyb: z.object({
    registration_number: z.string().min(1),
    vat_number: z.string().optional(),
    contact_email: z.string().email(),
    contact_phone: z.string().optional(),
  }),
});

const kybDecisionSchema = z.object({
  status: z.enum(["pending_kyb", "verified", "suspended"]),
  note: z.string().optional(),
});

const updateMerchantSchema = z.object({
  name: z.string().min(1).optional(),
  trading_name: z.string().optional(),
  address: addressSchema.optional(),
  service_radius_km: z.number().min(0).optional(),
  agent_access: agentAccessSchema.optional(),
  allowed_account_holder_ids: z.array(z.string()).optional(),
  merchant_category_code: z.string().min(3).optional(),
});

const upsertItemSchema = z.object({
  sku: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  unit: z.string().optional(),
  unit_price_cents: z.number().int().nonnegative(),
  currency: currencySchema.optional(),
  availability: availabilitySchema.optional(),
  quantity_available: z.number().int().nonnegative().optional(),
  lead_time_days: z.number().int().nonnegative().optional(),
});

const restateSchema = z.object({
  availability: availabilitySchema,
  quantity_available: z.number().int().nonnegative().optional(),
});

const searchQuerySchema = z.object({
  text: z.string().optional(),
  merchant_category_codes: z.array(z.string()).optional(),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  radius_km: z.number().positive().optional(),
  quantity: z.number().int().positive().optional(),
  max_total_cents: z.number().int().positive().optional(),
  max_lead_time_days: z.number().int().nonnegative().optional(),
  max_inventory_age_hours: z.number().positive().optional(),
  currency: currencySchema.optional(),
  limit: z.number().int().positive().max(100).optional(),
});

const portalInviteSchema = z.object({ role: z.enum(["owner", "staff"]).optional() });

const railIdSchema = z.enum(["card", "x402", "stablecoin"]);
const createIntentSchema = z.object({
  amount: z.number().int().positive(),
  currency: currencySchema,
  purpose: z.string().min(1),
  counterparty: z.string().min(1),
  allowed_rails: z.array(railIdSchema).optional(),
});
const executeIntentSchema = z.object({ rail: railIdSchema.optional() });

const KYB_DOCUMENT_TYPES = ["application/pdf", "image/jpeg", "image/png"] as const;
const requestUploadSchema = z.object({
  filename: z.string().min(1).max(200),
  content_type: z.enum(KYB_DOCUMENT_TYPES),
});
const confirmUploadSchema = z.object({
  key: z.string().min(1),
  filename: z.string().min(1).max(200),
  content_type: z.enum(KYB_DOCUMENT_TYPES),
});

export function createApp(config: AppConfig) {
  const { issuerWebhookSecret, onMutation, dashboardUrl, merchants, merchantAuth } = config;
  const merchantAuthKit = config.merchantAuthKit ? asMerchantAuthKitClient(config.merchantAuthKit) : undefined;
  const kybDocuments = config.kybDocuments ? asKybDocumentStore(config.kybDocuments) : undefined;
  const afp = config.afp;
  const platform = asService(config.platform);
  const payfast = config.payfast ? asPayFastClient(config.payfast) : undefined;
  const embeddedWallet = config.embeddedWallet ? new EmbeddedWalletClient(config.embeddedWallet) : undefined;
  const workos = config.workos ? asWorkOSClient(config.workos) : undefined;
  const issuer = config.sudo ? asIssuerClient(config.sudo) : undefined;
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

  // On a deployment that has TLS configured, refuse any credentialed /v1/*
  // request that arrived over plain HTTP — checked from the real transport
  // signal (X-Forwarded-Proto, set by the ALB), not just the session
  // cookie's Secure flag, which only constrains the browser and says
  // nothing about a Bearer API key header or a proxy misconfiguration
  // upstream of this process. The ALB already redirects HTTP→HTTPS at the
  // edge when TLS is configured (see infra/cdk), so a legitimate request
  // should never carry `x-forwarded-proto: http` here — this is
  // defense-in-depth for the case where something bypasses that redirect.
  //
  // Deliberately keyed on ACARD_REQUIRE_HTTPS, not NODE_ENV: this stack
  // also supports a documented plain-HTTP :80 deployment path (no domain
  // configured) that still runs with NODE_ENV=production — that path's own
  // ALB forwards `x-forwarded-proto: http` on every request, so gating on
  // NODE_ENV alone would make it reject all of its own traffic.
  //
  // Scoped to /v1/*, not /health or /webhooks/*: the ALB's target-group
  // health check hits the container over plain HTTP even when the public
  // listener is HTTPS, and webhook callers authenticate with an HMAC
  // signature, not a bearer credential this check is protecting.
  if (process.env.ACARD_REQUIRE_HTTPS === "true") {
    app.use("/v1/*", async (c, next) => {
      if (c.req.header("x-forwarded-proto") === "http") {
        return c.json({ error: { code: "https_required", message: "this deployment requires HTTPS" } }, 400);
      }
      await next();
    });
  }

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

  // ---- SSO (WorkOS) login initiation: public, the caller has no session yet --
  // Existing email/password login (above) stays the primary path for every
  // account; this is purely an additive door for organizations that have
  // configured SSO via `/v1/sso/setup`.

  app.post("/v1/auth/sso/authorize", async (c) => {
    if (!workos) return c.json({ error: { code: "sso_not_configured", message: "SSO is not configured on this deployment" } }, 501);
    const body = ssoAuthorizeSchema.parse(await c.req.json());
    const domain = domainFromEmail(body.email);
    const holder = await platform.getAccountHolderBySsoDomain(domain);
    if (!holder?.workosOrganizationId) {
      return c.json({ error: { code: "sso_not_configured", message: `no SSO connection is configured for ${domain}` } }, 404);
    }
    return c.json({ redirect_url: workos.getAuthorizationUrl(holder.workosOrganizationId) });
  });

  // The identity provider redirects the browser here after authenticating —
  // a full page navigation, not a fetch, so this responds with a redirect
  // (carrying the session token in the query string) rather than JSON. The
  // dashboard SPA keeps its session in localStorage rather than the cookie
  // (see apps/dashboard/app/page.tsx), so the token has to travel this way;
  // the cookie is set too, for any server-rendered client that wants it.
  //
  // Kept under /v1/ (rather than a bare /auth/...) so the ALB's existing
  // "/v1/*" listener rule routes it to this service — see infra/cdk. It's
  // listed in PUBLIC_V1 below since the caller has no session yet.
  app.get("/v1/auth/sso/callback", async (c) => {
    if (!workos) return c.json({ error: { code: "sso_not_configured", message: "SSO is not configured on this deployment" } }, 501);
    const code = c.req.query("code");
    if (!code) return c.json({ error: { code: "invalid_request", message: "missing code" } }, 400);

    const profile = await workos.getProfile(code);
    // The organization id comes from WorkOS's own signed profile, not
    // anything the caller supplied at the authorize step — this is the
    // trustworthy end of the flow, unlike the email domain used to start it.
    const holder = profile.organizationId ? await platform.getAccountHolderByWorkosOrganizationId(profile.organizationId) : undefined;
    if (!holder) return c.json({ error: { code: "sso_not_configured", message: "no account is linked to this SSO organization" } }, 404);

    const { sessionToken } = await platform.completeSsoLogin({
      accountHolderId: holder.id,
      email: profile.email,
      name: [profile.firstName, profile.lastName].filter(Boolean).join(" ") || profile.email,
    });
    setSessionCookie(c, sessionToken);
    if (!dashboardUrl) return c.json({ session_token: sessionToken });
    return c.redirect(`${dashboardUrl}/?sso_token=${encodeURIComponent(sessionToken)}`, 302);
  });

  // ---- API-key OR session auth for everything else under /v1 ----------------

  const PUBLIC_V1 = new Set([
    "/v1/signup",
    "/v1/auth/register",
    "/v1/auth/login",
    "/v1/auth/mfa/verify",
    "/v1/auth/sso/authorize",
    "/v1/auth/sso/callback",
  ]);
  app.use("/v1/*", async (c, next) => {
    if (PUBLIC_V1.has(c.req.path)) return next();
    // The merchant portal is a second, narrower identity system (see
    // merchantAuth.ts) — a merchant user has no A-CARD API key or session,
    // so it can never satisfy this guard. Its own routes carry their own
    // cookie-based auth below; this only has to stay out of their way. Kept
    // as a prefix check on this one guard rather than moving the routes out
    // from under /v1/*, since the ALB only forwards /v1/*, /webhooks/*, and
    // /health to this service (see infra/cdk) — anything else never reaches it.
    if (c.req.path.startsWith("/v1/merchant-auth/") || c.req.path.startsWith("/v1/merchant-portal/")) return next();
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
    // PayFast only ever settles ZAR — instant credit stays available for
    // every other currency (still sandbox behavior there) even once real
    // ZAR funding is live. Only ZAR (the default when unspecified) routes
    // through the real rail.
    if (payfast && (body.currency ?? "ZAR") === "ZAR") {
      return c.json(
        { error: { code: "instant_funding_disabled", message: "Real ZAR funding is configured — use POST /v1/wallet/fund/checkout" } },
        409,
      );
    }
    const { ledgerTransaction, wallet } = await platform.fundWallet(holder.id, body.amount, body.currency, body.reference);
    return c.json({ ledger_transaction: ledgerTransaction, wallet, wallets: await platform.walletBalances(holder.id) }, 201);
  });

  app.post("/v1/wallet/fund/checkout", requireRole("member"), async (c) => {
    if (!payfast) {
      return c.json({ error: { code: "funding_not_configured", message: "PayFast is not configured on this deployment" } }, 501);
    }
    const holder = c.get("holder");
    const body = payfastCheckoutSchema.parse(await c.req.json());
    const reference = `${holder.id}:${Date.now()}`;
    const origin = (dashboardUrl ?? "").replace(/\/$/, "");
    const checkout = payfast.buildCheckout({
      amountMinorUnits: body.amount,
      itemName: "A-CARD wallet top-up",
      reference,
      email: holder.email,
      returnUrl: `${origin}/wallet?funded=1`,
      cancelUrl: `${origin}/wallet?funded=0`,
      // Fixed to our own webhook — never client-supplied, or a caller could
      // point PayFast's confirmation at an endpoint of their choosing.
      notifyUrl: `${origin}/webhooks/payfast`,
      customStr1: holder.id,
      customStr2: "fund",
    });
    return c.json({ action: checkout.action, fields: checkout.fields, reference });
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
    // With a real issuer configured, the card just created is a local record
    // only — it isn't usable until the issuer actually provisions it. That
    // provisioning is not best-effort like the wallet auto-provisioning
    // above: a card nobody issued can never authorize a real charge, so a
    // failure here closes the card and fails the request rather than
    // returning a card that looks active but can never work.
    if (issuer) {
      try {
        const provisioned = await issuer.createCard({
          accountHolderId: holder.id,
          cardId: card.id,
          currency: card.currency,
        });
        const linked = await platform.linkIssuerCard(card.id, provisioned.issuerCardId);
        return c.json({ card: linked }, 201);
      } catch (error) {
        await platform.closeCard(card.id, "issuer_provisioning_failed").catch(() => {});
        throw new DomainError(
          "issuer_provisioning_failed",
          `the card issuer could not provision this card: ${error instanceof Error ? error.message : String(error)}`,
          502,
        );
      }
    }
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

  // ---- SSO (WorkOS) setup — org owner only, self-serve after this point ------
  // Generates a link to WorkOS's hosted Admin Portal, where the org's own
  // IT/security team configures their SAML/OIDC connection directly — no
  // A-CARD login and no code on our side per customer.

  app.post("/v1/sso/setup", requireRole("owner"), async (c) => {
    if (!workos) return c.json({ error: { code: "sso_not_configured", message: "SSO is not configured on this deployment" } }, 501);
    const holder = c.get("holder");
    const body = ssoSetupSchema.parse(await c.req.json().catch(() => ({})));

    let organizationId = holder.workosOrganizationId;
    if (!organizationId) {
      const domain = body.domain ?? domainFromEmail(holder.email);
      const org = await workos.createOrganization(holder.name, domain);
      organizationId = org.id;
      await platform.setSsoOrganization(holder.id, { workosOrganizationId: organizationId, ssoDomain: domain });
    }

    const portalUrl = await workos.generatePortalLink(organizationId, dashboardUrl ?? "https://workos.com");
    return c.json({ portal_url: portalUrl });
  });

  // ---- billing (freemium tiers, subscriptions via PayFast) ------------------------
  //
  // Same processor as wallet funding, same webhook (/webhooks/payfast) — a
  // checkout is tagged `custom_str2: "fund"` or `"sub:<tier>"` so the one
  // ITN handler below can tell them apart. See payfast.ts's header for the
  // important caveat: PayFast's checkout has no currency field, so this
  // only bills the tiers' priceUsdCents figures correctly in USD if the
  // PayFast merchant account itself is confirmed (with PayFast) to bill in
  // USD — otherwise the same number is charged in the account's native ZAR.

  app.get("/v1/billing/plans", (c) => c.json({ plans: SUBSCRIPTION_TIERS }));

  app.post("/v1/billing/checkout", requireRole("admin"), async (c) => {
    if (!payfast) {
      return c.json({ error: { code: "billing_not_configured", message: "PayFast is not configured on this deployment" } }, 501);
    }
    const holder = c.get("holder");
    const { tier } = z.object({ tier: z.enum(["basic", "pro", "enterprise"]) }).parse(await c.req.json());
    const plan = SUBSCRIPTION_TIERS[tier as SubscriptionTier];
    const origin = (dashboardUrl ?? "").replace(/\/$/, "");
    const checkout = payfast.buildCheckout({
      amountMinorUnits: plan.priceUsdCents,
      itemName: `A-CARD ${tier} plan`,
      reference: `${holder.id}:${tier}:${Date.now()}`,
      email: holder.email,
      returnUrl: `${origin}/billing?upgraded=1`,
      cancelUrl: `${origin}/billing?upgraded=0`,
      notifyUrl: `${origin}/webhooks/payfast`,
      customStr1: holder.id,
      customStr2: `sub:${tier}`,
    });
    return c.json({ action: checkout.action, fields: checkout.fields });
  });

  app.post("/webhooks/payfast", async (c) => {
    if (!payfast) return c.json({ error: { code: "funding_not_configured", message: "PayFast is not configured" } }, 501);
    const rawBody = await c.req.text();
    const fields = Object.fromEntries(new URLSearchParams(rawBody)) as Record<string, string>;
    // Behind the ALB, the real client is the first hop in X-Forwarded-For.
    const remoteIp = (c.req.header("x-forwarded-for") ?? "").split(",")[0]?.trim() ?? "";
    const valid = await payfast.validateItn({ fields, rawBody, remoteIp });
    if (!valid) {
      return c.json({ error: { code: "invalid_itn", message: "PayFast ITN failed signature, source, or confirm-back validation" } }, 401);
    }
    const paymentId = fields.pf_payment_id ?? fields.m_payment_id ?? "";
    if (paymentId && !(await platform.markEvent(`payfast:${paymentId}`))) {
      return c.json({ received: true, duplicate: true });
    }
    if (fields.payment_status !== "COMPLETE") return c.json({ received: true });

    const accountHolderId = fields.custom_str1;
    const purpose = fields.custom_str2 ?? "fund";
    if (!accountHolderId) return c.json({ received: true });

    if (purpose.startsWith("sub:")) {
      const tier = purpose.slice("sub:".length) as SubscriptionTier;
      await platform.setSubscriptionTier(accountHolderId, tier);
    } else {
      const amountRand = Number(fields.amount_gross ?? fields.amount ?? "0");
      if (amountRand > 0) await platform.fundWallet(accountHolderId, Math.round(amountRand * 100), "ZAR", fields.m_payment_id);
    }
    return c.json({ received: true });
  });

  // ---- issuer webhook (the real-time authorization hot path) ------------------------
  //
  // `platform.authorize` resolves `card_id` against our own card id OR
  // Card.issuerCardId (see packages/core/src/platform.ts and the matching
  // Postgres query), so this route needs no change for a real issuer whose
  // webhook echoes their own card reference in this field. If Sudo's actual
  // webhook payload uses a different field name or signature scheme than
  // this schema/HMAC assumes (unconfirmed — see sudo.ts), that mapping
  // belongs here, translating their event into this shape before it reaches
  // `issuerEventSchema.parse` below.

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

  // ---- A-MERCHANT: supply-side directory (read side) --------------------------------

  // Mounted only when a directory is configured. The whole surface is
  // deliberately payment-free: discovery answers "what can I buy, from whom,
  // at what price, by when", and the agent then pays with an ordinary A-CARD
  // card through the existing flow. No orders, no acceptance, no settlement —
  // so nothing here holds a merchant's money or touches PAN data.
  if (merchants) {
    // Directory writes are operator actions in this first cut: A-CARD's own
    // team onboards merchants and records KYB outcomes, gated on the tenant
    // admin role. A merchant-owned identity and self-service console arrive
    // with the write side; until then there is no merchant login to model.
    app.post("/v1/merchants", requireRole("admin"), async (c) => {
      const body = registerMerchantSchema.parse(await c.req.json());
      const merchant = await merchants.register({
        name: body.name,
        tradingName: body.trading_name,
        merchantCategoryCode: body.merchant_category_code,
        address: body.address,
        serviceRadiusKm: body.service_radius_km,
        currency: body.currency,
        agentAccess: body.agent_access,
        allowedAccountHolderIds: body.allowed_account_holder_ids,
        kyb: {
          registrationNumber: body.kyb.registration_number,
          vatNumber: body.kyb.vat_number,
          contactEmail: body.kyb.contact_email,
          contactPhone: body.kyb.contact_phone,
        },
      });
      // Returns the full record, KYB included: this is the operator's own view.
      return c.json({ merchant }, 201);
    });

    app.post("/v1/merchants/:id/kyb", requireRole("admin"), async (c) => {
      const body = kybDecisionSchema.parse(await c.req.json());
      const reviewer = c.get("sessionUser")?.email ?? c.get("holder").email;
      const merchant = await merchants.setStatus(c.req.param("id"), body.status, reviewer, body.note);
      return c.json({ merchant });
    });

    // The only door into the merchant portal — see `merchantAuthKit`/`merchantAuth`
    // below. No open signup: an operator who has already run KYB on this
    // merchant is the one vouching for whoever redeems the link.
    if (merchantAuth) {
      app.post("/v1/merchants/:id/portal-invites", requireRole("admin"), async (c) => {
        const merchantId = c.req.param("id");
        await merchants.get(merchantId); // 404s if the merchant doesn't exist
        const body = portalInviteSchema.parse(await c.req.json().catch(() => ({})));
        const issuedBy = c.get("sessionUser")?.email ?? c.get("holder").email;
        const { invite, token } = await merchantAuth.createInvite(merchantId, body.role ?? "owner", issuedBy);
        const base = (dashboardUrl ?? "").replace(/\/$/, "");
        return c.json(
          {
            invite,
            // The merchant clicks this; it starts the WorkOS AuthKit hosted
            // login/signup and lands them in their own catalog when done.
            invite_url: `${base}/v1/merchant-auth/authorize?invite=${encodeURIComponent(token)}`,
          },
          201,
        );
      });

      app.get("/v1/merchants/:id/portal-invites", requireRole("admin"), async (c) => {
        return c.json({ invites: await merchantAuth.listInvites(c.req.param("id")) });
      });
    }

    // KYB registration document upload — the API never sees the file bytes,
    // only hands out a short-lived presigned URL and records the resulting
    // key. See kybDocuments.ts.
    if (kybDocuments) {
      app.post("/v1/merchants/:id/kyb-documents", requireRole("admin"), async (c) => {
        const merchantId = c.req.param("id");
        await merchants.get(merchantId); // 404s if unknown
        const body = requestUploadSchema.parse(await c.req.json());
        const { key, uploadUrl } = await kybDocuments.createUploadUrl(merchantId, body.filename, body.content_type);
        return c.json({ key, upload_url: uploadUrl }, 201);
      });

      app.post("/v1/merchants/:id/kyb-documents/confirm", requireRole("admin"), async (c) => {
        const merchantId = c.req.param("id");
        const body = confirmUploadSchema.parse(await c.req.json());
        // The key this endpoint is asked to attach must be one this merchant
        // was actually issued — otherwise an admin on one merchant could
        // attach (or overwrite the record of) an object key belonging to
        // another merchant's evidence trail.
        if (!body.key.startsWith(`kyb/${merchantId}/`)) {
          return c.json({ error: { code: "invalid_key", message: "this document key was not issued for this merchant" } }, 400);
        }
        const uploadedBy = c.get("sessionUser")?.email ?? c.get("holder").email;
        const merchant = await merchants.attachKybDocument(merchantId, {
          key: body.key,
          filename: body.filename,
          contentType: body.content_type,
          uploadedBy,
        });
        return c.json({ merchant }, 201);
      });

      app.get("/v1/merchants/:id/kyb-documents", requireRole("admin"), async (c) => {
        const merchant = await merchants.get(c.req.param("id"));
        const documents = await Promise.all(
          merchant.kyb.documents.map(async (doc) => ({ ...doc, download_url: await kybDocuments.createDownloadUrl(doc.key) })),
        );
        return c.json({ documents });
      });
    }

    app.patch("/v1/merchants/:id", requireRole("admin"), async (c) => {
      const body = updateMerchantSchema.parse(await c.req.json());
      const merchant = await merchants.updateProfile(c.req.param("id"), {
        name: body.name,
        tradingName: body.trading_name,
        address: body.address,
        serviceRadiusKm: body.service_radius_km,
        agentAccess: body.agent_access,
        allowedAccountHolderIds: body.allowed_account_holder_ids,
        merchantCategoryCode: body.merchant_category_code,
      });
      return c.json({ merchant });
    });

    app.put("/v1/merchants/:id/items", requireRole("member"), async (c) => {
      const body = upsertItemSchema.parse(await c.req.json());
      const item = await merchants.upsertItem(c.req.param("id"), {
        sku: body.sku,
        name: body.name,
        description: body.description,
        unit: body.unit,
        unitPriceCents: body.unit_price_cents,
        currency: body.currency,
        availability: body.availability,
        quantityAvailable: body.quantity_available,
        leadTimeDays: body.lead_time_days,
      });
      return c.json({ item });
    });

    // The highest-value write in A-MERCHANT and the cheapest to call: a
    // merchant restating stock. Everything discovery promises depends on this
    // happening often, so it is a single small request with no other effects.
    app.post("/v1/merchants/:id/items/:itemId/restate", requireRole("member"), async (c) => {
      const body = restateSchema.parse(await c.req.json());
      const item = await merchants.getItem(c.req.param("itemId"));
      if (item.merchantId !== c.req.param("id")) {
        return c.json({ error: { code: "not_found", message: "item does not belong to this merchant" } }, 404);
      }
      return c.json({
        item: await merchants.restate(item.id, {
          availability: body.availability,
          quantityAvailable: body.quantity_available,
        }),
      });
    });

    app.delete("/v1/merchants/:id/items/:itemId", requireRole("member"), async (c) => {
      const item = await merchants.getItem(c.req.param("itemId"));
      if (item.merchantId !== c.req.param("id")) {
        return c.json({ error: { code: "not_found", message: "item does not belong to this merchant" } }, 404);
      }
      await merchants.removeItem(item.id);
      return c.json({ deleted: true });
    });

    // How current this merchant's catalog is. Shown to the merchant, and the
    // number the field team is actually measured on.
    app.get("/v1/merchants/:id/health", async (c) => {
      const merchant = await merchants.get(c.req.param("id"));
      return c.json({ merchant_id: merchant.id, ...await merchants.catalogHealth(merchant.id) });
    });

    // ---- agent-facing reads --------------------------------------------------------

    app.get("/v1/merchants/search", async (c) => {
      const q = c.req.query();
      const query = searchQuerySchema.parse({
        text: q.q,
        merchant_category_codes: q.categories?.split(",").filter(Boolean),
        lat: q.lat === undefined ? undefined : Number(q.lat),
        lng: q.lng === undefined ? undefined : Number(q.lng),
        radius_km: q.radius_km === undefined ? undefined : Number(q.radius_km),
        quantity: q.quantity === undefined ? undefined : Number(q.quantity),
        max_total_cents: q.max_total_cents === undefined ? undefined : Number(q.max_total_cents),
        max_lead_time_days: q.max_lead_time_days === undefined ? undefined : Number(q.max_lead_time_days),
        max_inventory_age_hours: q.max_inventory_age_hours === undefined ? undefined : Number(q.max_inventory_age_hours),
        currency: q.currency,
        limit: q.limit === undefined ? undefined : Number(q.limit),
      });
      const near =
        query.lat !== undefined && query.lng !== undefined
          ? { lat: query.lat, lng: query.lng, radiusKm: query.radius_km ?? 25 }
          : undefined;

      const result = await merchants.search({
        text: query.text,
        merchantCategoryCodes: query.merchant_category_codes,
        near,
        quantity: query.quantity,
        maxTotalCents: query.max_total_cents,
        maxLeadTimeDays: query.max_lead_time_days,
        maxInventoryAgeHours: query.max_inventory_age_hours,
        currency: query.currency,
        // Scoped to the caller's own org, so a merchant's allow-list is
        // enforced against who is really asking, not a client-supplied id.
        requestedBy: c.get("holder").id,
        limit: query.limit,
      });
      return c.json(result);
    });

    app.get("/v1/merchants/:id", async (c) => {
      const merchant = await merchants.get(c.req.param("id"));
      // Agents get the public view: verified or not, never the KYB pack behind it.
      return c.json({ merchant: publicMerchant(merchant), items: await merchants.listItems(merchant.id) });
    });

    app.get("/v1/merchants", async (c) => {
      const status = c.req.query("status") as MerchantStatus | undefined;
      return c.json({ merchants: (await merchants.list(status ? { status } : {})).map(publicMerchant) });
    });

    // ---- merchant portal: WorkOS AuthKit login + the merchant's own view -------
    //
    // A second, narrower identity system (see merchantAuth.ts) — cookie name,
    // session store, and role model are all separate from A-CARD's own
    // login, on purpose, so nothing here can reach a wallet or a card.
    if (merchantAuth && merchantAuthKit) {
      const MERCHANT_SESSION_COOKIE = "acard_merchant_session";
      const setMerchantSessionCookie = (c: Context<Env>, token: string) =>
        setCookie(c, MERCHANT_SESSION_COOKIE, token, {
          httpOnly: true,
          sameSite: "Lax",
          path: "/",
          secure: secureCookies,
          maxAge: 60 * 60 * 24 * 7,
        });

      // Starts the hosted WorkOS login/signup. `invite` is the one-time token
      // from `POST /v1/merchants/:id/portal-invites` — it never touches
      // WorkOS itself, only rides along as opaque `state` so the callback can
      // recover which merchant this login is for.
      app.get("/v1/merchant-auth/authorize", async (c) => {
        const invite = c.req.query("invite") ?? "";
        const pending = await merchantAuth.peekInvite(invite);
        if (!pending) {
          return c.json({ error: { code: "invalid_invite", message: "this invite link is invalid or has expired" } }, 400);
        }
        if (pending.consumedAt) {
          return c.json({ error: { code: "invite_used", message: "this invite link has already been used" } }, 400);
        }
        if (Date.parse(pending.expiresAt) < Date.now()) {
          return c.json({ error: { code: "invite_expired", message: "this invite link has expired" } }, 400);
        }
        return c.redirect(merchantAuthKit.getAuthorizationUrl(invite), 302);
      });

      app.get("/v1/merchant-auth/callback", async (c) => {
        const code = c.req.query("code");
        const inviteToken = c.req.query("state");
        const base = (dashboardUrl ?? "").replace(/\/$/, "");
        if (!code || !inviteToken) {
          return c.redirect(`${base}/merchant?portal_error=${encodeURIComponent("missing code or invite")}`, 302);
        }
        try {
          const profile = await merchantAuthKit.authenticateWithCode(code);
          const user = await merchantAuth.redeemInvite(inviteToken, profile);
          const { token } = await merchantAuth.createSession(user);
          setMerchantSessionCookie(c, token);
          if (!base) return c.json({ portal_token: token });
          // Cross-origin dev (dashboard on :3000, API on :8787) can't rely on
          // the cookie landing on the dashboard's own origin — same fallback
          // pattern as the A-CARD SSO callback: hand the token back in the
          // query string too, and the dashboard stores it itself.
          return c.redirect(`${base}/merchant?portal_token=${encodeURIComponent(token)}`, 302);
        } catch (error) {
          const message = error instanceof DomainError ? error.message : "sign-in failed";
          return c.redirect(`${base}/merchant?portal_error=${encodeURIComponent(message)}`, 302);
        }
      });

      const requireMerchantSession = async (c: Context<Env>, next: () => Promise<void>) => {
        const bearer = (c.req.header("authorization") ?? "").replace(/^Bearer\s+/, "");
        const token = bearer || getCookie(c, MERCHANT_SESSION_COOKIE);
        const ctx = token ? await merchantAuth.resolveSession(token) : undefined;
        if (!ctx) return c.json({ error: { code: "unauthorized", message: "sign in to the merchant portal" } }, 401);
        c.set("merchantSession", ctx);
        await next();
      };

      app.post("/v1/merchant-portal/logout", requireMerchantSession, async (c) => {
        const bearer = (c.req.header("authorization") ?? "").replace(/^Bearer\s+/, "");
        const token = bearer || getCookie(c, MERCHANT_SESSION_COOKIE);
        if (token) await merchantAuth.revokeSession(token);
        deleteCookie(c, MERCHANT_SESSION_COOKIE, { path: "/" });
        return c.json({ ok: true });
      });

      app.get("/v1/merchant-portal/me", requireMerchantSession, async (c) => {
        const ctx = c.get("merchantSession")!;
        const merchant = await merchants.get(ctx.merchantId);
        return c.json({
          user: await merchantAuth.getUser(ctx.merchantUserId),
          // The portal gets exactly the agent-facing view of its own
          // profile — never the KYB pack, same redaction as `publicMerchant`
          // applies to every other reader of this record.
          merchant: publicMerchant(merchant),
        });
      });

      app.get("/v1/merchant-portal/items", requireMerchantSession, async (c) => {
        const ctx = c.get("merchantSession")!;
        return c.json({ items: await merchants.listItems(ctx.merchantId) });
      });

      app.put("/v1/merchant-portal/items", requireMerchantSession, async (c) => {
        const ctx = c.get("merchantSession")!;
        const body = upsertItemSchema.parse(await c.req.json());
        const item = await merchants.upsertItem(ctx.merchantId, {
          sku: body.sku,
          name: body.name,
          description: body.description,
          unit: body.unit,
          unitPriceCents: body.unit_price_cents,
          currency: body.currency,
          availability: body.availability,
          quantityAvailable: body.quantity_available,
          leadTimeDays: body.lead_time_days,
        });
        return c.json({ item });
      });

      // The one-tap "still have it / out of stock" flow — the single most
      // important write in the whole portal, see merchants.ts.
      app.post("/v1/merchant-portal/items/:itemId/restate", requireMerchantSession, async (c) => {
        const ctx = c.get("merchantSession")!;
        const item = await merchants.getItem(c.req.param("itemId") as string);
        if (item.merchantId !== ctx.merchantId) {
          return c.json({ error: { code: "not_found", message: "item does not belong to your shop" } }, 404);
        }
        const body = restateSchema.parse(await c.req.json());
        return c.json({ item: await merchants.restate(item.id, { availability: body.availability, quantityAvailable: body.quantity_available }) });
      });

      app.delete("/v1/merchant-portal/items/:itemId", requireMerchantSession, async (c) => {
        const ctx = c.get("merchantSession")!;
        const item = await merchants.getItem(c.req.param("itemId") as string);
        if (item.merchantId !== ctx.merchantId) {
          return c.json({ error: { code: "not_found", message: "item does not belong to your shop" } }, 404);
        }
        await merchants.removeItem(item.id);
        return c.json({ deleted: true });
      });

      app.get("/v1/merchant-portal/health", requireMerchantSession, async (c) => {
        const ctx = c.get("merchantSession")!;
        return c.json(await merchants.catalogHealth(ctx.merchantId));
      });

      // Staff management: only an owner can see who has access or grant more
      // of it. A shop typically has one owner and a couple of staff who need
      // to update stock — this is the loop that used to require going back
      // to an A-CARD operator every time.
      const requireOwner = async (c: Context<Env>, next: () => Promise<void>) => {
        if (c.get("merchantSession")!.role !== "owner") {
          return c.json({ error: { code: "forbidden", message: "only the shop owner can manage staff access" } }, 403);
        }
        await next();
      };

      app.get("/v1/merchant-portal/team", requireMerchantSession, requireOwner, async (c) => {
        const ctx = c.get("merchantSession")!;
        return c.json({
          users: await merchantAuth.listUsers(ctx.merchantId),
          // Only pending, unconsumed, unexpired invites — nothing an owner
          // can act on twice.
          invites: (await merchantAuth.listInvites(ctx.merchantId)).filter(
            (i) => !i.consumedAt && Date.parse(i.expiresAt) > Date.now(),
          ),
        });
      });

      app.post("/v1/merchant-portal/team/invites", requireMerchantSession, requireOwner, async (c) => {
        const ctx = c.get("merchantSession")!;
        const body = portalInviteSchema.parse(await c.req.json().catch(() => ({})));
        const issuer = await merchantAuth.getUser(ctx.merchantUserId);
        const { invite, token } = await merchantAuth.createInvite(ctx.merchantId, body.role ?? "staff", issuer.email);
        const base = (dashboardUrl ?? "").replace(/\/$/, "");
        return c.json({ invite, invite_url: `${base}/v1/merchant-auth/authorize?invite=${encodeURIComponent(token)}` }, 201);
      });
    }
  }

  // ---- AFP: the Agent Financial Platform -------------------------------------------
  //
  // A-CARD decides whether an agent may spend; A-MERCHANT decides where it
  // can buy; AFP decides how the money actually moves once both have said
  // yes. See packages/core/src/afp.ts for the routing/ledger design and
  // apps/api/src/rails/ for what each rail actually does.
  if (afp) {
    app.post("/v1/afp/intents", requireRole("member"), async (c) => {
      const holder = c.get("holder");
      const body = createIntentSchema.parse(await c.req.json());
      const intent = createAfpIntent({
        accountHolderId: holder.id,
        amount: body.amount,
        currency: body.currency,
        purpose: body.purpose,
        counterparty: body.counterparty,
        allowedRails: body.allowed_rails,
      });
      await afp.ledger.recordIntent(intent);

      const quotes = await Promise.all(afp.rails.map(async (rail) => ({ profile: rail.profile, quote: await rail.quote(intent) })));
      const decision = routeIntent(intent, quotes);
      return c.json({ intent, decision }, 201);
    });

    app.post("/v1/afp/intents/:id/execute", requireRole("member"), async (c) => {
      const holder = c.get("holder");
      let intent;
      try {
        intent = await afp.ledger.getIntent(c.req.param("id"));
      } catch {
        return c.json({ error: { code: "not_found", message: "intent not found" } }, 404);
      }
      // Scoped to the caller's own org — an intent id from another
      // account's session must 404, not reveal that it exists.
      if (intent.accountHolderId !== holder.id) {
        return c.json({ error: { code: "not_found", message: "intent not found" } }, 404);
      }

      const idempotencyKey = c.req.header("idempotency-key");
      if (!idempotencyKey) {
        return c.json(
          { error: { code: "idempotency_key_required", message: "an Idempotency-Key header is required to execute an AFP intent" } },
          400,
        );
      }
      // A repeat of a key already executed is a lookup, never a second
      // attempt — this is the actual double-execution guard, ahead of even
      // routing running again.
      const existing = await afp.ledger.getByIdempotencyKey(idempotencyKey);
      if (existing) return c.json({ transaction: existing });

      const body = executeIntentSchema.parse(await c.req.json().catch(() => ({})));
      const quotes = await Promise.all(afp.rails.map(async (rail) => ({ profile: rail.profile, quote: await rail.quote(intent) })));
      const decision = routeIntent(intent, quotes);
      const railId = body.rail ?? decision.chosenRail;
      const chosen = railId ? afp.rails.find((r) => r.profile.id === railId) : undefined;
      const wasOffered = railId ? decision.scored.some((s) => s.rail === railId) : false;
      if (!railId || !chosen || !wasOffered) {
        return c.json(
          { error: { code: "no_viable_rail", message: "no configured rail can carry this intent right now" }, rejected: decision.rejected },
          422,
        );
      }

      const tx = await afp.ledger.beginExecution(intent, railId, chosen.profile.finality, idempotencyKey);
      try {
        const result = await chosen.execute(intent);
        const completed = await afp.ledger.completeExecution(tx.id, result);
        return c.json({ transaction: completed }, 201);
      } catch (error) {
        if (error instanceof RailAmbiguousOutcomeError) {
          const parked = await afp.ledger.markReconciling(tx.id, error.message);
          return c.json(
            { transaction: parked, warning: "execution outcome is unknown and needs reconciliation before this can be retried" },
            202,
          );
        }
        const message = error instanceof Error ? error.message : String(error);
        const failed = await afp.ledger.markFailed(tx.id, message);
        return c.json({ transaction: failed, error: { code: "execution_failed", message } }, 402);
      }
    });

    app.get("/v1/afp/transactions", async (c) => {
      return c.json({ transactions: await afp.ledger.list(c.get("holder").id) });
    });
  }

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
