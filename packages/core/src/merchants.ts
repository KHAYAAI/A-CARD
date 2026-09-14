import { DomainError, InvalidStateError, NotFoundError } from "./errors.js";
import { newId } from "./ids.js";
import type { Currency } from "./money.js";

/**
 * A-MERCHANT — the supply side.
 *
 * This is the *read side* only: merchant profiles, catalogs, inventory state,
 * and the discovery query an agent runs to find something buyable. It
 * deliberately contains no orders, no payment acceptance, and no settlement.
 * Payment continues to run through A-CARD's existing card flow, so nothing
 * here holds a merchant's money — which is what keeps this layer outside
 * funds-custody territory and outside PCI scope.
 *
 * Two design decisions are worth reading before changing anything:
 *
 * 1. **Inventory freshness is a first-class field, not metadata.** The real
 *    risk to this product is not the API — it is a hardware store whose stock
 *    count is a person's memory. An agent that orders 500 bags of cement
 *    against a three-week-old number produces a failed order and a dead
 *    merchant relationship. So every item records when its inventory was last
 *    touched, every offer reports that age, and staleness is scored against.
 *    You cannot fix bad catalog data in code, but you can refuse to hide it.
 *
 * 2. **Exclusions are reported, not swallowed.** A search that returns nothing
 *    says why it returned nothing, the same way an A-CARD decline carries its
 *    real reason instead of a generic failure.
 */

// ---- freshness -------------------------------------------------------------

/** Inventory touched within this window is trusted without qualification. */
export const FRESH_INVENTORY_HOURS = 24;
/** Beyond this, an item is stale: still discoverable, but heavily downranked. */
export const AGING_INVENTORY_HOURS = 24 * 7;

export type Freshness = "fresh" | "aging" | "stale";

export function classifyFreshness(ageHours: number): Freshness {
  if (ageHours <= FRESH_INVENTORY_HOURS) return "fresh";
  if (ageHours <= AGING_INVENTORY_HOURS) return "aging";
  return "stale";
}

// ---- merchants -------------------------------------------------------------

/**
 * `pending_kyb` merchants are invisible to agents. Verification here is an
 * intake record, not an adjudication — the platform stores what was submitted
 * and who signed it off. Onboarding a business that turns out to be laundering
 * is an existential event, so this field gates discovery rather than
 * decorating a profile.
 */
export type MerchantStatus = "pending_kyb" | "verified" | "suspended";

/** `open` merchants accept any authorized agent; `allowlist` names the orgs. */
export type AgentAccess = "open" | "allowlist";

export interface GeoPoint {
  lat: number;
  lng: number;
}

export interface MerchantAddress extends GeoPoint {
  addressLine: string;
  city: string;
  province: string;
  country: string;
}

/** A single uploaded registration document — the file itself lives in object storage; this is only the reference. */
export interface KybDocument {
  /** Storage key (S3 object key in production). Opaque to this module — it never fetches or serves the bytes. */
  key: string;
  filename: string;
  contentType: string;
  uploadedBy: string;
  uploadedAt: string;
}

/** What the merchant submitted for verification. Never exposed to agents. */
export interface KybRecord {
  registrationNumber: string;
  vatNumber?: string;
  contactEmail: string;
  contactPhone?: string;
  submittedAt: string;
  reviewedAt?: string;
  reviewedBy?: string;
  note?: string;
  documents: KybDocument[];
}

/**
 * When a merchant is actually open, keyed 0 (Sunday) to 6 (Saturday).
 * `null` for a day means closed. Times are local "HH:MM" in the merchant's
 * own wall clock — deliberately not timestamps: a shop's hours are a
 * recurring local fact, and storing them as instants makes every read a
 * timezone bug waiting to happen.
 */
export type OperatingHours = Partial<Record<0 | 1 | 2 | 3 | 4 | 5 | 6, { open: string; close: string } | null>>;

/** Is the merchant open at this local time? Unknown hours count as open — see `isOpenAt`. */
export function isOpenAt(hours: OperatingHours | undefined, at: Date): boolean {
  // A merchant who has not published hours is treated as open rather than
  // closed. Excluding an offer because nobody filled in a form would punish
  // exactly the low-digitisation merchants this layer exists to reach.
  if (!hours || Object.keys(hours).length === 0) return true;
  const day = at.getDay() as 0 | 1 | 2 | 3 | 4 | 5 | 6;
  const window = hours[day];
  if (window === null) return false;
  if (!window) return true;
  const minutes = at.getHours() * 60 + at.getMinutes();
  const toMinutes = (hhmm: string) => {
    const [h, m] = hhmm.split(":").map(Number);
    return (h ?? 0) * 60 + (m ?? 0);
  };
  return minutes >= toMinutes(window.open) && minutes < toMinutes(window.close);
}

export interface Merchant {
  id: string;
  name: string;
  tradingName?: string;
  /** MCC — the same code space A-CARD's card rules allow or deny. */
  merchantCategoryCode: string;
  address: MerchantAddress;
  /** How far this merchant will deliver, in km. 0 = collection only. */
  serviceRadiusKm: number;
  currency: Currency;
  status: MerchantStatus;
  kyb: KybRecord;
  agentAccess: AgentAccess;
  /** Account holder ids permitted to transact when `agentAccess` is allowlist. */
  allowedAccountHolderIds: string[];
  /** When this merchant is open. Absent means "unknown", which reads as open. */
  operatingHours?: OperatingHours;
  /** Where this merchant's own system wants orders pushed. See `MerchantWebhook`. */
  webhook?: MerchantWebhook;
  createdAt: string;
  updatedAt: string;
}

/**
 * Where a merchant's POS or ERP wants to be told about orders.
 *
 * Outbound push rather than polling, because the integration that matters is
 * a till that needs to print a docket the moment an order lands — a merchant
 * polling every five minutes is a merchant who finds out five minutes late.
 * Signed with the same HMAC scheme as A-CARD's own issuer webhook, so a
 * merchant integrating both verifies them the same way.
 */
export interface MerchantWebhook {
  url: string;
  /** Stored as a hash; the plaintext is returned once at registration. */
  hashedSecret: string;
  /** Events this endpoint wants. Empty means all of them. */
  events: string[];
  createdAt: string;
  lastDeliveryAt?: string;
  lastDeliveryOk?: boolean;
  /** Consecutive failures. A merchant whose endpoint has been dead for days should be visible. */
  consecutiveFailures: number;
}

/**
 * The agent-facing view. Strips the KYB record entirely: an agent needs to
 * know a merchant is verified, never the registration number, VAT number, or
 * contact details behind that verification.
 */
export type PublicMerchant = Omit<Merchant, "kyb" | "webhook"> & { verified: boolean };

export function publicMerchant(merchant: Merchant): PublicMerchant {
  // `webhook` is stripped alongside `kyb`: it carries a secret hash and the
  // merchant's internal endpoint, neither of which is an agent's business.
  // Destructured out rather than picked, so a field added to Merchant later
  // is visible-by-default and has to be *chosen* to be hidden — the reverse
  // would silently expose the next secret somebody adds.
  const { kyb: _kyb, webhook: _webhook, ...rest } = merchant;
  return { ...rest, verified: merchant.status === "verified" };
}

// ---- catalog ---------------------------------------------------------------

export type Availability = "in_stock" | "low_stock" | "out_of_stock" | "made_to_order";

export interface CatalogItem {
  id: string;
  merchantId: string;
  /** The merchant's own reference, unique within that merchant. */
  sku: string;
  name: string;
  description?: string;
  /** Unit of sale as the merchant states it: "bag", "each", "litre", "hour". */
  unit: string;
  unitPriceCents: number;
  currency: Currency;
  availability: Availability;
  /** Units on hand, when the merchant tracks a number rather than a state. */
  quantityAvailable?: number;
  /** Days from order to delivery/collection. 0 = same day. */
  leadTimeDays: number;
  /**
   * When availability/quantity was last confirmed — *not* when the row was
   * last written. Editing a price does not make a stock count fresh.
   */
  inventoryUpdatedAt: string;
  createdAt: string;
  updatedAt: string;
}

// ---- discovery -------------------------------------------------------------

export interface OfferQuery {
  /** Free-text match against item name, description, and SKU. */
  text?: string;
  /** Restrict to these MCCs — pass a card's allow-list to only find what it can pay for. */
  merchantCategoryCodes?: string[];
  near?: { lat: number; lng: number; radiusKm: number };
  /** Units wanted. Drives total price and the stock check. Default 1. */
  quantity?: number;
  /** Budget ceiling for the whole line, in minor units. */
  maxTotalCents?: number;
  maxLeadTimeDays?: number;
  currency?: Currency;
  /** Reject items whose inventory has not been confirmed this recently. */
  maxInventoryAgeHours?: number;
  /** The account holder asking, checked against merchant allow-lists. */
  requestedBy?: string;
  limit?: number;
}

export interface Offer {
  merchant: PublicMerchant;
  item: CatalogItem;
  quantity: number;
  unitPriceCents: number;
  totalCents: number;
  currency: Currency;
  /** Straight-line km from the query point, when one was given. */
  distanceKm?: number;
  leadTimeDays: number;
  availability: Availability;
  inventoryAgeHours: number;
  freshness: Freshness;
  /** 0–1, higher is better. Deterministic; see `OFFER_WEIGHTS`. */
  score: number;
  /** Plain-language reasons this offer ranked where it did. */
  matchReasons: string[];
}

/** Why a candidate did not make the result set. */
export interface OfferExclusion {
  merchantId: string;
  itemId?: string;
  reason: string;
}

export interface OfferSearchResult {
  offers: Offer[];
  /** Catalog items examined before filtering. */
  considered: number;
  /** Capped sample of what was filtered out, and why. */
  excluded: OfferExclusion[];
}

/**
 * Ranking weights. Exported so they are tunable and testable rather than
 * buried as magic numbers — an agent choosing a supplier should be able to
 * explain the choice to the human who owns the budget.
 */
export const OFFER_WEIGHTS = {
  price: 0.4,
  leadTime: 0.25,
  distance: 0.2,
  freshness: 0.15,
} as const;

const FRESHNESS_SCORE: Record<Freshness, number> = { fresh: 1, aging: 0.6, stale: 0.15 };

const MAX_EXCLUSIONS_REPORTED = 25;

/** Great-circle distance in km. */
export function distanceKm(a: GeoPoint, b: GeoPoint): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function hoursSince(iso: string, now: number): number {
  return Math.max(0, (now - Date.parse(iso)) / 3_600_000);
}

// ---- inputs ----------------------------------------------------------------

export interface RegisterMerchantInput {
  name: string;
  tradingName?: string;
  merchantCategoryCode: string;
  address: MerchantAddress;
  serviceRadiusKm?: number;
  currency?: Currency;
  agentAccess?: AgentAccess;
  allowedAccountHolderIds?: string[];
  kyb: Omit<KybRecord, "submittedAt" | "reviewedAt" | "reviewedBy" | "documents">;
}

export interface UpsertItemInput {
  sku: string;
  name: string;
  description?: string;
  unit?: string;
  unitPriceCents: number;
  currency?: Currency;
  availability?: Availability;
  quantityAvailable?: number;
  leadTimeDays?: number;
}

// ---- purchase notices ------------------------------------------------------

/**
 * The feedback loop, and the narrowest thing that could close it.
 *
 * Discovery without this is a one-way mirror: an agent finds an offer, pays
 * for it with an ordinary A-CARD card, and the merchant never learns the sale
 * happened. That is not just a missing feature — it undermines the mechanic
 * the whole product rests on, because a merchant with no evidence that anyone
 * is buying has no reason to keep restating stock, and stale stock is the one
 * thing this directory exists to prevent.
 *
 * A `PurchaseNotice` is a *claim by the buyer that a purchase occurred*. It is
 * deliberately NOT an order, and this platform is deliberately not in the
 * middle of it:
 *
 *   - No money moves here. Payment already happened, on a card, between the
 *     buyer and the merchant's own acquirer. `cardTransactionId` is evidence
 *     the merchant can reconcile against their own statement, not a payment
 *     this platform settles, holds, or remits. Funds custody stays out of
 *     scope exactly as it was before.
 *   - No stock is decremented automatically. A buyer's claim is a claim; only
 *     the merchant knows whether they actually fulfilled it. Silently mutating
 *     a merchant's stock count from an unverified assertion would corrupt the
 *     data honesty this directory is built to protect. The merchant confirms,
 *     and confirming is the moment they restate — which is the entire point.
 *   - No dispute resolution. `disputed` records that the merchant says this
 *     did not happen as described. Who is right is a conversation between two
 *     businesses, not a state machine this platform adjudicates.
 */
export type PurchaseNoticeStatus = "reported" | "acknowledged" | "disputed";

export interface PurchaseNotice {
  id: string;
  merchantId: string;
  itemId: string;
  /**
   * SKU, name and unit are copied in rather than joined on read: a notice has
   * to still read correctly months later, after the item has been repriced,
   * renamed, or deleted outright. What was bought is a historical fact.
   */
  sku: string;
  itemName: string;
  unit: string;
  /** The A-CARD organisation that bought. Scopes the buyer's own view. */
  accountHolderId: string;
  quantity: number;
  unitPriceCents: number;
  totalCents: number;
  currency: Currency;
  /** The buyer's card transaction, when they supplied one — evidence, not a settlement link. */
  cardTransactionId?: string;
  status: PurchaseNoticeStatus;
  /** The merchant's own words when acknowledging or disputing. */
  note?: string;
  reportedAt: string;
  resolvedAt?: string;
}

// ---- orders and fulfilment -------------------------------------------------

/**
 * An order is a *request to fulfil*, placed before the goods move — which is
 * what makes it different from a `PurchaseNotice`, a claim recorded after the
 * fact. Both exist on purpose: an agent buying over the counter reports a
 * notice; an agent asking a supplier to prepare 500 bags places an order.
 *
 * What this deliberately is NOT:
 *
 *   - **Not an escrow.** No money moves through an order. The agent pays by
 *     card exactly as before, and `cardTransactionId` is evidence the merchant
 *     reconciles against their own statement. Funds custody stays out of scope,
 *     which is the boundary the whole layer is built around.
 *   - **Not a stock reservation.** Placing an order does not decrement
 *     anything. A-CARD is not the stock system of record — the merchant's POS
 *     is — so committing stock is something the merchant does when they
 *     *accept*, and acceptance can carry a restatement in the same call.
 *   - **Not arbitrated.** If a merchant rejects or an agent cancels, the
 *     record says so and stops. Who was right is a conversation between two
 *     businesses.
 */
export type OrderStatus =
  | "placed"
  | "accepted"
  | "rejected"
  | "preparing"
  | "ready"
  | "dispatched"
  | "delivered"
  | "cancelled";

/** Which transitions are legal. An order moves forward, or it stops. */
const ORDER_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  placed: ["accepted", "rejected", "cancelled"],
  accepted: ["preparing", "ready", "dispatched", "delivered", "cancelled"],
  preparing: ["ready", "dispatched", "delivered", "cancelled"],
  ready: ["dispatched", "delivered", "cancelled"],
  dispatched: ["delivered"],
  // Terminal.
  delivered: [],
  rejected: [],
  cancelled: [],
};

export function canTransitionOrder(from: OrderStatus, to: OrderStatus): boolean {
  return ORDER_TRANSITIONS[from].includes(to);
}

export type FulfilmentMethod = "collection" | "delivery";

export interface OrderLine {
  itemId: string;
  /** Copied in, so the line still reads correctly after the item changes or is deleted. */
  sku: string;
  name: string;
  unit: string;
  quantity: number;
  unitPriceCents: number;
  lineTotalCents: number;
}

export interface Order {
  id: string;
  merchantId: string;
  accountHolderId: string;
  lines: OrderLine[];
  totalCents: number;
  currency: Currency;
  status: OrderStatus;
  fulfilment: {
    method: FulfilmentMethod;
    /** Where it goes, for delivery. */
    address?: string;
    /** When the buyer needs it by. */
    neededBy?: string;
    /** When the merchant committed to having it ready. Set on acceptance. */
    promisedAt?: string;
    /** When it actually completed. */
    deliveredAt?: string;
    /** The merchant's own tracking reference, if they have one. */
    trackingReference?: string;
  };
  /** Evidence for the merchant's reconciliation, never a settlement link. */
  cardTransactionId?: string;
  /** Free-text from whichever side last moved it. */
  note?: string;
  createdAt: string;
  updatedAt: string;
  history: Array<{ status: OrderStatus; at: string; by: "buyer" | "merchant"; note?: string }>;
}

export interface PlaceOrderInput {
  merchantId: string;
  accountHolderId: string;
  lines: Array<{ itemId: string; quantity: number }>;
  fulfilment: { method: FulfilmentMethod; address?: string; neededBy?: string };
  cardTransactionId?: string;
  note?: string;
}

/**
 * How dependable a merchant has actually been, computed from what happened
 * rather than stored — the same discipline as freshness and compliance
 * gating, and for the same reason: a stored score is a stale score.
 *
 * `confidence` is not decoration. A merchant with two orders behind them
 * must not read the same as one with two hundred, and a *new* merchant must
 * not be ranked to the bottom simply for being new — that would make the
 * directory impossible to join, which is the opposite of the point. So an
 * unknown reliability scores neutral, and the sample size travels with it.
 */
export interface MerchantReliability {
  orders: number;
  /** Of orders the merchant answered, how many they took on. */
  acceptanceRate: number;
  /** Of orders they accepted, how many actually completed. */
  fulfilmentRate: number;
  /** Of completed orders with a promise attached, how many landed on time. */
  onTimeRate: number;
  /** Of purchase notices raised against them, how many they disputed. */
  disputeRate: number;
  /** 0–1, higher is better. Neutral (0.5) when there is nothing to go on. */
  score: number;
  confidence: "none" | "low" | "medium" | "high";
}

/** Below this many resolved orders, a score is indicative rather than meaningful. */
export const RELIABILITY_LOW_CONFIDENCE = 5;
export const RELIABILITY_HIGH_CONFIDENCE = 25;

export interface ReportPurchaseInput {
  itemId: string;
  accountHolderId: string;
  quantity: number;
  cardTransactionId?: string;
}

export interface SerializedMerchantDirectory {
  merchants: Merchant[];
  items: CatalogItem[];
  purchases?: PurchaseNotice[];
  orders?: Order[];
}

// ---- the directory ---------------------------------------------------------

export class MerchantDirectory {
  private readonly merchants = new Map<string, Merchant>();
  private readonly items = new Map<string, CatalogItem>();
  private readonly purchases = new Map<string, PurchaseNotice>();
  private readonly orders = new Map<string, Order>();

  // -- merchant lifecycle ----------------------------------------------------

  register(input: RegisterMerchantInput): Merchant {
    const now = new Date().toISOString();
    const merchant: Merchant = {
      id: newId("mch"),
      name: input.name,
      tradingName: input.tradingName,
      merchantCategoryCode: input.merchantCategoryCode,
      address: input.address,
      serviceRadiusKm: input.serviceRadiusKm ?? 0,
      currency: input.currency ?? "ZAR",
      // Nothing is discoverable until a human has reviewed the KYB pack.
      status: "pending_kyb",
      kyb: { ...input.kyb, submittedAt: now, documents: [] },
      agentAccess: input.agentAccess ?? "open",
      allowedAccountHolderIds: input.allowedAccountHolderIds ?? [],
      createdAt: now,
      updatedAt: now,
    };
    this.merchants.set(merchant.id, merchant);
    return merchant;
  }

  get(id: string): Merchant {
    const merchant = this.merchants.get(id);
    if (!merchant) throw new NotFoundError("merchant", id);
    return merchant;
  }

  list(filter: { status?: MerchantStatus } = {}): Merchant[] {
    const all = [...this.merchants.values()];
    return filter.status ? all.filter((m) => m.status === filter.status) : all;
  }

  /**
   * Record the outcome of a KYB review. `reviewedBy` is required and stored:
   * a verification decision with no name attached to it is not a control.
   */
  setStatus(id: string, status: MerchantStatus, reviewedBy: string, note?: string): Merchant {
    const merchant = this.get(id);
    if (!reviewedBy) throw new DomainError("reviewer_required", "a KYB decision must name its reviewer");
    const next: Merchant = {
      ...merchant,
      status,
      kyb: { ...merchant.kyb, reviewedAt: new Date().toISOString(), reviewedBy, note },
      updatedAt: new Date().toISOString(),
    };
    this.merchants.set(id, next);
    return next;
  }

  /**
   * Records that a registration document was uploaded — never the bytes,
   * only the storage reference and who put it there. A KYB decision can be
   * made without one (some merchants hand documents over in person), but a
   * document can never attach itself: `uploadedBy` is required the same way
   * `setStatus`'s `reviewedBy` is.
   */
  attachKybDocument(id: string, doc: Omit<KybDocument, "uploadedAt">): Merchant {
    const merchant = this.get(id);
    if (!doc.uploadedBy) throw new DomainError("uploader_required", "a KYB document must record who uploaded it");
    const next: Merchant = {
      ...merchant,
      kyb: { ...merchant.kyb, documents: [...merchant.kyb.documents, { ...doc, uploadedAt: new Date().toISOString() }] },
      updatedAt: new Date().toISOString(),
    };
    this.merchants.set(id, next);
    return next;
  }

  updateProfile(
    id: string,
    patch: Partial<Pick<Merchant, "name" | "tradingName" | "address" | "serviceRadiusKm" | "agentAccess" | "allowedAccountHolderIds" | "merchantCategoryCode" | "operatingHours" | "webhook">>,
  ): Merchant {
    const merchant = this.get(id);
    const next = { ...merchant, ...patch, updatedAt: new Date().toISOString() };
    this.merchants.set(id, next);
    return next;
  }

  // -- catalog ---------------------------------------------------------------

  /** Create or replace an item by SKU within a merchant. */
  upsertItem(merchantId: string, input: UpsertItemInput): CatalogItem {
    const merchant = this.get(merchantId);
    if (!Number.isSafeInteger(input.unitPriceCents) || input.unitPriceCents < 0) {
      throw new DomainError("invalid_price", "unitPriceCents must be a non-negative integer of minor units");
    }
    const now = new Date().toISOString();
    const existing = [...this.items.values()].find((i) => i.merchantId === merchantId && i.sku === input.sku);
    const availability = input.availability ?? existing?.availability ?? "in_stock";
    const quantityAvailable = input.quantityAvailable ?? existing?.quantityAvailable;

    // Only an actual stock statement refreshes the inventory clock. A price
    // edit is not evidence that the shelf was counted.
    const stockRestated =
      input.availability !== undefined || input.quantityAvailable !== undefined || existing === undefined;

    const item: CatalogItem = {
      id: existing?.id ?? newId("item"),
      merchantId,
      sku: input.sku,
      name: input.name,
      description: input.description ?? existing?.description,
      unit: input.unit ?? existing?.unit ?? "each",
      unitPriceCents: input.unitPriceCents,
      currency: input.currency ?? existing?.currency ?? merchant.currency,
      availability,
      quantityAvailable,
      leadTimeDays: input.leadTimeDays ?? existing?.leadTimeDays ?? 0,
      inventoryUpdatedAt: stockRestated ? now : (existing?.inventoryUpdatedAt ?? now),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.items.set(item.id, item);
    return item;
  }

  /**
   * Confirm stock without touching anything else — the endpoint a merchant's
   * till, POS export, or a WhatsApp "still have 400 bags" check-in calls.
   * This is the single most valuable write in A-MERCHANT: it is what keeps
   * discovery honest.
   */
  restate(itemId: string, state: { availability: Availability; quantityAvailable?: number }): CatalogItem {
    const item = this.getItem(itemId);
    const now = new Date().toISOString();
    const next: CatalogItem = {
      ...item,
      availability: state.availability,
      quantityAvailable: state.quantityAvailable,
      inventoryUpdatedAt: now,
      updatedAt: now,
    };
    this.items.set(itemId, next);
    return next;
  }

  getItem(id: string): CatalogItem {
    const item = this.items.get(id);
    if (!item) throw new NotFoundError("catalog item", id);
    return item;
  }

  listItems(merchantId: string): CatalogItem[] {
    return [...this.items.values()].filter((i) => i.merchantId === merchantId);
  }

  removeItem(id: string): void {
    if (!this.items.delete(id)) throw new NotFoundError("catalog item", id);
  }

  /** How current a merchant's catalog is — the number to show them, and to sell on. */
  catalogHealth(merchantId: string, now = Date.now()): {
    items: number;
    fresh: number;
    aging: number;
    stale: number;
    medianInventoryAgeHours: number;
  } {
    const items = this.listItems(merchantId);
    const ages = items.map((i) => hoursSince(i.inventoryUpdatedAt, now)).sort((a, b) => a - b);
    const counts = { fresh: 0, aging: 0, stale: 0 };
    for (const age of ages) counts[classifyFreshness(age)] += 1;
    const median = ages.length === 0 ? 0 : (ages[Math.floor((ages.length - 1) / 2)] as number);
    return { items: items.length, ...counts, medianInventoryAgeHours: Math.round(median * 10) / 10 };
  }

  // -- purchase notices ------------------------------------------------------

  /**
   * A buyer reporting that they bought something. Prices the line from the
   * item as it stands *now* rather than trusting a buyer-supplied total —
   * the buyer says what and how much, the catalog says what that costs.
   */
  reportPurchase(input: ReportPurchaseInput): PurchaseNotice {
    if (!Number.isSafeInteger(input.quantity) || input.quantity < 1) {
      throw new DomainError("invalid_quantity", "quantity must be a positive integer");
    }
    const item = this.getItem(input.itemId);
    const notice: PurchaseNotice = {
      id: newId("pn"),
      merchantId: item.merchantId,
      itemId: item.id,
      sku: item.sku,
      itemName: item.name,
      unit: item.unit,
      accountHolderId: input.accountHolderId,
      quantity: input.quantity,
      unitPriceCents: item.unitPriceCents,
      totalCents: item.unitPriceCents * input.quantity,
      currency: item.currency,
      cardTransactionId: input.cardTransactionId,
      status: "reported",
      reportedAt: new Date().toISOString(),
    };
    this.purchases.set(notice.id, notice);
    return notice;
  }

  getPurchase(id: string): PurchaseNotice {
    const notice = this.purchases.get(id);
    if (!notice) throw new NotFoundError("purchase notice", id);
    return notice;
  }

  /** A merchant's own notices, newest first. */
  listPurchases(merchantId: string, filter: { status?: PurchaseNoticeStatus } = {}): PurchaseNotice[] {
    return [...this.purchases.values()]
      .filter((p) => p.merchantId === merchantId && (!filter.status || p.status === filter.status))
      .sort((a, b) => b.reportedAt.localeCompare(a.reportedAt));
  }

  /** What a buyer reported, across every merchant — their own side of the same records. */
  listPurchasesByBuyer(accountHolderId: string): PurchaseNotice[] {
    return [...this.purchases.values()]
      .filter((p) => p.accountHolderId === accountHolderId)
      .sort((a, b) => b.reportedAt.localeCompare(a.reportedAt));
  }

  /**
   * The merchant's answer. Terminal in both directions: a notice is resolved
   * once, so an acknowledgement cannot later be quietly rewritten into a
   * dispute (or the reverse) without a new record and a new conversation.
   */
  resolvePurchase(id: string, status: "acknowledged" | "disputed", note?: string): PurchaseNotice {
    const notice = this.getPurchase(id);
    if (notice.status !== "reported") {
      throw new InvalidStateError(`purchase notice ${id} is already ${notice.status}`);
    }
    const next: PurchaseNotice = { ...notice, status, note, resolvedAt: new Date().toISOString() };
    this.purchases.set(id, next);
    return next;
  }

  /** Unresolved notices waiting on this merchant — the number worth putting in front of them. */
  pendingPurchaseCount(merchantId: string): number {
    return this.listPurchases(merchantId, { status: "reported" }).length;
  }

  // -- orders ----------------------------------------------------------------

  /**
   * Place an order. Lines are priced from the catalog as it stands now — the
   * buyer says what and how many, the catalog says what that costs, same rule
   * purchase notices follow.
   */
  placeOrder(input: PlaceOrderInput): Order {
    if (input.lines.length === 0) throw new DomainError("empty_order", "an order needs at least one line");
    const merchant = this.get(input.merchantId);
    if (merchant.status !== "verified") {
      throw new InvalidStateError(`merchant ${merchant.id} is ${merchant.status} and cannot take orders`);
    }
    if (input.fulfilment.method === "delivery" && !input.fulfilment.address) {
      throw new DomainError("address_required", "a delivery order needs a delivery address");
    }

    const lines: OrderLine[] = input.lines.map((line) => {
      if (!Number.isSafeInteger(line.quantity) || line.quantity < 1) {
        throw new DomainError("invalid_quantity", "every order line needs a positive integer quantity");
      }
      const item = this.getItem(line.itemId);
      if (item.merchantId !== input.merchantId) {
        throw new DomainError("wrong_merchant", `item ${item.id} does not belong to merchant ${input.merchantId}`);
      }
      return {
        itemId: item.id,
        sku: item.sku,
        name: item.name,
        unit: item.unit,
        quantity: line.quantity,
        unitPriceCents: item.unitPriceCents,
        lineTotalCents: item.unitPriceCents * line.quantity,
      };
    });

    const currencies = new Set(lines.map((l) => this.getItem(l.itemId).currency));
    if (currencies.size > 1) {
      throw new DomainError("mixed_currency", "every line on an order must be priced in the same currency");
    }

    const now = new Date().toISOString();
    const order: Order = {
      id: newId("ord"),
      merchantId: input.merchantId,
      accountHolderId: input.accountHolderId,
      lines,
      totalCents: lines.reduce((sum, l) => sum + l.lineTotalCents, 0),
      currency: this.getItem(lines[0]!.itemId).currency,
      status: "placed",
      fulfilment: { ...input.fulfilment },
      cardTransactionId: input.cardTransactionId,
      note: input.note,
      createdAt: now,
      updatedAt: now,
      history: [{ status: "placed", at: now, by: "buyer", note: input.note }],
    };
    this.orders.set(order.id, order);
    return order;
  }

  getOrder(id: string): Order {
    const order = this.orders.get(id);
    if (!order) throw new NotFoundError("order", id);
    return order;
  }

  listOrders(merchantId: string, filter: { status?: OrderStatus } = {}): Order[] {
    return [...this.orders.values()]
      .filter((o) => o.merchantId === merchantId && (!filter.status || o.status === filter.status))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  listOrdersByBuyer(accountHolderId: string): Order[] {
    return [...this.orders.values()]
      .filter((o) => o.accountHolderId === accountHolderId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /**
   * Move an order along. Refuses an illegal transition rather than silently
   * accepting it: an order that has been delivered cannot go back to
   * preparing, and one the merchant rejected is over.
   */
  advanceOrder(
    id: string,
    to: OrderStatus,
    by: "buyer" | "merchant",
    detail: { note?: string; promisedAt?: string; trackingReference?: string } = {},
  ): Order {
    const order = this.getOrder(id);
    if (!canTransitionOrder(order.status, to)) {
      throw new InvalidStateError(`an order that is ${order.status} cannot become ${to}`);
    }
    // Only the buyer cancels; only the merchant does everything else. Letting
    // either side drive the whole machine would make the history meaningless.
    if (to === "cancelled" && by !== "buyer") {
      throw new DomainError("forbidden_transition", "only the buyer cancels an order; a merchant rejects it");
    }
    if (to !== "cancelled" && by !== "merchant") {
      throw new DomainError("forbidden_transition", `only the merchant can move an order to ${to}`);
    }

    const now = new Date().toISOString();
    const next: Order = {
      ...order,
      status: to,
      note: detail.note ?? order.note,
      fulfilment: {
        ...order.fulfilment,
        promisedAt: detail.promisedAt ?? order.fulfilment.promisedAt,
        trackingReference: detail.trackingReference ?? order.fulfilment.trackingReference,
        deliveredAt: to === "delivered" ? now : order.fulfilment.deliveredAt,
      },
      updatedAt: now,
      history: [...order.history, { status: to, at: now, by, note: detail.note }],
    };
    this.orders.set(id, next);
    return next;
  }

  /** Orders still needing the merchant to do something. */
  openOrderCount(merchantId: string): number {
    const open: OrderStatus[] = ["placed", "accepted", "preparing", "ready", "dispatched"];
    return this.listOrders(merchantId).filter((o) => open.includes(o.status)).length;
  }

  /**
   * What this merchant has actually done, scored. See `MerchantReliability`
   * for why confidence travels with the number and why unknown is neutral.
   */
  reliability(merchantId: string): MerchantReliability {
    const orders = this.listOrders(merchantId);
    const answered = orders.filter((o) => o.status !== "placed" && o.status !== "cancelled");
    const accepted = answered.filter((o) => o.status !== "rejected");
    const delivered = orders.filter((o) => o.status === "delivered");
    const promised = delivered.filter((o) => o.fulfilment.promisedAt && o.fulfilment.deliveredAt);
    const onTime = promised.filter((o) => o.fulfilment.deliveredAt! <= o.fulfilment.promisedAt!);

    const notices = this.listPurchases(merchantId);
    const resolvedNotices = notices.filter((n) => n.status !== "reported");
    const disputed = notices.filter((n) => n.status === "disputed");

    const rate = (numerator: number, denominator: number, fallback = 0.5) =>
      denominator === 0 ? fallback : numerator / denominator;

    const acceptanceRate = rate(accepted.length, answered.length);
    const fulfilmentRate = rate(delivered.length, accepted.length);
    const onTimeRate = rate(onTime.length, promised.length);
    const disputeRate = rate(disputed.length, resolvedNotices.length, 0);

    const sample = answered.length;
    const confidence =
      sample === 0 ? "none" : sample < RELIABILITY_LOW_CONFIDENCE ? "low" : sample < RELIABILITY_HIGH_CONFIDENCE ? "medium" : "high";

    // Neutral when there is nothing to go on, so a new merchant is not
    // punished for being new.
    const score =
      confidence === "none"
        ? 0.5
        : Math.round((acceptanceRate * 0.3 + fulfilmentRate * 0.35 + onTimeRate * 0.25 + (1 - disputeRate) * 0.1) * 1000) / 1000;

    return {
      orders: orders.length,
      acceptanceRate: Math.round(acceptanceRate * 1000) / 1000,
      fulfilmentRate: Math.round(fulfilmentRate * 1000) / 1000,
      onTimeRate: Math.round(onTimeRate * 1000) / 1000,
      disputeRate: Math.round(disputeRate * 1000) / 1000,
      score,
      confidence,
    };
  }

  // -- discovery -------------------------------------------------------------

  /**
   * The agent's question: "what can I actually buy, from whom, at what price,
   * by when?" Returns ranked offers plus the reasons candidates were dropped.
   */
  search(query: OfferQuery, now = Date.now()): OfferSearchResult {
    return evaluateOffers(this.merchants.values(), (merchantId) => this.listItems(merchantId), query, now);
  }

  // -- persistence -----------------------------------------------------------

  serialize(): SerializedMerchantDirectory {
    return {
      merchants: [...this.merchants.values()],
      items: [...this.items.values()],
      purchases: [...this.purchases.values()],
      orders: [...this.orders.values()],
    };
  }

  static hydrate(snapshot: SerializedMerchantDirectory): MerchantDirectory {
    const directory = new MerchantDirectory();
    for (const merchant of snapshot.merchants) {
      // Back-compat: snapshots taken before document upload have no `documents` array.
      if (!merchant.kyb.documents) merchant.kyb.documents = [];
      directory.merchants.set(merchant.id, merchant);
    }
    for (const item of snapshot.items) directory.items.set(item.id, item);
    // Back-compat: snapshots taken before purchase notices existed have none.
    for (const notice of snapshot.purchases ?? []) directory.purchases.set(notice.id, notice);
    // Back-compat: snapshots taken before orders existed have none.
    for (const order of snapshot.orders ?? []) directory.orders.set(order.id, order);
    return directory;
  }
}

// ---- search: shared between the in-memory directory and any other backend -

/**
 * The actual discovery decision — which candidates clear every filter, why
 * the rest didn't, and how the survivors rank — as a pure function over
 * plain data rather than a `MerchantDirectory` method.
 *
 * This exists so a SQL-backed directory (see the Postgres adapter in
 * `apps/api`) can push the *retrieval* half of search to the database —
 * narrowing millions of catalog rows down to one merchant's — while still
 * running the exact same, already-tested *ranking* decision this file ships
 * with. The alternative, a second ranking implementation written in SQL,
 * is a correctness risk with no offsetting benefit: proportional scoring,
 * freshness classification, and match-reason text would have to be kept in
 * sync by hand across two languages forever. One implementation, two
 * retrieval paths.
 */
export function evaluateOffers(
  merchants: Iterable<Merchant>,
  itemsFor: (merchantId: string) => CatalogItem[],
  query: OfferQuery,
  now: number,
): OfferSearchResult {
  const quantity = query.quantity ?? 1;
  if (!Number.isSafeInteger(quantity) || quantity < 1) {
    throw new InvalidStateError("quantity must be a positive integer");
  }
  const text = query.text?.trim().toLowerCase();
  const offers: Offer[] = [];
  const excluded: OfferExclusion[] = [];
  let considered = 0;

  const drop = (merchantId: string, reason: string, itemId?: string) => {
    if (excluded.length < MAX_EXCLUSIONS_REPORTED) excluded.push({ merchantId, itemId, reason });
  };

  for (const merchant of merchants) {
    if (merchant.status !== "verified") {
      drop(merchant.id, `merchant is ${merchant.status}`);
      continue;
    }
    if (query.merchantCategoryCodes?.length && !query.merchantCategoryCodes.includes(merchant.merchantCategoryCode)) {
      drop(merchant.id, `category ${merchant.merchantCategoryCode} not in the requested allow-list`);
      continue;
    }
    if (merchant.agentAccess === "allowlist") {
      if (!query.requestedBy || !merchant.allowedAccountHolderIds.includes(query.requestedBy)) {
        drop(merchant.id, "merchant restricts agent access to named organisations");
        continue;
      }
    }

    let distance: number | undefined;
    if (query.near) {
      distance = distanceKm(query.near, merchant.address);
      // Reachable if the buyer is inside the search radius *and* inside the
      // merchant's own delivery radius (or close enough to collect).
      if (distance > query.near.radiusKm) {
        drop(merchant.id, `${distance.toFixed(1)}km away, outside the ${query.near.radiusKm}km search radius`);
        continue;
      }
      if (merchant.serviceRadiusKm > 0 && distance > merchant.serviceRadiusKm) {
        drop(merchant.id, `${distance.toFixed(1)}km away, beyond the merchant's ${merchant.serviceRadiusKm}km delivery radius`);
        continue;
      }
    }

    for (const item of itemsFor(merchant.id)) {
      considered += 1;
      if (query.currency && item.currency !== query.currency) {
        drop(merchant.id, `priced in ${item.currency}, not ${query.currency}`, item.id);
        continue;
      }
      if (text) {
        const haystack = `${item.name} ${item.description ?? ""} ${item.sku}`.toLowerCase();
        if (!haystack.includes(text)) continue;
      }
      if (item.availability === "out_of_stock") {
        drop(merchant.id, "out of stock", item.id);
        continue;
      }
      if (item.quantityAvailable !== undefined && item.quantityAvailable < quantity) {
        drop(merchant.id, `only ${item.quantityAvailable} ${item.unit} available, ${quantity} requested`, item.id);
        continue;
      }
      const totalCents = item.unitPriceCents * quantity;
      if (query.maxTotalCents !== undefined && totalCents > query.maxTotalCents) {
        drop(merchant.id, `${totalCents} exceeds the ${query.maxTotalCents} budget`, item.id);
        continue;
      }
      if (query.maxLeadTimeDays !== undefined && item.leadTimeDays > query.maxLeadTimeDays) {
        drop(
          merchant.id,
          `${item.leadTimeDays}-day lead time, needed within ${query.maxLeadTimeDays} day${query.maxLeadTimeDays === 1 ? "" : "s"}`,
          item.id,
        );
        continue;
      }
      const ageHours = hoursSince(item.inventoryUpdatedAt, now);
      if (query.maxInventoryAgeHours !== undefined && ageHours > query.maxInventoryAgeHours) {
        drop(merchant.id, `stock last confirmed ${Math.round(ageHours)}h ago`, item.id);
        continue;
      }

      offers.push({
        merchant: publicMerchant(merchant),
        item,
        quantity,
        unitPriceCents: item.unitPriceCents,
        totalCents,
        currency: item.currency,
        distanceKm: distance === undefined ? undefined : Math.round(distance * 10) / 10,
        leadTimeDays: item.leadTimeDays,
        availability: item.availability,
        inventoryAgeHours: Math.round(ageHours * 10) / 10,
        freshness: classifyFreshness(ageHours),
        score: 0,
        matchReasons: [],
      });
    }
  }

  rankOffers(offers);
  return { offers: offers.slice(0, query.limit ?? 20), considered, excluded };
}

/**
 * Scores each offer against the best available on each dimension,
 * *proportionally* — an offer 10% pricier than the cheapest scores 0.91 on
 * price, not 0.
 *
 * The obvious alternative, normalising across the spread of the result set,
 * is wrong here and wrong in a way that costs money: with two offers a
 * cent apart it hands the cheaper one the entire price weight, so a
 * three-week-old stock count beats a confirmed one on a rounding
 * difference. Proportional scoring keeps a small price gap a small
 * advantage, which is the only way freshness can win when it should.
 */
export function rankOffers(offers: Offer[]): void {
  if (offers.length === 0) return;
  const best = {
    total: Math.min(...offers.map((o) => o.totalCents)),
    lead: Math.min(...offers.map((o) => o.leadTimeDays)),
    dist: Math.min(...offers.map((o) => o.distanceKm ?? 0)),
  };

  // Ratio of best to this one, offset by 1 so a zero best value (same-day
  // delivery, on-site merchant) stays meaningful instead of dividing by zero.
  const ratio = (value: number, bestValue: number, offset = 0) => (bestValue + offset) / (value + offset || 1);

  for (const offer of offers) {
    const priceScore = ratio(offer.totalCents, best.total);
    const leadScore = ratio(offer.leadTimeDays, best.lead, 1);
    const distScore = offer.distanceKm === undefined ? 1 : ratio(offer.distanceKm, best.dist, 1);
    const freshScore = FRESHNESS_SCORE[offer.freshness];

    offer.score =
      Math.round(
        (priceScore * OFFER_WEIGHTS.price +
          leadScore * OFFER_WEIGHTS.leadTime +
          distScore * OFFER_WEIGHTS.distance +
          freshScore * OFFER_WEIGHTS.freshness) *
          1000,
      ) / 1000;

    const reasons: string[] = [];
    if (offer.totalCents === best.total) reasons.push("lowest total price");
    if (offer.leadTimeDays === best.lead) reasons.push(offer.leadTimeDays === 0 ? "available same day" : "fastest delivery");
    if (offer.distanceKm !== undefined && offer.distanceKm === best.dist) reasons.push("closest merchant");
    if (offer.freshness === "fresh") reasons.push("stock confirmed in the last 24h");
    if (offer.freshness === "stale") reasons.push("stock not confirmed in over a week — verify before ordering");
    if (offer.availability === "low_stock") reasons.push("merchant reports low stock");
    if (offer.availability === "made_to_order") reasons.push("made to order, not held in stock");
    offer.matchReasons = reasons;
  }

  offers.sort((a, b) => b.score - a.score || a.totalCents - b.totalCents);
}
