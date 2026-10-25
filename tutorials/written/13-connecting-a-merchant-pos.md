# 13 — Connecting a merchant's till

**You'll build:** the merchant side: a POS integration that syncs stock by SKU, receives agent orders as signed webhooks, verifies them, and accepts what it can fill.
**Time:** 20 minutes · **Prereqs:** a verified merchant, and a merchant API key

Everything so far has been the buyer. This is the supplier, and how well suppliers keep this up is what makes A-MERCHANT worth searching.

## 1. Get a machine key

A shop owner mints a key from their signed-in portal session:

```
POST /v1/merchant-portal/api-keys
{ "name": "Till 1", "scope": "read_write" }
```

The `mk_live_…` secret is shown once and stored only as a hash. It's scoped to one merchant and **can never reach a wallet or a card**. Use `read_only` for analytics integrations that should never change a price.

## 2. Sync stock by your own SKUs

```ts
import { AcardMerchant } from "@acard/sdk";
const shop = new AcardMerchant({ apiKey: process.env.ACARD_MERCHANT_KEY! });

await shop.catalog.sync([
  { sku: "CEM-425-50", name: "Cement 42.5N 50kg", unit: "bag", unit_price_cents: 11_500, quantity_available: 900, lead_time_days: 1 },
  { sku: "SAND-PLS-1T", name: "Plaster sand (1 ton)", unit: "ton", unit_price_cents: 62_000, quantity_available: 40, lead_time_days: 1 },
]);
```

You never learn A-CARD's internal item ids. Up to 500 rows per call, and one bad row never discards the rest (you get a per-SKU breakdown).

**Restating is the most valuable call you make.** Stock confirmed in the last 24 hours ranks as `fresh`, and stale stock ranks down. When a sale happens at the counter, restate:

```ts
await shop.catalog.restate([{ sku: "CEM-425-50", availability: "in_stock", quantity_available: 840 }]);
```

## 3. Receive orders

```ts
const { secret } = await shop.webhook.set("https://pos.example.co.za/acard", ["order.placed", "order.cancelled"]);
// store `secret` (mwh_…) — shown once
```

## 4. Verify before you trust

```ts
import { verifyMerchantWebhook } from "@acard/sdk";

app.post("/acard", express.raw({ type: "application/json" }), async (req, res) => {
  const raw = req.body.toString("utf8");
  const check = verifyMerchantWebhook(raw, req.header("x-acard-signature"), process.env.ACARD_WEBHOOK_SECRET!);
  if (!check.valid) return res.status(401).send(check.reason);
  res.sendStatus(200);                  // acknowledge fast
  await handle(JSON.parse(raw));        // work after
});
```

> ⚠️ **The signing key is `sha256(secret)`, not the secret.** A-CARD keeps only the digest of your `mwh_` secret and signs with that. `verifyMerchantWebhook` derives the key for you. If you write your own verifier, hash the secret first, or every delivery fails `bad_signature`. Details: [webhooks.md](../../docs/reference/webhooks.md#merchant-events).

Verify the **raw bytes**. If you parse and re-serialize the JSON first, the signature won't match.

## 5. Accept what you can fill, and keep the promise

```ts
async function handle(event) {
  if (event.type !== "order.placed") return;
  const order = event.data.order;
  if (!canFill(order)) {
    return shop.orders.advance(order.id, { status: "rejected", note: "Insufficient stock" });
  }
  await shop.orders.advance(order.id, { status: "accepted", promised_at: tomorrowAt10() });
  // …later: "preparing" → "ready" / "dispatched" (with tracking_reference) → "delivered"
}
```

Your **reliability score** comes from this: acceptance rate, fulfilment rate, and punctuality against the `promised_at` *you* set. New merchants start neutral. Promising a time you meet beats promising nothing.

## 6. Don't rely on the push alone

Delivery is attempted **once**, with a 5-second timeout. A failure never breaks the buyer's order, and it's recorded (`consecutiveFailures`) so you can see it. To catch anything you missed:

```ts
for (const missed of await shop.orders.list({ status: "placed" })) await handle({ type: "order.placed", data: { order: missed } });
```

Run that on start-up and every few minutes. To resend one order's event: `shop.orders.redeliver(orderId)`.

**Runnable version:** [`examples/05-merchant-pos-sync.ts`](../../examples/05-merchant-pos-sync.ts)
**Next:** [14 — From sandbox to production](14-from-sandbox-to-production.md)
