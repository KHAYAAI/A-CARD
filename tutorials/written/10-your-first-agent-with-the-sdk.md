# 10 — Your first agent with the SDK

**You'll build:** a script that gives an agent a fuel card, buys diesel, gets declined twice for the right reasons, and prints the audit trail.
**Time:** 10 minutes · **Prereqs:** episodes 2–3, or just `npm install` and `npm run dev:api`

The videos covered the platform from the dashboard and terminal. From here the series is written, and it's about building on A-CARD from code.

## 1. Set up

Inside this repo, `@acard/sdk` is already an npm workspace. In your own project, build it once (`npm run build -w @acard/sdk`) and install the folder, until it's published to npm.

```ts
// first-agent.ts
import { Acard, AcardError } from "@acard/sdk";

const { api_key } = await Acard.signup({ email: "ops@khaya.example", name: "Khaya Logistics", currency: "ZAR" });
const acard = new Acard({ apiKey: api_key }); // http://localhost:8787 by default
```

The key is returned once. In a real app, sign up once, store the key in your secret manager, and construct the client from it.

## 2. Fund and issue

```ts
await acard.wallet.fund(5_000_000); // R50 000.00 — amounts are integer cents

const card = await acard.cards.create({
  label: "fleet-agent-07",
  single_use: false,                                  // cards are single-use unless you say otherwise
  limits: {
    per_transaction: 500_000,                         // R5 000 a fill
    total: 4_000_000,                                 // R40 000 lifetime
    velocity: { amount: 1_500_000, window_seconds: 86_400 }, // R15 000 a day
  },
  allowed_merchant_categories: ["5541", "5542"],      // fuel stations only
});
```

Each limit is a separate check. Choose them the way you'd brief a new driver: what they buy, how much at once, how much a day, how much ever.

## 3. Buy, and get told no

```ts
const fuel = await acard.sandbox.purchase({ card_id: card.id, amount: 415_800, merchant: { name: "Highveld Tyre & Fuel", category: "5541" } });
console.log(fuel.approved); // true

const tv = await acard.sandbox.purchase({ card_id: card.id, amount: 90_000, merchant: { name: "Game Electronics", category: "5732" } });
console.log(tv.decline_reason); // "merchant_category_not_allowed"

const big = await acard.sandbox.purchase({ card_id: card.id, amount: 693_000, merchant: { name: "Highveld Tyre & Fuel", category: "5541" } });
console.log(big.decline_reason); // "per_transaction_limit_exceeded"
```

**A decline is not an exception.** The call succeeded and the answer was no. `sandbox.purchase` plays the card issuer and runs the real authorization path, the same code a live issuer's webhook hits.

## 4. Read the trail

```ts
for (const t of await acard.transactions.list({ cardId: card.id })) {
  console.log(t.status.padEnd(9), String(t.amount).padStart(8), t.merchantName, t.declineReason ?? "");
}
```

```
declined    693000 Highveld Tyre & Fuel per_transaction_limit_exceeded
declined     90000 Game Electronics merchant_category_not_allowed
completed   415800 Highveld Tyre & Fuel
```

Newest first. Every decision is recorded, including the refusals.

## 5. Handle real errors

Errors are the other kind of failure: a bad request, a missing permission, a plan limit.

```ts
try {
  await acard.cards.create({ currency: "USD", limits: { total: 999_999 } });
} catch (error) {
  if (error instanceof AcardError && error.code === "plan_card_cap_exceeded") {
    console.log("The free plan caps a USD card at $50 — lower the total or upgrade.");
  } else throw error;
}
```

Branch on `error.code`, never on `message`. Every code is in [errors.md](../../docs/reference/errors.md).

## What to take away

- **Limits are arithmetic, not advice.** The agent can't argue with `per_transaction_limit_exceeded`.
- **Declines are data.** Feed `decline_reason` back to your agent so it can explain itself.
- **Retries are safe.** The SDK sends an `Idempotency-Key` on every write and reuses it when it retries.

**Next:** [11 — Finding supply with A-MERCHANT](11-finding-supply-with-a-merchant.md)
