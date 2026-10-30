/**
 * Types for the A-CARD API, mirroring the documented response shapes in
 * docs/api/openapi.json. Requests are snake_case and responses camelCase —
 * that is the API's own convention, kept as-is so what you read here is what
 * crosses the wire.
 *
 * Every amount is an integer number of minor units (cents).
 */

export type Currency = "ZAR" | "USD" | "NGN" | "KES";

/** Every reason a card authorization can be declined. See docs/reference/errors.md#decline-reasons. */
export type DeclineReason =
  | "card_not_found"
  | "merchant_category_blocked_by_policy"
  | "card_closed"
  | "currency_mismatch"
  | "merchant_category_not_allowed"
  | "per_transaction_limit_exceeded"
  | "card_total_limit_exceeded"
  | "velocity_limit_exceeded"
  | "pending_human_approval"
  | "department_budget_exceeded"
  | "insufficient_funds";

export interface AccountHolder {
  id: string;
  email: string;
  name: string;
  currency: Currency;
  walletAccountId: string;
  subscriptionTier: "free" | "basic" | "pro" | "enterprise";
  accountType: "personal" | "enterprise";
  workosOrganizationId?: string;
  ssoDomain?: string;
  createdAt: string;
}

export interface WalletBalance {
  currency: Currency;
  /** Settled balance. */
  posted: number;
  /** Reserved by open authorizations. */
  held: number;
  /** posted − held. A charge beyond this is declined. */
  available: number;
}

export interface CardLimits {
  perTransaction?: number;
  total?: number;
  velocity?: { amount: number; windowSeconds: number };
}

export interface Card {
  id: string;
  accountHolderId: string;
  walletAccountId: string;
  departmentId?: string;
  currency: Currency;
  status: "active" | "closed";
  singleUse: boolean;
  limits: CardLimits;
  /** MCC allow-list. Empty means every category. */
  allowedMerchantCategories: string[];
  approvalThreshold?: number;
  /** Hosts this card may pay over x402. Unset = any host. */
  x402AllowedHosts?: string[];
  last4: string;
  expiryMonth: number;
  expiryYear: number;
  label?: string;
  issuerCardId?: string;
  createdAt: string;
  closedAt?: string;
  closeReason?: string;
}

/** Returned once, at creation. `sandboxPan` exists only in the sandbox. */
export interface CreatedCard extends Card {
  sandboxPan?: string;
}

export interface CardTransaction {
  id: string;
  cardId: string;
  accountHolderId: string;
  type: "authorization" | "capture" | "refund" | "declined";
  status: "pending" | "completed" | "declined" | "reversed";
  amount: number;
  currency: Currency;
  merchantName: string;
  merchantCategory: string;
  declineReason?: DeclineReason;
  approvalId?: string;
  ledgerTransactionId?: string;
  createdAt: string;
}

export interface Approval {
  id: string;
  cardId: string;
  accountHolderId: string;
  amount: number;
  currency: Currency;
  merchantName: string;
  merchantCategory: string;
  reason: "amount_requires_human_approval" | "amount_requires_org_approval" | (string & {});
  status: "pending" | "approved" | "denied" | "consumed";
  createdAt: string;
  decidedAt?: string;
  decidedBy?: string;
}

export interface PurchaseResult {
  authorization_id: string;
  approved: boolean;
  decline_reason?: DeclineReason;
  /** Set when the charge was held for a human. */
  approval_id?: string;
  wallet: WalletBalance;
}

export type Availability = "in_stock" | "low_stock" | "out_of_stock" | "made_to_order";

export interface CatalogItem {
  id: string;
  merchantId: string;
  sku: string;
  name: string;
  description?: string;
  unit: string;
  unitPriceCents: number;
  currency: Currency;
  availability: Availability;
  quantityAvailable?: number;
  leadTimeDays: number;
  /** When stock was last confirmed — not when the row was last edited. */
  inventoryUpdatedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface PublicMerchant {
  id: string;
  name: string;
  tradingName?: string;
  merchantCategoryCode: string;
  address: { addressLine: string; city: string; province: string; country: string; lat: number; lng: number };
  serviceRadiusKm: number;
  currency: Currency;
  status: "pending_kyb" | "verified" | "suspended";
  agentAccess: "open" | "allowlist";
  allowedAccountHolderIds: string[];
  /** Keyed by weekday "0" (Sunday) – "6". null = closed. Absent = unknown, reads as open. */
  operatingHours?: Record<string, { open: string; close: string } | null>;
  verified: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Offer {
  merchant: PublicMerchant;
  item: CatalogItem;
  quantity: number;
  unitPriceCents: number;
  totalCents: number;
  currency: Currency;
  distanceKm?: number;
  leadTimeDays: number;
  availability: Availability;
  inventoryAgeHours: number;
  /** fresh ≤ 24h, aging ≤ 7d, stale beyond. */
  freshness: "fresh" | "aging" | "stale";
  /** 0–1, deterministic. There is no paid placement. */
  score: number;
  matchReasons: string[];
}

export interface OfferSearchResult {
  offers: Offer[];
  considered: number;
  /** A capped sample of what was filtered out, each with a plain-language reason. */
  excluded: Array<{ merchantId: string; itemId?: string; reason: string }>;
}

export type OrderStatus = "placed" | "accepted" | "rejected" | "preparing" | "ready" | "dispatched" | "delivered" | "cancelled";

export interface Order {
  id: string;
  merchantId: string;
  accountHolderId: string;
  lines: Array<{ itemId: string; sku: string; name: string; unit: string; quantity: number; unitPriceCents: number; lineTotalCents: number }>;
  totalCents: number;
  currency: Currency;
  status: OrderStatus;
  fulfilment: {
    method: "collection" | "delivery";
    address?: string;
    neededBy?: string;
    promisedAt?: string;
    deliveredAt?: string;
    trackingReference?: string;
  };
  cardTransactionId?: string;
  note?: string;
  createdAt: string;
  updatedAt: string;
  history: Array<{ status: OrderStatus; at: string; by: "buyer" | "merchant"; note?: string }>;
}

// ---- request inputs ----------------------------------------------------------

export interface CreateCardInput {
  label?: string;
  currency?: Currency;
  department_id?: string;
  /** Defaults to true on the API: the card closes after its first capture. */
  single_use?: boolean;
  limits?: {
    per_transaction?: number;
    total?: number;
    velocity?: { amount: number; window_seconds: number };
  };
  allowed_merchant_categories?: string[];
  approval_threshold?: number;
  /** Hosts this card may pay over x402, e.g. `["api.example.com", ".example.org"]`. Unset = any host. */
  x402_allowed_hosts?: string[];
}

export interface X402PayInput {
  card_id: string;
  /** The resource to fetch. Must be https:// on a public host. */
  url: string;
  /** The most this one call may cost, in dollars as a decimal string (USDC has 6 decimals), e.g. "0.05". */
  max_usd: string;
  method?: "GET" | "POST";
  body?: unknown;
}

export interface X402Tab {
  card_id: string;
  payments: number;
  /** Exact USDC paid over x402, in atomic units (millionths of a dollar). */
  paid_atomic: string;
  paid_usd: string;
  /** Whole cents charged to the card for it. */
  charged_cents: number;
  /** Charged but not yet used, atomic units — what the next payment draws on first. */
  credit_atomic: string;
}

export interface X402PayResult {
  status: "paid" | "free" | "held" | "declined" | "failed" | "reconciling";
  decline_reason?: string;
  approval_id?: string;
  message?: string;
  price?: { amount_atomic: string; usd: string; network: string; asset: string; pay_to: string };
  charged_cents?: number;
  tab?: X402Tab;
  settlement?: { success: boolean; transaction?: string; network?: string; payer?: string; errorReason?: string };
  transaction?: Record<string, unknown>;
  resource?: { status: number; content_type?: string; bytes: number; body?: string; truncated?: boolean };
  replayed?: boolean;
}

export interface SimulatePurchaseInput {
  card_id: string;
  amount: number;
  currency?: Currency;
  merchant: { name: string; category?: string; country?: string };
}

export interface SearchOffersInput {
  q?: string;
  /** MCCs. Pass a card's allowedMerchantCategories to see only what it can pay for. */
  categories?: string[];
  lat?: number;
  lng?: number;
  radius_km?: number;
  quantity?: number;
  max_total_cents?: number;
  max_lead_time_days?: number;
  max_inventory_age_hours?: number;
  currency?: Currency;
  limit?: number;
}

export interface PlaceOrderInput {
  lines: Array<{ item_id: string; quantity: number }>;
  fulfilment: { method: "collection" | "delivery"; address?: string; needed_by?: string };
  card_transaction_id?: string;
  note?: string;
}

export interface SignupInput {
  email: string;
  name: string;
  currency?: Currency;
  account_type?: "personal" | "enterprise";
}

export interface SignupResult {
  account_holder: AccountHolder;
  /** Shown once. Store it securely. */
  api_key: string;
  api_key_id: string;
}

export interface RequestOptions {
  /**
   * Reuse the same key when retrying the same logical operation. If omitted
   * on a write, the SDK generates one per call and reuses it across its own
   * automatic retries, so a retried request can never apply twice.
   */
  idempotencyKey?: string;
  signal?: AbortSignal;
}
