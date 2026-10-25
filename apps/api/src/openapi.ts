import { z, type ZodTypeAny } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import * as S from "./schemas.js";
import { RESPONSE_COMPONENTS, type ResponseComponent } from "./responses.js";

/**
 * The OpenAPI 3.1 document for the public REST API.
 *
 * Request bodies come straight from the zod schemas app.ts validates with
 * (schemas.ts), so a request shape cannot drift from its validator. Every
 * route is listed in ROUTES below, and apps/api/test/openapi.test.ts fails if
 * a route exists in the app but not here, or here but not in the app.
 *
 * Responses: the core resources (cards, wallets, transactions, approvals,
 * offers, orders, merchants) are fully typed and checked against real
 * responses in that same test. The long tail of operator, portal, and
 * compliance routes documents its response envelope key but not every field —
 * stated in each description rather than implied by an empty schema.
 */

export const API_VERSION = "1.0.0";

type Method = "get" | "post" | "put" | "patch" | "delete";
type Auth = "none" | "tenant" | "merchant_session" | "merchant_key" | "issuer_signature" | "payfast_itn" | "compliance_signature";
type Role = "viewer" | "member" | "admin" | "owner";
type Requires = "merchants" | "merchant_portal" | "kyb_documents" | "afp" | "compliance" | "crypto_compliance" | "workos";

interface Resp {
  /** Top-level key the payload is wrapped in, e.g. `card` in `{ card: {...} }`. */
  key?: string;
  /** Named component for that key's value. */
  ref?: ResponseComponent;
  array?: boolean;
  /** Any extra top-level keys returned alongside, documented loosely. */
  also?: Record<string, ZodTypeAny>;
  /** A complete inline schema instead of the key/ref shorthand. */
  schema?: ZodTypeAny;
  status?: number;
  description?: string;
}

export interface RouteDoc {
  method: Method;
  path: string;
  tag: string;
  summary: string;
  description?: string;
  auth: Auth;
  role?: Role;
  merchantOwner?: boolean;
  merchantWrite?: boolean;
  body?: ZodTypeAny;
  query?: Record<string, { schema: ZodTypeAny; description?: string; required?: boolean }>;
  idempotent?: boolean;
  response?: Resp;
  requires?: Requires;
}

const str = z.string();
const num = z.number();
const statusQ = (values: readonly [string, ...string[]]) => ({ status: { schema: z.enum(values) } });

const r = (method: Method, path: string, tag: string, summary: string, rest: Omit<RouteDoc, "method" | "path" | "tag" | "summary">): RouteDoc => ({
  method,
  path,
  tag,
  summary,
  ...rest,
});

export const ROUTES: RouteDoc[] = [
  // ---- meta ----------------------------------------------------------------------
  r("get", "/health", "Meta", "Liveness check", { auth: "none", response: { schema: z.object({ ok: z.boolean(), service: str }) } }),
  r("get", "/openapi.json", "Meta", "This OpenAPI document", { auth: "none", response: { schema: z.object({}).passthrough() } }),

  // ---- onboarding ------------------------------------------------------------------
  r("post", "/v1/signup", "Onboarding", "Create an organization and its first API key", {
    auth: "none",
    description:
      "Returns the API key secret exactly once — store it. Funding and card issuance may require completed verification when the deployment enforces compliance.",
    body: S.signupSchema,
    response: {
      status: 201,
      schema: z.object({
        account_holder: RESPONSE_COMPONENTS.AccountHolder,
        api_key: str.describe("Secret, prefixed ak_. Shown once."),
        api_key_id: str,
      }),
    },
  }),

  // ---- auth (dashboard humans) ------------------------------------------------------
  r("post", "/v1/auth/register", "Auth", "Register a human user and organization", { auth: "none", body: S.registerSchema, response: { status: 201, key: "account_holder", ref: "AccountHolder", also: { session_token: str, user: z.object({}).passthrough() } } }),
  r("post", "/v1/auth/login", "Auth", "Log in with email and password", { auth: "none", body: S.loginSchema, description: "Returns a session, or `mfa_required` with a challenge token when TOTP is enabled.", response: { schema: z.object({}).passthrough() } }),
  r("post", "/v1/auth/mfa/verify", "Auth", "Complete an MFA challenge", { auth: "none", body: S.mfaVerifySchema, response: { schema: z.object({}).passthrough() } }),
  r("post", "/v1/auth/sso/authorize", "Auth", "Start SSO login for an email's domain", { auth: "none", body: S.ssoAuthorizeSchema, requires: "workos", response: { schema: z.object({ redirect_url: str }) } }),
  r("get", "/v1/auth/sso/callback", "Auth", "SSO callback (redirect target)", { auth: "none", requires: "workos", query: { code: { schema: str, required: true } }, response: { schema: z.object({ session_token: str }).partial(), description: "Redirects to the dashboard with a session when one is configured" } }),
  r("get", "/v1/auth/me", "Auth", "The current principal", { auth: "tenant", response: { key: "account_holder", ref: "AccountHolder", also: { user: z.unknown(), role: str } } }),
  r("post", "/v1/auth/mfa/setup", "Auth", "Begin TOTP enrolment", { auth: "tenant", response: { schema: z.object({}).passthrough() } }),
  r("post", "/v1/auth/mfa/enable", "Auth", "Confirm TOTP enrolment", { auth: "tenant", body: S.mfaCodeSchema, response: { schema: z.object({ enabled: z.boolean() }) } }),
  r("post", "/v1/auth/mfa/disable", "Auth", "Turn TOTP off", { auth: "tenant", body: S.mfaDisableSchema, response: { schema: z.object({ enabled: z.boolean() }) } }),
  r("post", "/v1/auth/logout", "Auth", "End the current session", { auth: "tenant", response: { schema: z.object({ ok: z.boolean() }) } }),

  // ---- team ------------------------------------------------------------------------
  r("get", "/v1/auth/members", "Team", "List organization members", { auth: "tenant", role: "admin", response: { key: "members", schema: z.object({ members: z.array(z.unknown()) }) } }),
  r("post", "/v1/auth/members", "Team", "Add a member with a role", { auth: "tenant", role: "admin", body: S.addMemberSchema, response: { status: 201, schema: z.object({}).passthrough() } }),

  // ---- enterprise --------------------------------------------------------------------
  r("get", "/v1/departments", "Enterprise", "List departments and their budgets", { auth: "tenant", response: { schema: z.object({ departments: z.array(z.unknown()) }) } }),
  r("post", "/v1/departments", "Enterprise", "Create a department with a monthly budget", { auth: "tenant", role: "admin", body: S.departmentSchema, response: { status: 201, schema: z.object({ department: z.unknown() }) } }),
  r("patch", "/v1/departments/{id}", "Enterprise", "Update a department", { auth: "tenant", role: "admin", body: S.departmentSchema.partial(), response: { schema: z.object({ department: z.unknown() }) } }),
  r("get", "/v1/policy", "Enterprise", "Read org policy", { auth: "tenant", response: { schema: z.object({ policy: z.unknown() }) } }),
  r("put", "/v1/policy", "Enterprise", "Replace org policy", { auth: "tenant", role: "admin", body: S.policySchema, description: "Blocked categories are enforced ahead of every per-card rule; the approval threshold routes charges to a human even when a card has none.", response: { schema: z.object({ policy: z.unknown() }) } }),
  r("get", "/v1/audit", "Enterprise", "Every authorization decision, with its reason", { auth: "tenant", response: { key: "audit", ref: "CardTransaction", array: true } }),

  // ---- wallets -------------------------------------------------------------------------
  r("get", "/v1/wallet", "Wallets", "Wallet balances", {
    auth: "tenant",
    query: { currency: { schema: S.currencySchema, description: "Which wallet to return as `wallet`. Defaults to the org's primary currency." } },
    response: { key: "wallet", ref: "WalletBalance", also: { wallets: z.array(RESPONSE_COMPONENTS.WalletBalance) } },
  }),
  r("post", "/v1/wallet/fund", "Wallets", "Fund a wallet (sandbox instant credit)", {
    auth: "tenant",
    role: "member",
    idempotent: true,
    body: S.fundSchema,
    description: "Instant credit, for the sandbox and for non-ZAR currencies. When real ZAR funding is configured this returns `instant_funding_disabled` for ZAR — use `/v1/wallet/fund/checkout`.",
    response: { status: 201, key: "wallet", ref: "WalletBalance", also: { wallets: z.array(RESPONSE_COMPONENTS.WalletBalance), ledger_transaction: z.unknown() } },
  }),
  r("post", "/v1/wallet/fund/checkout", "Wallets", "Start a real ZAR top-up via PayFast", { auth: "tenant", role: "member", idempotent: true, body: S.payfastCheckoutSchema, response: { schema: z.object({ action: str, fields: z.record(str) }).partial(), description: "A form action and signed fields to post to PayFast. The wallet is credited only when PayFast confirms settlement." } }),
  r("get", "/v1/wallets/crypto", "Wallets", "List linked crypto wallets", { auth: "tenant", response: { schema: z.object({ wallets: z.array(z.unknown()) }) } }),
  r("post", "/v1/wallets/crypto/link", "Wallets", "Link an external crypto wallet", { auth: "tenant", role: "member", idempotent: true, body: S.linkWalletSchema, response: { status: 201, schema: z.object({}).passthrough() } }),
  r("post", "/v1/wallets/crypto/{id}/default", "Wallets", "Make a linked wallet the default", { auth: "tenant", role: "member", idempotent: true, response: { schema: z.object({}).passthrough() } }),
  r("delete", "/v1/wallets/crypto/{id}", "Wallets", "Unlink a crypto wallet", { auth: "tenant", role: "member", response: { schema: z.object({ ok: z.boolean() }) } }),

  // ---- cards -----------------------------------------------------------------------------
  r("post", "/v1/cards", "Cards", "Issue a virtual card", {
    auth: "tenant",
    role: "member",
    idempotent: true,
    body: S.createCardSchema,
    description:
      "Every limit is in integer minor units of the card's currency. Single-use cards close after their first capture. In the sandbox the response carries a test PAN once; with a real issuer the card is provisioned there and linked, and a provisioning failure closes the card and returns `issuer_provisioning_failed`.",
    response: { status: 201, key: "card", ref: "CreatedCard" },
  }),
  r("get", "/v1/cards", "Cards", "List cards", { auth: "tenant", response: { key: "cards", ref: "Card", array: true } }),
  r("get", "/v1/cards/{id}", "Cards", "Get a card", { auth: "tenant", response: { key: "card", ref: "Card" } }),
  r("post", "/v1/cards/{id}/close", "Cards", "Close a card", { auth: "tenant", role: "member", idempotent: true, response: { key: "card", ref: "Card" } }),

  // ---- transactions & approvals -----------------------------------------------------------
  r("get", "/v1/transactions", "Transactions", "List card transactions", { auth: "tenant", query: { card_id: { schema: str } }, response: { key: "transactions", ref: "CardTransaction", array: true } }),
  r("get", "/v1/approvals", "Approvals", "List approval requests", { auth: "tenant", query: statusQ(["pending", "approved", "denied", "consumed"]), response: { key: "approvals", ref: "Approval", array: true } }),
  r("post", "/v1/approvals/{id}/approve", "Approvals", "Approve a held charge", {
    auth: "tenant",
    role: "member",
    idempotent: true,
    description: "Mints a single-use grant for this card and merchant, up to the approved amount. The agent's retried authorization consumes it; a second identical charge is held again.",
    response: { key: "approval", ref: "Approval" },
  }),
  r("post", "/v1/approvals/{id}/deny", "Approvals", "Deny a held charge", { auth: "tenant", role: "member", idempotent: true, response: { key: "approval", ref: "Approval" } }),

  // ---- keys, sso, billing --------------------------------------------------------------------
  r("post", "/v1/keys", "API keys", "Issue an API key", { auth: "tenant", role: "admin", idempotent: true, body: S.issueKeySchema, description: "`read_only` keys resolve to exactly the viewer role. `spend_cap_cents` limits the cumulative card budget this key may provision.", response: { status: 201, schema: z.object({ api_key: str, key: z.unknown() }).partial() } }),
  r("get", "/v1/keys", "API keys", "List API keys", { auth: "tenant", role: "admin", response: { schema: z.object({ keys: z.array(z.unknown()) }) } }),
  r("delete", "/v1/keys/{id}", "API keys", "Revoke an API key", { auth: "tenant", role: "admin", response: { schema: z.object({ revoked: z.boolean() }).passthrough() } }),
  r("post", "/v1/sso/setup", "SSO", "Start SSO setup for this organization", { auth: "tenant", role: "owner", idempotent: true, requires: "workos", body: S.ssoSetupSchema, response: { schema: z.object({ portal_url: str }) } }),
  r("get", "/v1/billing/plans", "Billing", "Subscription plans and their limits", { auth: "tenant", response: { schema: z.object({ plans: z.record(z.unknown()) }) } }),
  r("post", "/v1/billing/checkout", "Billing", "Start a subscription upgrade via PayFast", { auth: "tenant", role: "admin", idempotent: true, response: { schema: z.object({}).passthrough() } }),

  // ---- inbound webhooks -------------------------------------------------------------------------
  r("post", "/webhooks/issuer", "Inbound webhooks", "Card issuer events (real-time authorization)", {
    auth: "issuer_signature",
    description:
      "Called by the issuing partner. `authorization.request` must be answered inside the network's ~2-second window and returns the decision; `transaction.capture` settles a hold; `authorization.reversal` releases one. See docs/reference/webhooks.md.",
    response: { schema: z.object({ approved: z.boolean(), decline_reason: str, approval_id: str, received: z.boolean() }).partial() },
  }),
  r("post", "/webhooks/payfast", "Inbound webhooks", "PayFast ITN (payment notification)", { auth: "payfast_itn", description: "Form-encoded. Validated by signature, source, and confirm-back to PayFast before any wallet is credited.", response: { schema: z.object({ received: z.boolean() }) } }),
  r("post", "/webhooks/compliance", "Inbound webhooks", "Verification provider decisions", { auth: "compliance_signature", requires: "compliance", response: { schema: z.object({ received: z.boolean(), matched: z.boolean() }).partial() } }),

  // ---- sandbox ------------------------------------------------------------------------------------
  r("post", "/v1/simulate/purchase", "Sandbox", "Simulate a purchase through the real authorization path", {
    auth: "tenant",
    role: "member",
    idempotent: true,
    body: S.simulateAuthSchema,
    description:
      "Plays the card issuer: builds a signed `authorization.request` and feeds it through `/webhooks/issuer`, then captures it when approved. What you test here is the production decision path.",
    response: {
      schema: z.object({
        authorization_id: str,
        approved: z.boolean(),
        decline_reason: str.optional().describe("See the decline reason reference"),
        approval_id: str.optional().describe("Set when the charge was held for a human"),
        wallet: RESPONSE_COMPONENTS.WalletBalance,
      }),
    },
  }),

  // ---- A-MERCHANT: discovery & buying -----------------------------------------------------------------
  r("get", "/v1/merchants/search", "A-MERCHANT", "Search verified supply", {
    auth: "tenant",
    requires: "merchants",
    description: "Returns ranked offers with a score breakdown, and a sample of what was excluded and why. Only verified merchants are ever returned. There is no paid placement.",
    query: {
      q: { schema: str, description: "Free-text item search" },
      categories: { schema: str, description: "Comma-separated MCCs. Pass a card's allowed_merchant_categories to see only what that card can pay for." },
      lat: { schema: num },
      lng: { schema: num },
      radius_km: { schema: num, description: "Defaults to 25 when lat/lng are given" },
      quantity: { schema: z.number().int() },
      max_total_cents: { schema: z.number().int() },
      max_lead_time_days: { schema: z.number().int() },
      max_inventory_age_hours: { schema: num, description: "Refuse offers whose stock was confirmed longer ago than this" },
      currency: { schema: S.currencySchema },
      limit: { schema: z.number().int().max(100) },
    },
    response: { ref: "OfferSearchResult" },
  }),
  r("get", "/v1/merchants", "A-MERCHANT", "List merchants", { auth: "tenant", requires: "merchants", query: statusQ(["pending_kyb", "verified", "suspended"]), response: { key: "merchants", ref: "PublicMerchant", array: true } }),
  r("get", "/v1/merchants/{id}", "A-MERCHANT", "Get a merchant, its catalogue and reliability", { auth: "tenant", requires: "merchants", response: { key: "merchant", ref: "PublicMerchant", also: { items: z.array(RESPONSE_COMPONENTS.CatalogItem), reliability: z.unknown() } } }),
  r("get", "/v1/merchants/{id}/health", "A-MERCHANT", "Catalogue freshness health", { auth: "tenant", requires: "merchants", response: { schema: z.object({ items: num, fresh: num, aging: num, stale: num, medianInventoryAgeHours: num }).passthrough() } }),
  r("post", "/v1/merchants/{id}/orders", "A-MERCHANT", "Place an order with a merchant", {
    auth: "tenant",
    role: "member",
    idempotent: true,
    requires: "merchants",
    body: S.placeOrderSchema,
    description: "Lines are priced from the catalogue, never the caller. No money moves through an order — pay by card as usual and pass `card_transaction_id` as evidence. The merchant's system is notified by signed webhook.",
    response: { status: 201, key: "order", ref: "Order" },
  }),
  r("get", "/v1/orders", "A-MERCHANT", "Your orders, across every merchant", { auth: "tenant", requires: "merchants", response: { key: "orders", ref: "Order", array: true } }),
  r("get", "/v1/orders/{id}", "A-MERCHANT", "Get an order", { auth: "tenant", requires: "merchants", response: { key: "order", ref: "Order" } }),
  r("post", "/v1/orders/{id}/cancel", "A-MERCHANT", "Cancel an order you placed", { auth: "tenant", role: "member", idempotent: true, requires: "merchants", response: { key: "order", ref: "Order" } }),
  r("post", "/v1/merchants/{id}/purchases", "A-MERCHANT", "Report a purchase to a merchant", { auth: "tenant", role: "member", idempotent: true, requires: "merchants", body: S.reportPurchaseSchema, description: "Tells the merchant a sale happened so they can restate stock. Records a claim; it never decrements stock or moves money.", response: { status: 201, schema: z.object({ purchase: z.unknown() }) } }),
  r("get", "/v1/purchases", "A-MERCHANT", "Your reported purchases", { auth: "tenant", requires: "merchants", response: { schema: z.object({ purchases: z.array(z.unknown()) }) } }),

  // ---- A-MERCHANT: operator ----------------------------------------------------------------------------
  r("post", "/v1/merchants", "Merchant operations", "Register a merchant", { auth: "tenant", role: "admin", idempotent: true, requires: "merchants", body: S.registerMerchantSchema, response: { status: 201, schema: z.object({ merchant: z.unknown() }) } }),
  r("patch", "/v1/merchants/{id}", "Merchant operations", "Update a merchant's profile", { auth: "tenant", role: "admin", requires: "merchants", body: S.updateMerchantSchema, response: { schema: z.object({ merchant: z.unknown() }) } }),
  r("post", "/v1/merchants/{id}/kyb", "Merchant operations", "Record a KYB decision", { auth: "tenant", role: "admin", idempotent: true, requires: "merchants", body: S.kybDecisionSchema, description: "Merchants are invisible to agents until verified.", response: { schema: z.object({ merchant: z.unknown() }) } }),
  r("post", "/v1/merchants/{id}/portal-invites", "Merchant operations", "Create a merchant portal invite", { auth: "tenant", role: "admin", idempotent: true, requires: "merchant_portal", body: S.portalInviteSchema, response: { status: 201, schema: z.object({}).passthrough() } }),
  r("get", "/v1/merchants/{id}/portal-invites", "Merchant operations", "List a merchant's portal invites", { auth: "tenant", role: "admin", requires: "merchant_portal", response: { schema: z.object({ invites: z.array(z.unknown()) }) } }),
  r("post", "/v1/merchants/{id}/kyb-documents", "Merchant operations", "Request a KYB document upload URL", { auth: "tenant", role: "admin", idempotent: true, requires: "kyb_documents", body: S.requestUploadSchema, response: { schema: z.object({}).passthrough() } }),
  r("post", "/v1/merchants/{id}/kyb-documents/confirm", "Merchant operations", "Confirm an uploaded KYB document", { auth: "tenant", role: "admin", idempotent: true, requires: "kyb_documents", body: S.confirmUploadSchema, response: { schema: z.object({}).passthrough() } }),
  r("get", "/v1/merchants/{id}/kyb-documents", "Merchant operations", "List KYB documents", { auth: "tenant", role: "admin", requires: "kyb_documents", response: { schema: z.object({}).passthrough() } }),
  r("put", "/v1/merchants/{id}/items", "Merchant operations", "Create or update a catalogue item", { auth: "tenant", role: "member", requires: "merchants", body: S.upsertItemSchema, response: { key: "item", ref: "CatalogItem" } }),
  r("post", "/v1/merchants/{id}/items/{itemId}/restate", "Merchant operations", "Restate an item's stock", { auth: "tenant", role: "member", idempotent: true, requires: "merchants", body: S.restateSchema, response: { key: "item", ref: "CatalogItem" } }),
  r("delete", "/v1/merchants/{id}/items/{itemId}", "Merchant operations", "Remove a catalogue item", { auth: "tenant", role: "member", requires: "merchants", response: { schema: z.object({ deleted: z.boolean() }) } }),
  r("get", "/v1/merchants/{id}/purchases", "Merchant operations", "A merchant's purchase notices", { auth: "tenant", role: "admin", requires: "merchants", response: { schema: z.object({ purchases: z.array(z.unknown()) }) } }),

  // ---- merchant portal (merchant humans) ------------------------------------------------------------------
  r("get", "/v1/merchant-auth/authorize", "Merchant portal", "Begin merchant login from an invite", { auth: "none", requires: "merchant_portal", query: { invite: { schema: str } }, response: { schema: z.object({}).passthrough(), description: "Redirects to WorkOS AuthKit" } }),
  r("get", "/v1/merchant-auth/callback", "Merchant portal", "Merchant login callback", { auth: "none", requires: "merchant_portal", query: { code: { schema: str }, state: { schema: str } }, response: { schema: z.object({ portal_token: str }).partial(), description: "Redirects to the portal with a session" } }),
  r("post", "/v1/merchant-portal/logout", "Merchant portal", "End the merchant session", { auth: "merchant_session", requires: "merchant_portal", response: { schema: z.object({ ok: z.boolean() }) } }),
  r("get", "/v1/merchant-portal/me", "Merchant portal", "Current merchant user and shop", { auth: "merchant_session", requires: "merchant_portal", response: { schema: z.object({}).passthrough() } }),
  r("get", "/v1/merchant-portal/items", "Merchant portal", "Your catalogue", { auth: "merchant_session", requires: "merchant_portal", response: { key: "items", ref: "CatalogItem", array: true } }),
  r("put", "/v1/merchant-portal/items", "Merchant portal", "Create or update an item", { auth: "merchant_session", requires: "merchant_portal", body: S.upsertItemSchema, response: { key: "item", ref: "CatalogItem" } }),
  r("post", "/v1/merchant-portal/items/{itemId}/restate", "Merchant portal", "Restate an item's stock", { auth: "merchant_session", requires: "merchant_portal", body: S.restateSchema, response: { key: "item", ref: "CatalogItem" } }),
  r("delete", "/v1/merchant-portal/items/{itemId}", "Merchant portal", "Remove an item", { auth: "merchant_session", requires: "merchant_portal", response: { schema: z.object({ deleted: z.boolean() }) } }),
  r("get", "/v1/merchant-portal/health", "Merchant portal", "Catalogue freshness health", { auth: "merchant_session", requires: "merchant_portal", response: { schema: z.object({}).passthrough() } }),
  r("get", "/v1/merchant-portal/orders", "Merchant portal", "Orders placed with your shop", { auth: "merchant_session", requires: "merchant_portal", query: statusQ(["placed", "accepted", "rejected", "preparing", "ready", "dispatched", "delivered", "cancelled"]), response: { key: "orders", ref: "Order", array: true } }),
  r("post", "/v1/merchant-portal/orders/{id}/advance", "Merchant portal", "Move an order forward", { auth: "merchant_session", requires: "merchant_portal", body: S.advanceOrderSchema, description: "Illegal transitions are refused with `invalid_state`.", response: { key: "order", ref: "Order" } }),
  r("get", "/v1/merchant-portal/reliability", "Merchant portal", "Your reliability score and its confidence", { auth: "merchant_session", requires: "merchant_portal", response: { schema: z.object({ reliability: z.unknown() }) } }),
  r("get", "/v1/merchant-portal/purchases", "Merchant portal", "Purchase notices for your shop", { auth: "merchant_session", requires: "merchant_portal", query: statusQ(["pending", "acknowledged", "disputed"]), response: { schema: z.object({ purchases: z.array(z.unknown()) }) } }),
  r("post", "/v1/merchant-portal/purchases/{id}/acknowledge", "Merchant portal", "Confirm a sale, optionally restating stock", { auth: "merchant_session", requires: "merchant_portal", body: S.acknowledgePurchaseSchema, response: { schema: z.object({ purchase: z.unknown() }) } }),
  r("post", "/v1/merchant-portal/purchases/{id}/dispute", "Merchant portal", "Dispute a reported sale", { auth: "merchant_session", requires: "merchant_portal", body: S.disputePurchaseSchema, response: { schema: z.object({ purchase: z.unknown() }) } }),
  r("get", "/v1/merchant-portal/team", "Merchant portal", "Your staff and invites", { auth: "merchant_session", merchantOwner: true, requires: "merchant_portal", response: { schema: z.object({}).passthrough() } }),
  r("put", "/v1/merchant-portal/hours", "Merchant portal", "Set operating hours", { auth: "merchant_session", merchantOwner: true, requires: "merchant_portal", body: S.operatingHoursSchema, response: { schema: z.object({ merchant: z.unknown() }) } }),
  r("get", "/v1/merchant-portal/api-keys", "Merchant portal", "List your machine API keys", { auth: "merchant_session", merchantOwner: true, requires: "merchant_portal", response: { schema: z.object({ api_keys: z.array(z.unknown()) }) } }),
  r("post", "/v1/merchant-portal/api-keys", "Merchant portal", "Create a machine API key for your POS or ERP", { auth: "merchant_session", merchantOwner: true, requires: "merchant_portal", body: S.merchantApiKeySchema, description: "The `mk_live_` secret is returned once and stored only as a hash.", response: { status: 201, schema: z.object({ api_key: z.unknown(), secret: str }).partial() } }),
  r("delete", "/v1/merchant-portal/api-keys/{id}", "Merchant portal", "Revoke a machine API key", { auth: "merchant_session", merchantOwner: true, requires: "merchant_portal", response: { schema: z.object({ api_key: z.unknown() }) } }),
  r("post", "/v1/merchant-portal/team/invites", "Merchant portal", "Invite staff to your shop", { auth: "merchant_session", merchantOwner: true, requires: "merchant_portal", body: S.portalInviteSchema, response: { status: 201, schema: z.object({}).passthrough() } }),

  // ---- merchant API (machine) --------------------------------------------------------------------------------
  r("get", "/v1/merchant-api/me", "Merchant API", "Identity, catalogue health and pending sales", { auth: "merchant_key", requires: "merchants", response: { schema: z.object({}).passthrough() } }),
  r("get", "/v1/merchant-api/catalog", "Merchant API", "Your catalogue", { auth: "merchant_key", requires: "merchants", response: { key: "items", ref: "CatalogItem", array: true } }),
  r("put", "/v1/merchant-api/catalog", "Merchant API", "Bulk upsert by SKU", { auth: "merchant_key", merchantWrite: true, requires: "merchants", body: S.catalogSyncSchema, description: "Idempotent by your own SKU. Returns 207 with a per-SKU breakdown when some rows fail, so one bad row never discards the rest.", response: { schema: z.object({ synced: num }).passthrough() } }),
  r("post", "/v1/merchant-api/stock", "Merchant API", "Bulk stock restate by SKU", { auth: "merchant_key", merchantWrite: true, requires: "merchants", body: S.bulkRestateSchema, response: { schema: z.object({ restated: num }).passthrough() } }),
  r("get", "/v1/merchant-api/orders", "Merchant API", "Orders placed with you", { auth: "merchant_key", requires: "merchants", query: statusQ(["placed", "accepted", "rejected", "preparing", "ready", "dispatched", "delivered", "cancelled"]), response: { key: "orders", ref: "Order", array: true } }),
  r("post", "/v1/merchant-api/orders/{id}/advance", "Merchant API", "Move an order forward", { auth: "merchant_key", merchantWrite: true, requires: "merchants", body: S.advanceOrderSchema, response: { key: "order", ref: "Order" } }),
  r("put", "/v1/merchant-api/webhook", "Merchant API", "Register your webhook endpoint", { auth: "merchant_key", merchantWrite: true, requires: "merchants", body: S.merchantWebhookSchema, description: "Returns the signing secret once. Events are signed with the same `t=…,v1=…` scheme as every other A-CARD webhook.", response: { schema: z.object({ webhook: z.unknown(), secret: str }).partial() } }),
  r("delete", "/v1/merchant-api/webhook", "Merchant API", "Remove your webhook endpoint", { auth: "merchant_key", merchantWrite: true, requires: "merchants", response: { schema: z.object({ cleared: z.boolean() }) } }),
  r("post", "/v1/merchant-api/orders/{id}/redeliver", "Merchant API", "Redeliver an order event to your webhook", { auth: "merchant_key", merchantWrite: true, requires: "merchants", response: { schema: z.object({ redelivered: z.boolean() }).passthrough() } }),
  r("get", "/v1/merchant-api/reliability", "Merchant API", "Your reliability score", { auth: "merchant_key", requires: "merchants", response: { schema: z.object({ reliability: z.unknown() }) } }),
  r("get", "/v1/merchant-api/purchases", "Merchant API", "Purchase notices to reconcile against your till", { auth: "merchant_key", requires: "merchants", query: statusQ(["pending", "acknowledged", "disputed"]), response: { schema: z.object({ purchases: z.array(z.unknown()) }) } }),
  r("post", "/v1/merchant-api/purchases/{id}/acknowledge", "Merchant API", "Confirm a sale", { auth: "merchant_key", merchantWrite: true, requires: "merchants", body: S.acknowledgePurchaseSchema, response: { schema: z.object({ purchase: z.unknown() }) } }),

  // ---- AFP ----------------------------------------------------------------------------------------------------
  r("post", "/v1/afp/intents", "AFP", "Route a payment intent (moves nothing)", { auth: "tenant", role: "member", idempotent: true, requires: "afp", body: S.createIntentSchema, description: "Scores every eligible rail on cost, speed and finality and returns the decision with reasons. Nothing executes.", response: { status: 201, schema: z.object({}).passthrough() } }),
  r("post", "/v1/afp/intents/{id}/execute", "AFP", "Execute a routed intent", {
    auth: "tenant",
    role: "member",
    requires: "afp",
    body: S.executeIntentSchema,
    description:
      "Requires an `Idempotency-Key` header (`idempotency_key_required` otherwise) — enforced by a unique index, so a retry after a timeout is a lookup, never a second payment. An ambiguous rail outcome parks the transaction as `reconciling` rather than guessing.",
    response: { schema: z.object({ transaction: z.unknown() }) },
  }),
  r("get", "/v1/afp/transactions", "AFP", "Your AFP ledger", { auth: "tenant", requires: "afp", response: { schema: z.object({ transactions: z.array(z.unknown()) }) } }),

  // ---- compliance -----------------------------------------------------------------------------------------------
  r("post", "/v1/compliance/verify", "Compliance", "Start identity or business verification", { auth: "tenant", role: "admin", idempotent: true, requires: "compliance", response: { schema: z.object({ verification: z.unknown() }).passthrough() } }),
  r("get", "/v1/compliance/me", "Compliance", "Your verification status", { auth: "tenant", requires: "compliance", response: { schema: z.object({}).passthrough() } }),
  r("post", "/v1/compliance/merchants/{id}/verify", "Compliance", "Start KYB for a merchant", { auth: "tenant", role: "admin", idempotent: true, requires: "compliance", response: { schema: z.object({ verification: z.unknown() }).passthrough() } }),
  r("get", "/v1/compliance/queue", "Compliance", "Verifications awaiting review", { auth: "tenant", role: "admin", requires: "compliance", response: { schema: z.object({ verifications: z.array(z.unknown()) }) } }),
  r("get", "/v1/compliance/verifications", "Compliance", "List verifications", { auth: "tenant", role: "admin", requires: "compliance", query: { subject: { schema: str } }, response: { schema: z.object({ verifications: z.array(z.unknown()) }) } }),
  r("post", "/v1/compliance/verifications/{id}/override", "Compliance", "Record an attributed human override", { auth: "tenant", role: "admin", idempotent: true, requires: "compliance", body: S.complianceOverrideSchema, description: "Stored alongside the provider's decision, never over it.", response: { schema: z.object({ verification: z.unknown() }) } }),
  r("post", "/v1/compliance/aml/screen", "Compliance", "Screen a name against sanctions, PEP and adverse media", { auth: "tenant", role: "admin", idempotent: true, requires: "compliance", body: S.amlScreenSchema, response: { schema: z.object({}).passthrough() } }),
  r("get", "/v1/compliance/registry/search", "Compliance", "Search a company registry", { auth: "tenant", role: "admin", requires: "compliance", query: { country_code: { schema: str, required: true }, name: { schema: str }, registration_number: { schema: str } }, response: { schema: z.object({ candidates: z.array(z.unknown()) }) } }),
  r("get", "/v1/compliance/registry/{candidateId}", "Compliance", "Fetch a registry record", { auth: "tenant", role: "admin", requires: "compliance", response: { schema: z.object({ company: z.unknown() }) } }),
  r("get", "/v1/compliance/cases", "Compliance", "Open compliance cases", { auth: "tenant", role: "admin", requires: "compliance", query: { status: { schema: str } }, response: { schema: z.object({ cases: z.array(z.unknown()) }) } }),
  r("get", "/v1/compliance/cases/{caseId}", "Compliance", "Get a case", { auth: "tenant", role: "admin", requires: "compliance", response: { schema: z.object({ case: z.unknown() }) } }),
  r("get", "/v1/compliance/blocklist", "Compliance", "Blocklist entries", { auth: "tenant", role: "admin", requires: "compliance", response: { schema: z.object({ entries: z.array(z.unknown()) }) } }),
  r("post", "/v1/compliance/blocklist", "Compliance", "Add a blocklist entry", { auth: "tenant", role: "admin", idempotent: true, requires: "compliance", body: S.blocklistEntrySchema, response: { status: 201, schema: z.object({}).passthrough() } }),
  r("get", "/v1/compliance/crypto/status", "Compliance", "Whether Travel Rule and wallet screening are active, and why", { auth: "tenant", role: "admin", requires: "compliance", response: { schema: z.object({}).passthrough() } }),
  r("post", "/v1/compliance/crypto/screen", "Compliance", "Screen a crypto wallet address", { auth: "tenant", role: "admin", idempotent: true, requires: "crypto_compliance", body: S.screenWalletSchema, response: { schema: z.object({}).passthrough() } }),
  r("get", "/v1/compliance/crypto/vasps", "Compliance", "Search Travel Rule counterparties", { auth: "tenant", role: "admin", requires: "crypto_compliance", query: { search: { schema: str } }, response: { schema: z.object({ vasps: z.array(z.unknown()) }) } }),
  r("post", "/v1/compliance/crypto/inbound", "Compliance", "Register an inbound transfer for Travel Rule", { auth: "tenant", role: "admin", idempotent: true, requires: "crypto_compliance", body: S.inboundTransferSchema, response: { schema: z.object({}).passthrough() } }),
  r("post", "/v1/compliance/transactions", "Compliance", "Submit a transaction for AML monitoring", { auth: "tenant", role: "admin", idempotent: true, requires: "compliance", body: S.monitorTransactionSchema, response: { schema: z.object({}).passthrough() } }),
];

// ---- builder ---------------------------------------------------------------------------

const REQUIRES_TEXT: Record<Requires, string> = {
  merchants: "Mounted when the A-MERCHANT directory is configured.",
  merchant_portal: "Mounted when the merchant portal (WorkOS AuthKit) is configured.",
  kyb_documents: "Mounted when KYB document storage is configured.",
  afp: "Mounted only when AFP is explicitly enabled (ACARD_ENABLE_AFP=true).",
  compliance: "Mounted when compliance is enabled (ACARD_ENABLE_COMPLIANCE=true).",
  crypto_compliance: "Mounted when crypto compliance is configured. Inert while AFP's crypto rails are sandboxed.",
  workos: "Requires WorkOS SSO to be configured; returns `sso_not_configured` otherwise.",
};

const SECURITY: Record<Auth, Array<Record<string, string[]>>> = {
  none: [],
  tenant: [{ apiKey: [] }, { session: [] }],
  merchant_session: [{ merchantSession: [] }],
  merchant_key: [{ merchantKey: [] }],
  issuer_signature: [{ webhookSignature: [] }],
  payfast_itn: [],
  compliance_signature: [],
};

function toJson(schema: ZodTypeAny): Record<string, unknown> {
  const json = zodToJsonSchema(schema, { target: "jsonSchema7", $refStrategy: "none" }) as Record<string, unknown>;
  delete json.$schema;
  return json;
}

function responseSchema(resp: Resp): Record<string, unknown> {
  if (resp.schema) return toJson(resp.schema);
  // A ref with no wrapping key: the whole body is that component.
  if (resp.ref && !resp.key) return { $ref: `#/components/schemas/${resp.ref}` };
  const properties: Record<string, unknown> = {};
  if (resp.key && resp.ref) {
    const ref = { $ref: `#/components/schemas/${resp.ref}` };
    properties[resp.key] = resp.array ? { type: "array", items: ref } : ref;
  }
  for (const [k, v] of Object.entries(resp.also ?? {})) properties[k] = toJson(v);
  return { type: "object", properties, required: resp.key ? [resp.key] : [] };
}

function pathParams(path: string) {
  return [...path.matchAll(/\{([A-Za-z]+)\}/g)].map((m) => ({
    name: m[1],
    in: "path",
    required: true,
    schema: { type: "string" },
  }));
}

export function buildOpenApi(): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const route of ROUTES) {
    const notes: string[] = [];
    if (route.description) notes.push(route.description);
    if (route.role) notes.push(`Requires the \`${route.role}\` role or higher. Read-only API keys act as \`viewer\`.`);
    if (route.merchantOwner) notes.push("Requires the shop `owner` role; staff receive `forbidden`.");
    if (route.merchantWrite) notes.push("Requires a `read_write` merchant key; a `read_only` key receives `forbidden`.");
    if (route.idempotent) notes.push("Accepts an `Idempotency-Key` header: a repeat with the same body replays the original response; a different body returns `idempotency_conflict`.");
    if (route.requires) notes.push(REQUIRES_TEXT[route.requires]);

    const resp = route.response ?? { schema: z.object({}).passthrough() };
    const status = String(resp.status ?? 200);
    const errorRef = { $ref: "#/components/responses/Error" };

    const parameters: unknown[] = [...pathParams(route.path)];
    for (const [name, q] of Object.entries(route.query ?? {})) {
      parameters.push({ name, in: "query", required: q.required ?? false, description: q.description, schema: toJson(q.schema) });
    }
    if (route.idempotent || route.path.endsWith("/execute")) {
      parameters.push({
        name: "Idempotency-Key",
        in: "header",
        required: route.path.endsWith("/execute"),
        schema: { type: "string" },
      });
    }

    const operation: Record<string, unknown> = {
      operationId: operationId(route),
      tags: [route.tag],
      summary: route.summary,
      description: notes.join("\n\n") || undefined,
      security: SECURITY[route.auth],
      parameters: parameters.length ? parameters : undefined,
      responses: {
        [status]: {
          description: resp.description ?? "Success",
          content: { "application/json": { schema: responseSchema(resp) } },
        },
        ...errorResponses(route),
        default: errorRef,
      },
    };
    if (route.body) {
      operation.requestBody = { required: true, content: { "application/json": { schema: toJson(route.body) } } };
    }
    if (route.role) operation["x-acard-min-role"] = route.role;
    if (route.requires) operation["x-acard-requires"] = route.requires;

    (paths[route.path] ??= {})[route.method] = operation;
  }

  const schemas: Record<string, unknown> = {};
  for (const [name, schema] of Object.entries(RESPONSE_COMPONENTS)) schemas[name] = toJson(schema);

  return {
    openapi: "3.1.0",
    info: {
      title: "A-CARD API",
      license: { name: "Proprietary" },
      version: API_VERSION,
      description: [
        "Spending infrastructure for AI agents: scoped virtual cards, a double-entry ledger, human approvals, the A-MERCHANT supply directory, and AFP payment routing.",
        "",
        "**Conventions.** Amounts are integer minor units (cents) everywhere. Request bodies are snake_case; responses serialize domain objects and are camelCase. Every error has the shape `{ error: { code, message } }` — branch on `code`, never on `message`.",
        "",
        "**Versioning.** The `/v1` prefix is the API version. Additive changes ship without notice; breaking changes get a new prefix. See docs/versioning.md.",
      ].join("\n"),
    },
    servers: [
      { url: "http://localhost:8787", description: "Local sandbox (`npm run dev:api`)" },
      { url: "https://{host}", description: "Your deployment", variables: { host: { default: "your-api-host" } } },
    ],
    tags: [...new Set(ROUTES.map((route) => route.tag))].map((name) => ({ name, description: TAG_DESCRIPTIONS[name] })),
    paths,
    components: {
      securitySchemes: {
        apiKey: { type: "http", scheme: "bearer", description: "Tenant API key, `ak_…`. Full programmatic access, or viewer-only for read_only keys." },
        session: { type: "http", scheme: "bearer", description: "Human session, `sess_…` (or the httpOnly `acard_session` cookie). Permissions follow the user's role." },
        merchantSession: { type: "apiKey", in: "cookie", name: "acard_merchant_session", description: "Merchant portal session (a bearer merchant session token is also accepted)." },
        merchantKey: { type: "http", scheme: "bearer", description: "Merchant machine key, `mk_live_…`. Scoped to one merchant; can never reach a wallet or card." },
        webhookSignature: { type: "apiKey", in: "header", name: "x-acard-signature", description: "`t=<unix>,v1=<hex HMAC-SHA256 of \"t.rawBody\">`" },
      },
      responses: {
        Error: {
          description: "Error. See docs/reference/errors.md for every code.",
          content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
        },
      },
      schemas,
    },
  };
}

/** Which error statuses an operation can genuinely return, derived from how it is guarded. */
function errorResponses(route: RouteDoc): Record<string, unknown> {
  const ref = { $ref: "#/components/responses/Error" };
  const out: Record<string, unknown> = {};
  if (route.body || route.query) out["400"] = ref;
  if (route.auth !== "none") out["401"] = ref;
  if (route.role || route.merchantOwner || route.merchantWrite || route.auth === "tenant") out["403"] = ref;
  if (route.path.includes("{")) out["404"] = ref;
  if (route.idempotent) out["409"] = ref;
  return out;
}

const TAG_DESCRIPTIONS: Record<string, string> = {
  Meta: "Health and this document.",
  Onboarding: "Create an organization and get an API key.",
  Auth: "Human login, sessions, MFA and SSO for the dashboard.",
  Team: "Members and roles: owner > admin > member > viewer.",
  Enterprise: "Departments with monthly budgets, org-wide policy, and the audit log.",
  Wallets: "Prepaid balances per currency, and linked crypto wallets.",
  Cards: "Scoped virtual cards with limits, category rules and approval thresholds.",
  Transactions: "Every authorization, capture and decline, with reason codes.",
  Approvals: "Charges held for a human, and the single-use grants approvals mint.",
  "API keys": "Programmatic credentials, full or read-only.",
  SSO: "Federate an organization to its own identity provider.",
  Billing: "Subscription plans and upgrades.",
  "Inbound webhooks": "Endpoints other systems call: the card issuer, PayFast, and the verification provider.",
  Sandbox: "Exercise the real authorization path without a card network.",
  "A-MERCHANT": "Agent-facing supply discovery, merchant detail, orders and purchase notices.",
  "Merchant operations": "Operator-side merchant onboarding, KYB and catalogue management.",
  "Merchant portal": "A merchant's own staff, signed in through the portal.",
  "Merchant API": "A merchant's POS or ERP, authenticated with an mk_live_ machine key.",
  AFP: "Payment intents routed across rails by cost, speed and finality. Disabled unless explicitly enabled.",
  Compliance: "KYC, KYB, AML screening, cases, blocklists and transaction monitoring.",
};

function operationId(route: RouteDoc): string {
  const words = route.path
    .replace(/^\/v1\//, "")
    .replace(/^\//, "")
    .split(/[/-]/)
    .filter(Boolean)
    .map((part) => (part.startsWith("{") ? `by_${part.slice(1, -1)}` : part));
  return [route.method, ...words].join("_").replace(/[^A-Za-z0-9_]/g, "_");
}

/** Hono-style path (`/v1/cards/:id`) for a spec path (`/v1/cards/{id}`). */
export function toHonoPath(path: string): string {
  return path.replace(/\{([A-Za-z]+)\}/g, ":$1");
}
