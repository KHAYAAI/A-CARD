import { newId, type AfpIntent, type RailExecutionResult, type RailProfile } from "@acard/core";
import type { PlatformService } from "../service/types.js";
import { RailAmbiguousOutcomeError, type RailAdapter } from "./types.js";

/**
 * The card rail isn't a new payment mechanism — it's a thin adapter onto
 * A-CARD's own, already-tested authorization path. AFP asking "pay this
 * intent via card" and an agent calling `pay_checkout` over MCP end up at
 * the exact same `PlatformService.authorize`, with the exact same rules
 * engine, approval thresholds, and ledger hold. This adapter's only job is
 * translating an `AfpIntent` into that call and reporting what came back.
 *
 * Finality: `reversal_window`, 120 days — matches card-network chargeback
 * practice. This is the rail every other rail gets compared against, so
 * getting its finality honest matters more than for either of the others.
 */
export const CARD_PROFILE: RailProfile = {
  id: "card",
  label: "A-CARD virtual card",
  finality: { kind: "reversal_window", reversalWindowDays: 120 },
};

export function createCardRail(platform: PlatformService, issuerWebhookSecret: string): RailAdapter {
  const findUsableCard = async (intent: AfpIntent) => {
    const cards = await platform.listCards(intent.accountHolderId);
    return cards.find((c) => c.status === "active" && c.currency === intent.currency);
  };

  return {
    profile: CARD_PROFILE,

    async quote(intent) {
      const card = await findUsableCard(intent);
      if (!card) {
        return { rail: "card", available: false, costCents: 0, etaSeconds: 0, reason: `no active card in ${intent.currency}` };
      }
      // Card networks charge the merchant, not the payer — from AFP's
      // routing perspective the fee this org sees is $0. Modeled explicitly
      // rather than omitted, so a rail that genuinely does cost the payer
      // (a wire fee, an on-chain gas cost) isn't silently treated as free
      // by comparison to a hidden assumption.
      return { rail: "card", available: true, costCents: 0, etaSeconds: 2 };
    },

    async execute(intent) {
      const card = await findUsableCard(intent);
      if (!card) throw new Error(`no active ${intent.currency} card available for ${intent.accountHolderId}`);

      // The exact same signed-webhook path a real issuer calls, and the
      // same one /v1/simulate/purchase plays in the sandbox — AFP doesn't
      // get a shortcut around the rules engine or the ledger hold.
      const authorizationId = newId("afpauth");
      let decision;
      try {
        decision = await platform.authorize({
          authorizationId,
          cardId: card.id,
          amount: intent.amount,
          currency: intent.currency,
          merchant: { name: intent.purpose, category: "5999" },
        });
      } catch (error) {
        // On the Postgres multi-writer path this is a real network call to
        // the database — a dropped connection here means the hold may or
        // may not have posted. `authorizationId` is fresh either way, so a
        // later retry under a new AFP idempotency key would double-hold if
        // this were guessed as "failed"; reconciliation has to check first.
        throw new RailAmbiguousOutcomeError(
          `card: authorization outcome unknown for ${authorizationId} — ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      if (!decision.approved) {
        const reason = decision.declineReason ?? "declined";
        throw new Error(`card authorization declined: ${reason}`);
      }

      const result: RailExecutionResult = { railReference: decision.transaction.id, immediate: true };
      return result;
    },
  };
}

