import { DomainError } from "./errors.js";
import type { CardLimits } from "./cards.js";

/**
 * Freemium tiers. Subscription pricing is USD (billed via PayFast — see
 * apps/api/src/payfast.ts, and its header note on the currency risk:
 * PayFast's checkout has no currency field, so this only bills correctly
 * in USD if the merchant account itself is confirmed with PayFast as USD),
 * independent of what currency an account's
 * wallets/cards are actually denominated in. Two limits per tier: a
 * card-creation cap per calendar month, and a per-card spend cap.
 */

export type SubscriptionTier = "free" | "basic" | "pro" | "enterprise";

export interface TierLimits {
  cardsPerMonth: number;
  priceUsdCents: number;
  /**
   * Maximum total budget (`Card.limits.total`) a single card on this tier
   * may carry, in USD minor units. `null` = uncapped (enterprise only).
   * Enforcement only applies to USD-denominated cards today — there's no
   * FX conversion in this codebase, so a ZAR/NGN/KES card isn't capped
   * against a USD number without inventing an exchange rate. See
   * `Platform.createCard`.
   */
  perCardCapCents: number | null;
}

export const SUBSCRIPTION_TIERS: Record<SubscriptionTier, TierLimits> = {
  free: { cardsPerMonth: 5, priceUsdCents: 0, perCardCapCents: 5_000 }, // $0/mo, up to $50/card
  basic: { cardsPerMonth: 25, priceUsdCents: 800, perCardCapCents: 50_000 }, // $8/mo, up to $500/card
  pro: { cardsPerMonth: 100, priceUsdCents: 2_800, perCardCapCents: 100_000 }, // $28/mo, up to $1,000/card
  enterprise: { cardsPerMonth: 100_000, priceUsdCents: 280_000, perCardCapCents: null }, // $2,800/mo, effectively unlimited
};

export function currentBillingPeriod(now = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * Applies a tier's per-card cap to the limits a card is being created with.
 * Only enforced for USD-denominated cards (see `perCardCapCents`'s doc).
 * An unset `total` defaults to the cap rather than staying uncapped, so a
 * plain `createCard()` call still respects the plan; an explicit `total`
 * above the cap is rejected outright. Shared by both the in-memory and
 * Postgres backends so the rule can't drift between them.
 */
export function applyCardCap(tier: SubscriptionTier, currency: string, limits: CardLimits | undefined): CardLimits | undefined {
  const cap = SUBSCRIPTION_TIERS[tier].perCardCapCents;
  if (cap === null || currency !== "USD") return limits;
  if (limits?.total !== undefined && limits.total > cap) {
    throw new DomainError(
      "plan_card_cap_exceeded",
      `${tier} plan caps each card's total budget at $${(cap / 100).toFixed(2)}; lower the requested total or upgrade`,
      402,
    );
  }
  return { ...limits, total: limits?.total ?? cap };
}
