import type { Card } from "./cards.js";

/**
 * Hot-path authorization rules. These run synchronously inside the issuer's
 * real-time authorization window (sub-2-seconds end to end), so every check
 * here must be O(small) and never wait on a network call.
 *
 * Outcomes:
 *  - approve: continue to the balance/hold step
 *  - review:  decline this authorization but open a human approval; an
 *             approval grant lets a retried authorization through
 *  - decline: hard decline with a reason code
 */

export interface AuthorizationContext {
  card: Card;
  amount: number; // minor units
  currency: string;
  merchant: { name: string; category: string; country?: string };
  /** Total captured + held spend on this card so far, minor units. */
  cardSpendToDate: number;
  /** Spend on this card within the velocity window, minor units. */
  cardSpendInWindow: number;
  /** An unconsumed approval grant matching this authorization, if any. */
  hasApprovalGrant: boolean;
}

export type RuleOutcome =
  | { decision: "approve" }
  | { decision: "review"; reason: string }
  | { decision: "decline"; reason: string };

export type Rule = (ctx: AuthorizationContext) => RuleOutcome | undefined;

export const defaultRules: Rule[] = [
  function cardMustBeActive(ctx) {
    if (ctx.card.status !== "active") {
      return { decision: "decline", reason: "card_closed" };
    }
    return undefined;
  },

  function currencyMustMatch(ctx) {
    if (ctx.currency !== ctx.card.currency) {
      return { decision: "decline", reason: "currency_mismatch" };
    }
    return undefined;
  },

  function merchantCategoryAllowList(ctx) {
    const allowed = ctx.card.allowedMerchantCategories;
    if (allowed.length > 0 && !allowed.includes(ctx.merchant.category)) {
      return { decision: "decline", reason: "merchant_category_not_allowed" };
    }
    return undefined;
  },

  function perTransactionLimit(ctx) {
    const limit = ctx.card.limits.perTransaction;
    if (limit !== undefined && ctx.amount > limit) {
      return { decision: "decline", reason: "per_transaction_limit_exceeded" };
    }
    return undefined;
  },

  function totalLimit(ctx) {
    const limit = ctx.card.limits.total;
    if (limit !== undefined && ctx.cardSpendToDate + ctx.amount > limit) {
      return { decision: "decline", reason: "card_total_limit_exceeded" };
    }
    return undefined;
  },

  function velocityLimit(ctx) {
    const v = ctx.card.limits.velocity;
    if (v && ctx.cardSpendInWindow + ctx.amount > v.amount) {
      return { decision: "decline", reason: "velocity_limit_exceeded" };
    }
    return undefined;
  },

  function approvalThreshold(ctx) {
    const threshold = ctx.card.approvalThreshold;
    if (threshold !== undefined && ctx.amount >= threshold && !ctx.hasApprovalGrant) {
      return { decision: "review", reason: "amount_requires_human_approval" };
    }
    return undefined;
  },
];

export function evaluateRules(ctx: AuthorizationContext, rules: Rule[] = defaultRules): RuleOutcome {
  for (const rule of rules) {
    const outcome = rule(ctx);
    if (outcome) return outcome;
  }
  return { decision: "approve" };
}
