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
  createdAt: string;
  updatedAt: string;
}

/**
 * The agent-facing view. Strips the KYB record entirely: an agent needs to
 * know a merchant is verified, never the registration number, VAT number, or
 * contact details behind that verification.
 */
export type PublicMerchant = Omit<Merchant, "kyb"> & { verified: boolean };

export function publicMerchant(merchant: Merchant): PublicMerchant {
  const { kyb: _kyb, ...rest } = merchant;
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
  kyb: Omit<KybRecord, "submittedAt" | "reviewedAt" | "reviewedBy">;
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

export interface SerializedMerchantDirectory {
  merchants: Merchant[];
  items: CatalogItem[];
}

// ---- the directory ---------------------------------------------------------

export class MerchantDirectory {
  private readonly merchants = new Map<string, Merchant>();
  private readonly items = new Map<string, CatalogItem>();

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
      kyb: { ...input.kyb, submittedAt: now },
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

  updateProfile(
    id: string,
    patch: Partial<Pick<Merchant, "name" | "tradingName" | "address" | "serviceRadiusKm" | "agentAccess" | "allowedAccountHolderIds" | "merchantCategoryCode">>,
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

  // -- discovery -------------------------------------------------------------

  /**
   * The agent's question: "what can I actually buy, from whom, at what price,
   * by when?" Returns ranked offers plus the reasons candidates were dropped.
   */
  search(query: OfferQuery, now = Date.now()): OfferSearchResult {
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

    for (const merchant of this.merchants.values()) {
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

      for (const item of this.listItems(merchant.id)) {
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

    this.rank(offers);
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
  private rank(offers: Offer[]): void {
    if (offers.length === 0) return;
    const best = {
      total: Math.min(...offers.map((o) => o.totalCents)),
      lead: Math.min(...offers.map((o) => o.leadTimeDays)),
      dist: Math.min(...offers.map((o) => o.distanceKm ?? 0)),
    };

    // Ratio of best to this one, offset by 1 so a zero best value (same-day
    // delivery, on-site merchant) stays meaningful instead of dividing by zero.
    const ratio = (value: number, bestValue: number, offset = 0) =>
      (bestValue + offset) / (value + offset || 1);

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

  // -- persistence -----------------------------------------------------------

  serialize(): SerializedMerchantDirectory {
    return { merchants: [...this.merchants.values()], items: [...this.items.values()] };
  }

  static hydrate(snapshot: SerializedMerchantDirectory): MerchantDirectory {
    const directory = new MerchantDirectory();
    for (const merchant of snapshot.merchants) directory.merchants.set(merchant.id, merchant);
    for (const item of snapshot.items) directory.items.set(item.id, item);
    return directory;
  }
}
