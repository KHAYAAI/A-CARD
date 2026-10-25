# 11 — Finding supply with A-MERCHANT

**You'll build:** an agent step that turns "500 bags of cement by tomorrow" into one defensible supplier choice, and a card that can buy exactly that.
**Time:** 15 minutes · **Prereqs:** [10](10-your-first-agent-with-the-sdk.md), and the demo world: `cd examples && npx tsx seed-demo-world.ts`

## Why not just let the agent search the web?

On the open web an agent finds a phone number, a 2019 price list and a CAPTCHA. It can't tell whether a stock count is current, and nothing tells it why a cheaper supplier is a worse choice. A-MERCHANT answers with verified merchants, structured catalogues, a freshness label on every offer, and a reason for every supplier it left out.

## 1. Ask a precise question

```ts
const result = await acard.merchants.search({
  q: "cement",
  quantity: 500,
  lat: -26.2309, lng: 28.1772, radius_km: 60, // the Germiston depot
  max_lead_time_days: 1,                     // needed tomorrow
  max_total_cents: 6_000_000,                // R60 000 budget
});
```

Every constraint you pass is one the ranking enforces instead of one your agent has to remember.

## 2. Read the exclusions first

```ts
for (const e of result.excluded) console.log("skipped:", e.reason);
```

From the demo world, captured from a real run:

```
skipped: only 120 bag available, 500 requested
skipped: 3-day lead time, needed within 1 day
skipped: merchant is pending_kyb
```

The two cheaper suppliers lost for real reasons: Kopanong is R6 a bag cheaper but has only 120 bags, and Soweto Builders is cheapest but can't deliver in time. Vaal Hardware hasn't passed KYB, so it's never offered at all. Your agent can repeat these reasons to the person who owns the budget.

## 3. Take the winner, and know why it won

```ts
const offer = result.offers[0];
console.log(offer.merchant.name, offer.totalCents, offer.distanceKm, offer.freshness, offer.score);
console.log(offer.matchReasons);
```

```
Chose Rand Build Supply: R57 500,00 · 26.3 km · lead 1d · stock fresh (0.0h old) · score 1.000
```

Offers are scored on price, distance, lead time, freshness and earned reliability. The score is deterministic, and **there is no paid placement**: a merchant moves up by having stock, confirming it, quoting honestly and delivering on time.

Treat `freshness` seriously. `fresh` means the merchant confirmed stock in the last 24 hours, `aging` within 7 days, and `stale` beyond that. Pass `max_inventory_age_hours` to refuse stale offers outright.

## 4. Issue a card that can buy exactly this

```ts
const card = await acard.cards.create({
  label: `procure 500 bag ${offer.item.name}`,
  single_use: true,
  limits: { per_transaction: offer.totalCents, total: offer.totalCents },
  allowed_merchant_categories: [offer.merchant.merchantCategoryCode],
});
```

This card can buy R57 500 of supplies from a building-materials merchant **once**. If the agent goes wrong after this point, the damage is bounded by this card, not by your wallet.

## 5. Order

After paying (tutorial 12 handles the approval this charge triggers), place the order. Lines are priced from the merchant's catalogue, never from the caller:

```ts
const order = await acard.merchants.placeOrder(offer.merchant.id, {
  lines: [{ item_id: offer.item.id, quantity: 500 }],
  fulfilment: { method: "delivery", address: "Khaya Logistics depot, 14 Refinery Rd, Germiston" },
  card_transaction_id: transactionId, // evidence for the merchant's reconciliation
});
```

The merchant's till receives the order by signed webhook (tutorial 13). You follow it with `acard.orders.get(order.id)` as it moves `placed → accepted → … → delivered`.

**Runnable version:** [`examples/03-procurement-agent.ts`](../../examples/03-procurement-agent.ts)
**Next:** [12 — Handling approvals in an agent](12-handling-approvals-in-an-agent.md)
