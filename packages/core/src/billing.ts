/**
 * Freemium tiers. Deliberately simple — a card-creation cap per calendar
 * month per tier — because that's the one limit that actually needs
 * enforcing before a paid plan exists. Usage-based metering (Lago) and
 * per-feature entitlements are a later layer, not needed to charge a
 * monthly ZAR subscription fee.
 */

export type SubscriptionTier = "free" | "basic" | "pro" | "enterprise";

export interface TierLimits {
  cardsPerMonth: number;
  priceZarCents: number;
}

// $2,800/mo enterprise price is fixed in ZAR cents at signing, not floated
// against spot FX on every read — R51,800 reflects ~R18.50/$1 at the time
// this tier was priced. Repricing is a deliberate edit here, not automatic.
export const SUBSCRIPTION_TIERS: Record<SubscriptionTier, TierLimits> = {
  free: { cardsPerMonth: 5, priceZarCents: 0 },
  basic: { cardsPerMonth: 25, priceZarCents: 14_900 }, // R149/mo
  pro: { cardsPerMonth: 100, priceZarCents: 49_900 }, // R499/mo
  enterprise: { cardsPerMonth: 100_000, priceZarCents: 5_180_000 }, // R51,800/mo (~$2,800)
};

export function currentBillingPeriod(now = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}
