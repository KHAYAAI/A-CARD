import { z } from "zod";

/**
 * Request schemas for every REST route, in one module so the OpenAPI
 * generator (openapi.ts) documents exactly what app.ts validates — the spec
 * cannot drift from the validator because they are the same objects.
 */

export const currencySchema = z.enum(["ZAR", "USD", "NGN", "KES"]);

export const accountTypeSchema = z.enum(["personal", "enterprise"]);

export const registerSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1),
  password: z.string().min(8),
  currency: currencySchema.optional(),
  account_type: accountTypeSchema.optional(),
});

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  account_holder_id: z.string().optional(),
});

export const mfaVerifySchema = z.object({
  challenge_token: z.string().min(1),
  code: z.string().min(1),
});

export const mfaCodeSchema = z.object({ code: z.string().min(1) });

export const mfaDisableSchema = z.object({ password: z.string().min(1), code: z.string().min(1) });

export const ssoSetupSchema = z.object({
  /** Override the domain routed to this org's SSO connection; defaults to the caller's own email domain. */
  domain: z.string().min(1).optional(),
});

export const ssoAuthorizeSchema = z.object({ email: z.string().email() });

export const issueKeySchema = z.object({
  name: z.string().default("api key"),
  scope: z.enum(["full", "read_only"]).default("full"),
  /** Cumulative card budget this key may provision, in minor units. */
  spend_cap_cents: z.number().int().positive().optional(),
});

export const addMemberSchema = z.object({
  email: z.string().email(),
  name: z.string().optional(),
  password: z.string().min(8).optional(),
  role: z.enum(["owner", "admin", "member", "viewer"]),
});

export const signupSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1),
  currency: currencySchema.optional(),
  account_type: accountTypeSchema.optional(),
});

export const departmentSchema = z.object({
  name: z.string().min(1),
  monthly_budget: z.number().int().positive(),
  lead: z.string().optional(),
});

export const policySchema = z.object({
  blocked_merchant_categories: z.array(z.string()).default([]),
  approval_threshold: z.number().int().positive().optional(),
});

export const chainSchema = z.enum(["ethereum", "polygon", "solana"]);

export const linkWalletSchema = z.object({
  chain: chainSchema,
  address: z.string().min(1),
  connector: z.enum(["metamask", "walletconnect", "coinbase", "other"]),
  label: z.string().optional(),
});

export const fundSchema = z.object({
  amount: z.number().int().positive(),
  currency: currencySchema.optional(),
  reference: z.string().optional(),
});

export const payfastCheckoutSchema = z.object({
  amount: z.number().int().positive(),
});

export const createCardSchema = z.object({
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
  x402_allowed_hosts: z.array(z.string().min(1).max(253)).max(50).optional(),
});

export const simulateAuthSchema = z.object({
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

export const issuerEventSchema = z.object({
  id: z.string(),
  type: z.enum(["authorization.request", "transaction.capture", "authorization.reversal"]),
  data: z.record(z.unknown()),
});


// ---- A-MERCHANT ------------------------------------------------------------

export const addressSchema = z.object({
  addressLine: z.string().min(1),
  city: z.string().min(1),
  province: z.string().min(1),
  country: z.string().min(1).default("ZA"),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

export const agentAccessSchema = z.enum(["open", "allowlist"]);
export const availabilitySchema = z.enum(["in_stock", "low_stock", "out_of_stock", "made_to_order"]);

export const registerMerchantSchema = z.object({
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

export const kybDecisionSchema = z.object({
  status: z.enum(["pending_kyb", "verified", "suspended"]),
  note: z.string().optional(),
});

export const updateMerchantSchema = z.object({
  name: z.string().min(1).optional(),
  trading_name: z.string().optional(),
  address: addressSchema.optional(),
  service_radius_km: z.number().min(0).optional(),
  agent_access: agentAccessSchema.optional(),
  allowed_account_holder_ids: z.array(z.string()).optional(),
  merchant_category_code: z.string().min(3).optional(),
});

export const upsertItemSchema = z.object({
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

export const restateSchema = z.object({
  availability: availabilitySchema,
  quantity_available: z.number().int().nonnegative().optional(),
});

export const reportPurchaseSchema = z.object({
  item_id: z.string(),
  quantity: z.number().int().positive(),
  /** Evidence the merchant can reconcile against their own statement — not a payment this platform settles. */
  card_transaction_id: z.string().optional(),
});

export const acknowledgePurchaseSchema = z.object({
  note: z.string().max(500).optional(),
  /** Optional, and the whole point — see the route comment. */
  restate: restateSchema.optional(),
});

export const disputePurchaseSchema = z.object({
  note: z.string().min(1).max(500),
});

export const screenWalletSchema = z.object({
  address: z.string().min(1),
  chain: z.enum(["BTC", "ETH", "LTC", "XRP", "BCH", "DOGE", "TRX", "SOL", "MATIC", "BNB", "USDT", "USDC"]),
  direction: z.enum(["inbound", "outbound"]).optional(),
});

export const inboundTransferSchema = z.object({
  txid: z.string().min(1),
  wallet_address: z.string().min(1),
  chain: z.string().optional(),
  currency: z.string().optional(),
  amount: z.string().optional(),
  originating_vasp: z.object({ name: z.string().optional(), lei: z.string().optional(), travel_address: z.string().optional() }).optional(),
});

export const placeOrderSchema = z.object({
  lines: z.array(z.object({ item_id: z.string(), quantity: z.number().int().positive() })).min(1).max(100),
  fulfilment: z.object({
    method: z.enum(["collection", "delivery"]),
    address: z.string().optional(),
    needed_by: z.string().optional(),
  }),
  card_transaction_id: z.string().optional(),
  note: z.string().max(500).optional(),
});

export const advanceOrderSchema = z.object({
  status: z.enum(["accepted", "rejected", "preparing", "ready", "dispatched", "delivered"]),
  note: z.string().max(500).optional(),
  promised_at: z.string().optional(),
  tracking_reference: z.string().max(120).optional(),
});

export const merchantWebhookSchema = z.object({
  url: z.string().url(),
  events: z.array(z.string()).max(20).optional(),
});

export const operatingHoursSchema = z.record(
  z.enum(["0", "1", "2", "3", "4", "5", "6"]),
  z.union([z.object({ open: z.string(), close: z.string() }), z.null()]),
);

export const merchantApiKeySchema = z.object({
  name: z.string().min(1).max(80),
  scope: z.enum(["read_only", "read_write"]).optional(),
});

/**
 * A POS sync speaks in the merchant's OWN SKUs, never A-CARD's internal item
 * ids — the integrating system has no reason to learn a second identifier for
 * something it already names.
 */
export const catalogSyncSchema = z.object({
  items: z
    .array(
      z.object({
        sku: z.string().min(1),
        name: z.string().min(1),
        description: z.string().optional(),
        unit: z.string().optional(),
        unit_price_cents: z.number().int().nonnegative(),
        currency: currencySchema.optional(),
        availability: availabilitySchema.optional(),
        quantity_available: z.number().int().nonnegative().optional(),
        lead_time_days: z.number().int().nonnegative().optional(),
      }),
    )
    .min(1)
    .max(500),
});

export const bulkRestateSchema = z.object({
  items: z
    .array(
      z.object({
        sku: z.string().min(1),
        availability: availabilitySchema,
        quantity_available: z.number().int().nonnegative().optional(),
      }),
    )
    .min(1)
    .max(500),
});

export const blocklistEntrySchema = z.object({
  entry_type: z.enum(["user", "business", "email", "phone", "document", "ip_address"]),
  value: z.string().min(1),
  reason: z.string().max(500).optional(),
});

export const monitorTransactionSchema = z.object({
  transaction_id: z.string().min(1),
  card_id: z.string().min(1),
  amount: z.number().int().positive(),
  currency: currencySchema,
  merchant_name: z.string().min(1),
  merchant_category: z.string().min(1),
  merchant_country: z.string().optional(),
  occurred_at: z.string().optional(),
});

export const complianceOverrideSchema = z.object({
  status: z.enum(["approved", "declined"]),
  reason: z.string().min(1).max(500),
});

export const amlScreenSchema = z.object({
  full_name: z.string().min(1),
  entity_type: z.enum(["person", "company"]).optional(),
  date_of_birth: z.string().optional(),
  /** ISO 3166-1 alpha-2. Alpha-3 is rejected by the provider. */
  nationality: z.string().length(2).optional(),
  include_adverse_media: z.boolean().optional(),
  ongoing_monitoring: z.boolean().optional(),
});

export const searchQuerySchema = z.object({
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

export const portalInviteSchema = z.object({ role: z.enum(["owner", "staff"]).optional() });

export const railIdSchema = z.enum(["card", "x402", "stablecoin"]);
export const createIntentSchema = z.object({
  amount: z.number().int().positive(),
  currency: currencySchema,
  purpose: z.string().min(1),
  counterparty: z.string().min(1),
  allowed_rails: z.array(railIdSchema).optional(),
});
export const executeIntentSchema = z.object({ rail: railIdSchema.optional() });

export const x402PaySchema = z.object({
  card_id: z.string().min(1),
  url: z.string().url().max(2048),
  /** The most the agent agrees to pay, in US dollars as a decimal string (USDC has 6 decimals). */
  max_usd: z.string().regex(/^\d+(\.\d{1,6})?$/, "a dollar amount such as \"0.05\""),
  method: z.enum(["GET", "POST"]).optional(),
  body: z.unknown().optional(),
});

export const KYB_DOCUMENT_TYPES = ["application/pdf", "image/jpeg", "image/png"] as const;
export const requestUploadSchema = z.object({
  filename: z.string().min(1).max(200),
  content_type: z.enum(KYB_DOCUMENT_TYPES),
});
export const confirmUploadSchema = z.object({
  key: z.string().min(1),
  filename: z.string().min(1).max(200),
  content_type: z.enum(KYB_DOCUMENT_TYPES),
});
