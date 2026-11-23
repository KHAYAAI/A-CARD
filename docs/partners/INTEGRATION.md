# A-CARD partner kit: integration guide

For platforms that embed A-CARD: your users get agent cards with spending rules under your brand; you hold one contract and one API key. **Sandbox: test money only** until live products are announced.

## 1. Get sandbox keys (5 minutes)
1. Sign up at the dashboard (sandbox: https://acard-dash-za.fly.dev), or by API:
   ```bash
   curl -X POST https://acard-api.fly.dev/v1/signup -H 'content-type: application/json' \
     -d '{"email":"you@yourplatform.com","name":"Your Platform","currency":"USD"}'
   ```
   The response holds your API key (`ak_…`), shown once. Store it as a secret.
2. Become a partner: dashboard → **Partner program** → *Become a partner*, or `POST /v1/partner`.
3. Everything in the sandbox is simulated: fund wallets with `POST /v1/wallet/fund`, run purchases with the purchase simulator.

## 2. Create your customers
```ts
import { Acard } from "@acard/sdk";
const acard = new Acard({ apiKey: process.env.ACARD_API_KEY!, baseUrl: "https://acard-api.fly.dev" });

await acard.partner.enroll({ name: "Your Platform", brand: { display_name: "YourPay", logo_url: "https://you.com/logo.png", primary_color: "#5B21B6", support_email: "help@you.com" } });
await acard.partner.customers.create({ email: "ann@example.com", name: "Ann", external_ref: "user-42" });
```
Use your own user id as `external_ref`; you never need to store ours.

## 3. Act for a customer
Every A-CARD route works for a customer when you send your key plus one header:
```
Authorization: Bearer ak_…            (yours)
A-Card-Customer: user-42              (their external_ref or account_holder_id)
```
```ts
const ann = acard.forCustomer("user-42");
const card = await ann.cards.create({ label: "Ann's shopping agent", limits: { per_transaction: 5_000, total: 20_000 } });
await ann.wallet.fund(50_000, "USD"); // sandbox: $500 of test money
```
- Customers are isolated from each other and from your own account.
- A header naming someone who isn't your customer is refused (404).
- `/v1/partner/*` routes act for you, so they refuse the header (400).
- A read-only partner key stays read-only when acting.
- Responses carry `A-Card-Acting-For: <account_holder_id>` so you can log who was affected.

## 4. Your brand (white label)
- `PUT /v1/partner/brand` sets `display_name`, `logo_url` (https), `primary_color` (#RRGGBB), `support_email`, `support_url`.
- `GET /v1/branding` (as the customer) returns the brand to show. The A-CARD dashboard uses it already: your customers see your name, logo and colour, with "Powered by A-CARD".
- Approvals, emails and the card form you host yourself should read `/v1/branding` too.

## 5. Agents through MCP
Give each customer's agent the A-CARD MCP server with your key and their id:
```bash
claude mcp add --transport http acard https://mcp.a-card.cc/mcp \
  --header "Authorization: Bearer ak_…" --header "A-Card-Customer: user-42"
```
Local (stdio): set `ACARD_API_KEY`, `ACARD_CUSTOMER=user-42`, then `npx acard-mcp`. Each customer gets its own agent wallet.

## 6. Revenue share
- `GET /v1/partner/revenue?month=2026-11`: your statement. Card volume per customer and currency, active cards, and A-CARD's fees.
- Fees (default terms; your contract may differ): **1% of card volume + $0.50 per active card, with a $300 monthly minimum** that usage counts towards. Amounts are in cents.
- Distribution partners who introduced you are paid from A-CARD's share, never added to your bill.

## 7. Go-live checklist
- [ ] Contract signed; terms set on your partner account
- [ ] Brand set; support email answered
- [ ] Your terms of service point users to A-CARD's Terms and Privacy Policy (`docs/legal/`)
- [ ] Customers verified (KYC) before live money
- [ ] Spending rules and approval thresholds chosen per customer
- [ ] Webhooks or polling for declines and approvals
- [ ] Keys in a secret manager; rotation plan

## For A-CARD staff (operator)
Set `ACARD_OPERATOR_TOKEN` (32+ chars) on the API, then:
```bash
OP="Authorization: Bearer $ACARD_OPERATOR_TOKEN"
curl -X POST $API/v1/operator/distributors -H "$OP" -H 'content-type: application/json' -d '{"name":"Agent Tools Hub","share_bps":2000}'
curl -X PUT  $API/v1/operator/partners/ptn_… -H "$OP" -H 'content-type: application/json' -d '{"volume_bps":100,"per_active_card":50,"monthly_minimum":30000,"distributor_id":"dst_…"}'
curl "$API/v1/operator/revenue?month=2026-11" -H "$OP"   # every statement + distributor payouts
```
