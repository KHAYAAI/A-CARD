# A-CARD examples

Runnable agents and integrations. Each one runs against the local sandbox by default, and against any deployment if you set `ACARD_API_URL`.

| Example | What it shows | Language | Needs |
|---|---|---|---|
| [`01-curl-quickstart.sh`](01-curl-quickstart.sh) | Sign up → fund → card → approved purchase → two declines → audit trail | Bash | `curl`, `jq` |
| [`02-claude-fuel-agent.ts`](02-claude-fuel-agent.ts) | **Claude** buying fuel inside card limits it can't talk its way past | TypeScript | `ANTHROPIC_API_KEY` |
| [`03-procurement-agent.ts`](03-procurement-agent.ts) | Search A-MERCHANT → single-use card sized to the offer → wait for a human → pay → order | TypeScript | — |
| [`04-approval-aware-agent.py`](04-approval-aware-agent.py) | The one decline that expects a retry: `pending_human_approval` | Python 3 (stdlib only) | — |
| [`05-merchant-pos-sync.ts`](05-merchant-pos-sync.ts) | A merchant's till: stock sync by SKU, verified order webhooks, auto-accept | TypeScript | a merchant key `mk_live_…` |
| [`seed-demo-world.ts`](seed-demo-world.ts) | Seeds Khaya Logistics: wallets, departments, policy, 3 agent cards, 5 merchants | TypeScript | — |

All of them are exercised by [`test/examples.test.ts`](test/examples.test.ts) against a live API on every `npm test`. The bash and Python examples run as real child processes. The Claude example's tools are tested directly, because calling the model needs Anthropic credentials the test suite doesn't assume.

## Run them

```bash
# from the repo root
npm install
npm run dev:api                       # terminal 1: the sandbox API on :8787

cd examples                           # terminal 2
npx tsx seed-demo-world.ts            # prints an API key and the card ids
export ACARD_API_KEY=ak_…             # from the seed output

bash 01-curl-quickstart.sh            # makes its own fresh org
npx tsx 03-procurement-agent.ts       # approve it from terminal 3 (below) when it waits
CARD_ID=card_… python3 04-approval-aware-agent.py   # the procurement-bot-03 card id

FLEET_CARD_ID=card_… ANTHROPIC_API_KEY=sk-ant-… npx tsx 02-claude-fuel-agent.ts
```

Approving a held charge while an agent waits (terminal 3):

```bash
ACARD_API_KEY=ak_… npx tsx ../apps/cli/src/index.ts approvals
# or: curl -X POST localhost:8787/v1/approvals/<id>/approve -H "authorization: Bearer $ACARD_API_KEY"
```

### The merchant side

The merchant example needs a merchant API key. A shop owner mints one with `POST /v1/merchant-portal/api-keys` (body `{ "name": "Till 1", "scope": "read_write" }`) from their signed-in portal session. The portal UI doesn't have a screen for this yet. In tests, the key is minted directly on the in-memory platform. Then:

```bash
ACARD_MERCHANT_KEY=mk_live_… npx tsx 05-merchant-pos-sync.ts
```

A-CARD pushes to `http://127.0.0.1:<port>/acard`. If your API runs somewhere that can't reach your machine, expose the port (e.g. with ngrok) and set `PUBLIC_WEBHOOK_URL`.

## What each one teaches

**01: the shape of the API.** Integer cents, snake_case requests, camelCase responses, idempotency keys, and declines that come back as `approved: false` with a reason rather than as errors.

**02: Claude inside guardrails.** Three tools (`check_card`, `find_fuel`, `pay_for_fuel`) wrap SDK calls, and the Anthropic SDK's tool runner drives the loop on `claude-opus-5-5`. Truck 14 needs 180 L (R4 158, approved). Truck 9 needs 300 L (R6 930), which is over the R5 000 per-fill limit, so A-CARD declines it with `per_transaction_limit_exceeded`. The system prompt tells Claude not to split the purchase to get around that, so it reports what a human needs to do instead. Server-side refusal fallback (`fallbacks: "default"`) is on, so a safety-classifier decline is retried on a fallback model instead of ending the run. Remove it if you'd rather see the refusal.

**03: the deterministic agent skeleton.** The steps every agent framework wraps: find supply, issue a card that can buy exactly that and nothing else (single-use, capped at the offer total, locked to the merchant's MCC), pay, wait if a human must decide, then order, citing the card transaction so the merchant can reconcile. The search output shows why other suppliers were skipped: *only 120 bag available, 500 requested*, a 3-day lead time, and so on.

**04: approvals without an SDK.** Plain `urllib`. Poll until decided, then retry the same charge **once**, because it consumes a single-use grant for that card and merchant, up to the approved amount. Any other decline is final.

**05: being a good supplier.** Sync stock by your own SKUs, verify every webhook (with `sha256(secret)` as the key, handled by `verifyMerchantWebhook`), acknowledge fast, accept only what you can fill, promise a time, restate stock as soon as you commit it, and reconcile `GET /v1/merchant-api/orders?status=placed` on start-up, because delivery is attempted only once.

## The demo world

`seed-demo-world.ts` builds the same world the videos and screenshots use. Merchant names are fictional.

| | |
|---|---|
| Org | Khaya Logistics (enterprise) — R500 000 + $10 000 |
| Departments | Fleet R250 000/mo · Procurement R400 000/mo · Engineering R50 000/mo |
| Policy | MCC 7995 (gambling) blocked org-wide · org approval threshold R25 000 |
| `fleet-agent-07` | Fleet · MCC 5541/5542/7538 · R5 000 per fill · R40 000 total · R15 000 per 24 h |
| `procurement-bot-03` | Procurement · MCC 5200/5211/5251 · R25 000 per transaction · approval above R8 000 |
| `api-agent` | Engineering · USD · MCC 5734/7372 · $20 per transaction · $50 total (free-plan cap) |
| Rand Build Supply | Midrand · cement R115/bag, 900 in stock, next day |
| Kopanong Cement | Germiston · R109/bag but only 120 in stock |
| Soweto Builders Depot | Soweto · R104/bag, 3-day lead time |
| Highveld Tyre & Fuel | Boksburg · diesel R23.10/L, truck tyres |
| Vaal Hardware | Vereeniging · **pending KYB**, so it's invisible to agents |
