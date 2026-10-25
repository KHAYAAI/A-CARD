# @acard/sdk

TypeScript client for the A-CARD API: issue scoped cards to AI agents, run purchases through the authorization path, handle human approvals, search A-MERCHANT for verified supply, and verify webhooks.

- **Zero runtime dependencies.** Uses the platform `fetch` and `node:crypto`. Node 20+.
- **Safe retries.** Every write carries an `Idempotency-Key`, so the SDK's automatic retries (network errors, 429, 5xx) can never apply twice.
- **Declines aren't exceptions.** A refused purchase returns `approved: false` with a typed `decline_reason`. Only real failures throw `AcardError`.

> **Status:** not yet published to npm. Inside this monorepo, import it as `@acard/sdk` (it's an npm workspace). To use it elsewhere, run `npm run build -w @acard/sdk` and install the package folder.

## Install

```bash
npm install @acard/sdk   # once published
```

## Quickstart

```ts
import { Acard, isAwaitingApproval } from "@acard/sdk";

// 1. Sign up (once). The API key is shown once — store it.
const { api_key } = await Acard.signup({ email: "ops@khaya.example", name: "Khaya Logistics", currency: "ZAR" });

const acard = new Acard({ apiKey: api_key }); // baseUrl defaults to http://localhost:8787

// 2. Fund the sandbox wallet: R50 000.00
await acard.wallet.fund(5_000_000);

// 3. Give an agent a card that can only buy fuel, R5 000 a fill, R40 000 total
const card = await acard.cards.create({
  label: "fleet-agent-07",
  single_use: false,
  limits: { per_transaction: 500_000, total: 4_000_000 },
  allowed_merchant_categories: ["5541", "5542"],
});

// 4. Run a purchase through the real authorization path
const result = await acard.sandbox.purchase({
  card_id: card.id,
  amount: 185_000,
  merchant: { name: "Highveld Tyre & Fuel", category: "5541" },
});

if (result.approved) console.log("paid; available now", result.wallet.available);
else console.log("declined:", result.decline_reason);
```

All amounts are **integer minor units**: `185_000` is R1 850.00.

## Human approvals

```ts
const held = await acard.sandbox.purchase(purchase);

if (isAwaitingApproval(held)) {
  // Someone approves in the dashboard, Slack link, CLI or API…
  const decision = await acard.approvals.waitForDecision(held.approval_id!, { timeoutMs: 15 * 60_000 });

  if (decision.status === "approved") {
    // Retry the same charge once. It consumes a single-use grant
    // for this card and merchant, up to the approved amount.
    await acard.sandbox.purchase(purchase);
  }
}
```

`waitForDecision` polls, because A-CARD doesn't push approval events to account holders yet.

## A-MERCHANT: find and order supply

```ts
const { offers, excluded } = await acard.merchants.search({
  q: "cement",
  quantity: 500,
  lat: -26.2041, lng: 28.0473, radius_km: 25,
  max_lead_time_days: 1,
  categories: card.allowedMerchantCategories, // only what this card can pay for
});

const best = offers[0];            // ranked; there is no paid placement
best.freshness;                    // "fresh" | "aging" | "stale"
excluded.map((e) => e.reason);     // e.g. "only 120 bag available, 500 requested"

const order = await acard.merchants.placeOrder(best.merchant.id, {
  lines: [{ item_id: best.item.id, quantity: 500 }],
  fulfilment: { method: "delivery", address: "Khaya Logistics, Germiston", needed_by: "2026-11-01" },
});
```

## Merchant integrations (POS / ERP)

```ts
import { AcardMerchant, verifyMerchantWebhook } from "@acard/sdk";

const shop = new AcardMerchant({ apiKey: process.env.ACARD_MERCHANT_KEY! }); // mk_live_…

await shop.catalog.sync([{ sku: "CEM-425-50", name: "Cement 42.5N 50kg", unit: "bag", unit_price_cents: 11_500, quantity_available: 900 }]);
await shop.catalog.restate([{ sku: "CEM-425-50", availability: "low_stock", quantity_available: 40 }]);

const { secret } = await shop.webhook.set("https://pos.example.co.za/acard"); // shown once
```

Verifying the push in your endpoint. Use the **raw** body:

```ts
app.post("/acard", express.raw({ type: "application/json" }), (req, res) => {
  const raw = req.body.toString("utf8");
  const check = verifyMerchantWebhook(raw, req.header("x-acard-signature"), process.env.ACARD_WEBHOOK_SECRET!);
  if (!check.valid) return res.status(401).send(check.reason);
  const event = JSON.parse(raw); // { type: "order.placed", data: { order } }
  res.sendStatus(200);
});
```

`verifyMerchantWebhook` takes the `mwh_…` secret you were given and derives the actual signing key, `sha256(secret)`, for you. See [docs/reference/webhooks.md](../../docs/reference/webhooks.md).

## Errors

```ts
import { AcardError } from "@acard/sdk";

try {
  // The free plan caps each USD card at $50.00
  await acard.cards.create({ currency: "USD", limits: { total: 999_999 } });
} catch (error) {
  if (error instanceof AcardError) {
    error.status;    // 402
    error.code;      // "plan_card_cap_exceeded" — branch on this
    error.retryable; // false
    error.issues;    // field-level problems on invalid_request
  }
}
```

Every code is listed in [docs/reference/errors.md](../../docs/reference/errors.md).

## Retries and idempotency

| You do | The SDK does |
|---|---|
| Nothing | Generates an `Idempotency-Key` per write and reuses it across its own retries (2 by default) |
| Pass `{ idempotencyKey }` | Uses yours, so **your** retries of the same operation are safe too |
| `new Acard({ maxRetries: 0 })` | Never retries |

A replay with the same key and the same body returns the original response. The same key with a different body raises `idempotency_conflict`.

## Options

```ts
new Acard({
  apiKey: "ak_…",           // or a sess_… dashboard session
  baseUrl: "https://your-api-host",
  maxRetries: 2,
  timeoutMs: 30_000,
  fetch: customFetch,       // proxies, tests, edge runtimes
});
```

## What's covered

| Area | Methods |
|---|---|
| Org | `Acard.signup`, `me`, `audit` |
| Wallets | `wallet.list`, `wallet.get`, `wallet.fund` |
| Cards | `cards.create`, `list`, `get`, `close` |
| Purchases | `sandbox.purchase`, `transactions.list` |
| Approvals | `approvals.list`, `get`, `approve`, `deny`, `waitForDecision` |
| A-MERCHANT | `merchants.search`, `list`, `get`, `placeOrder`, `orders.list`, `get`, `cancel` |
| Merchant API | `AcardMerchant`: `catalog.list/sync/restate`, `orders.list/advance/redeliver`, `webhook.set/clear`, `me`, `reliability` |
| Webhooks | `verifyMerchantWebhook`, `verifyIssuerWebhook`, `signAcardWebhook` |

Operator, compliance, enterprise-governance and AFP endpoints aren't wrapped yet. Call them over REST using [docs/api/reference.md](../../docs/api/reference.md).

## Tests

`packages/sdk/test/sdk.test.ts` runs every method above against the real API over real HTTP, including a dropped-connection retry and an end-to-end merchant webhook delivery verified with the SDK.
