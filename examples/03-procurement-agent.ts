import { isAwaitingApproval, type Acard, type Offer } from "@acard/sdk";
import { connect, money, resolveOptions, runIfMain, type ExampleOptions } from "./lib.js";

/**
 * A procurement agent, with no LLM in the loop — the deterministic skeleton
 * every agent framework ends up wrapping:
 *
 *   1. find verified supply that meets the brief (A-MERCHANT)
 *   2. issue a single-use card sized exactly to the chosen offer (A-CARD)
 *   3. pay — and if a human must approve, wait for them
 *   4. place the order with the merchant, citing the card transaction
 *
 *   npx tsx seed-demo-world.ts        # prints an API key
 *   ACARD_API_KEY=ak_… npx tsx 03-procurement-agent.ts
 */

export interface ProcurementBrief {
  query: string;
  quantity: number;
  near: { lat: number; lng: number };
  radiusKm: number;
  neededWithinDays: number;
  budgetCents: number;
  deliverTo: string;
}

export const DEFAULT_BRIEF: ProcurementBrief = {
  query: "cement",
  quantity: 500,
  near: { lat: -26.2309, lng: 28.1772 }, // Germiston depot
  radiusKm: 60,
  neededWithinDays: 1,
  budgetCents: 6_000_000, // R60 000
  deliverTo: "Khaya Logistics depot, 14 Refinery Rd, Germiston",
};

export async function procure(options: ExampleOptions & { brief?: ProcurementBrief; approvalTimeoutMs?: number } = {}) {
  const { log } = resolveOptions(options);
  const brief = options.brief ?? DEFAULT_BRIEF;
  const { acard } = await connect(options);

  // 1. Find supply.
  log(`Brief: ${brief.quantity} × ${brief.query}, within ${brief.neededWithinDays} day(s), under ${money(brief.budgetCents)}`);
  const result = await acard.merchants.search({
    q: brief.query,
    quantity: brief.quantity,
    lat: brief.near.lat,
    lng: brief.near.lng,
    radius_km: brief.radiusKm,
    max_lead_time_days: brief.neededWithinDays,
    max_total_cents: brief.budgetCents,
  });
  for (const excluded of result.excluded) log(`  skipped: ${excluded.reason}`);
  if (result.offers.length === 0) {
    log("No verified supplier can meet this brief. Nothing bought.");
    return { outcome: "no_supply" as const };
  }
  const offer = result.offers[0] as Offer;
  log(
    `Chose ${offer.merchant.name}: ${money(offer.totalCents)} · ${offer.distanceKm?.toFixed(1)} km · ` +
      `lead ${offer.leadTimeDays}d · stock ${offer.freshness} (${offer.inventoryAgeHours.toFixed(1)}h old) · score ${offer.score.toFixed(3)}`,
  );

  // 2. A card that can buy this, here, once — and nothing else.
  const card = await acard.cards.create({
    label: `procure ${brief.quantity} ${offer.item.unit} ${offer.item.name}`,
    single_use: true,
    limits: { per_transaction: offer.totalCents, total: offer.totalCents },
    allowed_merchant_categories: [offer.merchant.merchantCategoryCode],
  });
  log(`Issued single-use card •••• ${card.last4}, capped at exactly ${money(offer.totalCents)}`);

  // 3. Pay. Above the org's approval threshold this is held for a human.
  const purchase = {
    card_id: card.id,
    amount: offer.totalCents,
    merchant: { name: offer.merchant.name, category: offer.merchant.merchantCategoryCode },
  };
  let paid = await acard.sandbox.purchase(purchase);
  if (isAwaitingApproval(paid)) {
    log(`Held for approval (${paid.approval_id}). Waiting for a human — approve in the dashboard, Slack link or \`acard approvals\`.`);
    const decision = await acard.approvals.waitForDecision(paid.approval_id!, {
      timeoutMs: options.approvalTimeoutMs ?? 15 * 60_000,
      intervalMs: 1_000,
    });
    if (decision.status !== "approved") {
      log(`Denied by ${decision.decidedBy ?? "a human"}. Closing the card; nothing bought.`);
      await acard.cards.close(card.id);
      return { outcome: "denied" as const };
    }
    log(`Approved by ${decision.decidedBy}. Retrying once on the grant.`);
    paid = await acard.sandbox.purchase(purchase);
  }
  if (!paid.approved) {
    log(`Declined: ${paid.decline_reason}. Nothing bought.`);
    return { outcome: "declined" as const, reason: paid.decline_reason };
  }
  const transaction = (await acard.transactions.list({ cardId: card.id })).find((t) => t.type !== "declined" && t.status !== "declined");
  log(`Paid ${money(offer.totalCents)}. Wallet available: ${money(paid.wallet.available)}`);

  // 4. Order, citing the card transaction so the merchant can reconcile.
  const order = await acard.merchants.placeOrder(offer.merchant.id, {
    lines: [{ item_id: offer.item.id, quantity: brief.quantity }],
    fulfilment: { method: "delivery", address: brief.deliverTo },
    card_transaction_id: transaction?.id,
    note: "Placed by procurement-bot-03",
  });
  log(`Order ${order.id} placed with ${offer.merchant.name} — status ${order.status}.`);
  return { outcome: "ordered" as const, order, card: await acard.cards.get(card.id) };
}

/** Exposed for the test: lets an automated "human" approve while the agent waits. */
export async function approvePending(acard: Acard): Promise<number> {
  const pending = await acard.approvals.list({ status: "pending" });
  for (const approval of pending) await acard.approvals.approve(approval.id);
  return pending.length;
}

runIfMain(import.meta.url, () => procure());
