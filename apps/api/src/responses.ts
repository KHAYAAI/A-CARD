import { z } from "zod";

/**
 * Response shapes for the public API's core resources.
 *
 * These exist for documentation (openapi.ts converts them to JSON Schema) and
 * are held honest by apps/api/test/openapi.test.ts, which drives real requests
 * through the app and parses every response with `.strict()` versions of these
 * — so a field added to a domain type without being documented here fails the
 * suite instead of silently going missing from the spec.
 *
 * Note the casing: request bodies are snake_case, responses are camelCase,
 * because responses serialize the domain objects in packages/core directly.
 * The spec documents that as it is rather than pretending otherwise.
 */

const currency = z.enum(["ZAR", "USD", "NGN", "KES"]);
const isoTime = z.string().describe("ISO 8601 timestamp");
const cents = z.number().int().describe("Integer minor units (cents)");

export const errorBody = z.object({
  error: z.object({
    code: z.string().describe("Stable, machine-readable error code — see docs/reference/errors.md"),
    message: z.string().describe("Human-readable explanation. Do not parse; it may change."),
    issues: z.array(z.unknown()).optional().describe("Validation issues, present on invalid_request"),
  }),
});

export const accountHolder = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  currency,
  walletAccountId: z.string(),
  subscriptionTier: z.enum(["free", "basic", "pro", "enterprise"]),
  accountType: z.enum(["personal", "enterprise"]),
  workosOrganizationId: z.string().optional(),
  ssoDomain: z.string().optional(),
  createdAt: isoTime,
});

export const walletBalance = z.object({
  currency,
  posted: cents.describe("Settled balance"),
  held: cents.describe("Reserved by open authorizations"),
  available: cents.describe("posted − held. A hold beyond this is refused."),
});

const cardLimits = z.object({
  perTransaction: cents.optional(),
  total: cents.optional(),
  velocity: z.object({ amount: cents, windowSeconds: z.number().int() }).optional(),
});

const cardFields = {
  id: z.string(),
  accountHolderId: z.string(),
  walletAccountId: z.string(),
  departmentId: z.string().optional(),
  currency,
  status: z.enum(["active", "closed"]),
  singleUse: z.boolean(),
  limits: cardLimits,
  allowedMerchantCategories: z.array(z.string()).describe("MCC allow-list. Empty means all categories."),
  approvalThreshold: cents.optional(),
  last4: z.string(),
  expiryMonth: z.number().int(),
  expiryYear: z.number().int(),
  label: z.string().optional(),
  issuerCardId: z.string().optional(),
  createdAt: isoTime,
  closedAt: isoTime.optional(),
  closeReason: z.string().optional(),
};

/** A card as returned by every read. */
export const card = z.object(cardFields);

/** A card as returned once, at creation, in the sandbox only. */
export const createdCard = z.object({
  ...cardFields,
  sandboxPan: z.string().optional().describe("Sandbox test PAN, returned only at creation and only in the sandbox. Real issuers host credentials; A-CARD never sees a PAN."),
});

export const cardTransaction = z.object({
  id: z.string(),
  cardId: z.string(),
  accountHolderId: z.string(),
  type: z.enum(["authorization", "capture", "refund", "declined"]),
  status: z.enum(["pending", "completed", "declined", "reversed"]),
  amount: cents,
  currency,
  merchantName: z.string(),
  merchantCategory: z.string(),
  declineReason: z.string().optional().describe("Present when declined — see the decline reason reference"),
  approvalId: z.string().optional(),
  ledgerTransactionId: z.string().optional(),
  createdAt: isoTime,
});

export const approval = z.object({
  id: z.string(),
  cardId: z.string(),
  accountHolderId: z.string(),
  amount: cents,
  currency,
  merchantName: z.string(),
  merchantCategory: z.string(),
  reason: z.string().describe("amount_requires_human_approval (card threshold) or amount_requires_org_approval (org policy)"),
  status: z.enum(["pending", "approved", "denied", "consumed"]),
  createdAt: isoTime,
  decidedAt: isoTime.optional(),
  decidedBy: z.string().optional(),
});

const availability = z.enum(["in_stock", "low_stock", "out_of_stock", "made_to_order"]);

export const catalogItem = z.object({
  id: z.string(),
  merchantId: z.string(),
  sku: z.string(),
  name: z.string(),
  description: z.string().optional(),
  unit: z.string(),
  unitPriceCents: cents,
  currency,
  availability,
  quantityAvailable: z.number().int().optional(),
  leadTimeDays: z.number().int(),
  inventoryUpdatedAt: isoTime.describe("When stock was last confirmed — not when the row was last edited"),
  createdAt: isoTime,
  updatedAt: isoTime,
});

const hoursWindow = z.union([z.object({ open: z.string(), close: z.string() }), z.null()]);

export const publicMerchant = z.object({
  id: z.string(),
  name: z.string(),
  tradingName: z.string().optional(),
  merchantCategoryCode: z.string(),
  address: z.object({
    addressLine: z.string(),
    city: z.string(),
    province: z.string(),
    country: z.string(),
    lat: z.number(),
    lng: z.number(),
  }),
  serviceRadiusKm: z.number(),
  currency,
  status: z.enum(["pending_kyb", "verified", "suspended"]),
  agentAccess: z.enum(["open", "allowlist"]),
  allowedAccountHolderIds: z.array(z.string()),
  operatingHours: z
    .record(z.string(), hoursWindow)
    .optional()
    .describe("Keyed by weekday 0 (Sunday) – 6. null = closed that day. Absent = unknown, which reads as open."),
  verified: z.boolean(),
  createdAt: isoTime,
  updatedAt: isoTime,
});

export const offer = z.object({
  merchant: publicMerchant,
  item: catalogItem,
  quantity: z.number().int(),
  unitPriceCents: cents,
  totalCents: cents,
  currency,
  distanceKm: z.number().optional(),
  leadTimeDays: z.number().int(),
  availability,
  inventoryAgeHours: z.number(),
  freshness: z.enum(["fresh", "aging", "stale"]).describe("fresh ≤ 24h, aging ≤ 7d, stale beyond"),
  score: z.number().describe("0–1, deterministic. No paid placement exists."),
  matchReasons: z.array(z.string()),
});

export const offerSearchResult = z.object({
  offers: z.array(offer),
  considered: z.number().int(),
  excluded: z
    .array(z.object({ merchantId: z.string(), itemId: z.string().optional(), reason: z.string() }))
    .describe("A capped sample of what was filtered out, each with a plain-language reason"),
});

const orderStatus = z.enum(["placed", "accepted", "rejected", "preparing", "ready", "dispatched", "delivered", "cancelled"]);

export const order = z.object({
  id: z.string(),
  merchantId: z.string(),
  accountHolderId: z.string(),
  lines: z.array(
    z.object({
      itemId: z.string(),
      sku: z.string(),
      name: z.string(),
      unit: z.string(),
      quantity: z.number().int(),
      unitPriceCents: cents,
      lineTotalCents: cents,
    }),
  ),
  totalCents: cents,
  currency,
  status: orderStatus,
  fulfilment: z.object({
    method: z.enum(["collection", "delivery"]),
    address: z.string().optional(),
    neededBy: z.string().optional(),
    promisedAt: z.string().optional(),
    deliveredAt: z.string().optional(),
    trackingReference: z.string().optional(),
  }),
  cardTransactionId: z.string().optional(),
  note: z.string().optional(),
  createdAt: isoTime,
  updatedAt: isoTime,
  history: z.array(
    z.object({ status: orderStatus, at: isoTime, by: z.enum(["buyer", "merchant"]), note: z.string().optional() }),
  ),
});

/** Every named component, in the order they appear in the spec. */
export const RESPONSE_COMPONENTS = {
  Error: errorBody,
  AccountHolder: accountHolder,
  WalletBalance: walletBalance,
  Card: card,
  CreatedCard: createdCard,
  CardTransaction: cardTransaction,
  Approval: approval,
  CatalogItem: catalogItem,
  PublicMerchant: publicMerchant,
  Offer: offer,
  OfferSearchResult: offerSearchResult,
  Order: order,
} as const;

export type ResponseComponent = keyof typeof RESPONSE_COMPONENTS;
