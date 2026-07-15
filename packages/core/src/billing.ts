/**
 * Freemium tiers. Deliberately simple — a card-creation cap per calendar
 * month per tier — because that's the one limit that actually needs
 * enforcing before a paid plan exists. Usage-based metering (Lago) and
 * per-feature entitlements are a later layer, not needed to charge a
 * monthly ZAR subscription fee.
 */

export type SubscriptionTier = "free" | "basic" | "pro";

export interface TierLimits {
  cardsPerMonth: number;
  priceZarCents: number;
}

export const SUBSCRIPTION_TIERS: Record<SubscriptionTier, TierLimits> = {
  free: { cardsPerMonth: 5, priceZarCents: 0 },
  basic: { cardsPerMonth: 25, priceZarCents: 14_900 }, // R149/mo
  pro: { cardsPerMonth: 100, priceZarCents: 49_900 }, // R499/mo
};

export function currentBillingPeriod(now = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}
