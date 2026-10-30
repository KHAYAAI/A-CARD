# Quickstart

Get an agent spending safely in about five minutes. Pick a path. All three hit the same API and the same authorization engine.

| Path | Best for |
|---|---|
| [REST](#rest) | Any language, or seeing exactly what crosses the wire |
| [CLI](#cli) | Poking around and approving charges from a terminal |
| [MCP](#mcp) | Giving Claude (or any MCP client) a card directly |

Prefer an SDK? See [`@acard/sdk`](../packages/sdk/README.md). Prefer a full working agent? See [`examples/`](../examples/README.md).

## Before you start: run the sandbox

```bash
git clone https://github.com/KHAYAAI/A-CARD a-card && cd a-card
npm install
npm run dev:api          # http://localhost:8787 — in-memory, resets on restart
```

The sandbox plays the card issuer itself. Purchases go through the **real** authorization path, but no card network or real money is involved.

Four things to know before your first call:

- **Amounts are integer minor units.** `45000` is R450.00. You'll never send or receive a float.
- **Requests are snake_case, responses are camelCase.** Responses serialize domain objects as-is.
- **A decline isn't an error.** A refused purchase returns `200` with `approved: false` and a `decline_reason`. Errors are non-2xx with `{ error: { code, message } }`.
- **Sandbox keys are prefixed `ak_live_`** even though they're sandbox keys. The prefix doesn't tell you which environment a key belongs to; the deployment URL does.

---

## REST

### 1. Sign up

```bash
API=http://localhost:8787

KEY=$(curl -s -X POST $API/v1/signup \
  -H 'content-type: application/json' \
  -d '{"email":"you@example.co.za","name":"Your Org","currency":"ZAR"}' | jq -r .api_key)
```

The API key is returned **once**. Store it like a password.

### 2. Fund the wallet

```bash
curl -s -X POST $API/v1/wallet/fund \
  -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"amount":1000000}' | jq .wallet
```

```json
{ "available": 1000000, "posted": 1000000, "held": 0, "currency": "ZAR" }
```

### 3. Issue a card for an agent

A grocery-only card: R2 000 per charge, R10 000 in total, reusable.

```bash
CARD=$(curl -s -X POST $API/v1/cards \
  -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -H 'idempotency-key: first-card' \
  -d '{
    "label": "my-first-agent",
    "single_use": false,
    "limits": { "per_transaction": 200000, "total": 1000000 },
    "allowed_merchant_categories": ["5411"]
  }' | jq -r .card.id)
```

Cards are **single-use by default** (they close after their first capture). Pass `"single_use": false` for an agent that shops repeatedly. The `idempotency-key` makes a retry of this exact request safe.

### 4. Make a purchase

```bash
curl -s -X POST $API/v1/simulate/purchase \
  -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d "{\"card_id\":\"$CARD\",\"amount\":45000,\"merchant\":{\"name\":\"Checkers\",\"category\":\"5411\"}}"
```

```json
{ "authorization_id": "sauth_…", "approved": true,
  "wallet": { "available": 955000, "posted": 955000, "held": 0, "currency": "ZAR" } }
```

### 5. Watch it refuse

The same card at a gaming store:

```bash
curl -s -X POST $API/v1/simulate/purchase \
  -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d "{\"card_id\":\"$CARD\",\"amount\":45000,\"merchant\":{\"name\":\"Steam\",\"category\":\"5816\"}}"
```

```json
{ "authorization_id": "sauth_…", "approved": false, "decline_reason": "merchant_category_not_allowed", "wallet": { … } }
```

Every possible reason, and what an agent should do about it, is in [the decline reference](reference/errors.md#decline-reasons).

### 6. See the trail

```bash
curl -s "$API/v1/transactions?card_id=$CARD" -H "authorization: Bearer $KEY" | jq '.transactions[] | {status, amount, merchantName, declineReason}'
```

`bash examples/01-curl-quickstart.sh` runs all of the above in one go.

---

## CLI

```bash
alias acard="npx tsx apps/cli/src/index.ts"   # from the repo root
```

### 1. Sign up

```bash
acard signup        # interactive: email, name, currency
```

The key is saved to `~/.acard/config.json`. If you already have a key, skip the prompt. The CLI reads `ACARD_API_KEY` and `ACARD_API_URL` from the environment (the same variables the MCP server uses), and they take precedence over the config file:

```bash
export ACARD_API_KEY=ak_live_…
export ACARD_API_URL=http://localhost:8787
```

### 2. Fund, issue, buy

```bash
acard fund 500000                     # R5 000.00
acard create-card                     # interactive: label, currency, single-use, per-transaction limit, approval threshold
acard cards                           # card_1ynk…  ****4270  active  my-first-agent

acard simulate-purchase card_1ynk… 30000 "Checkers Sixty60" --mcc 5411
# Approved. Wallet available: ZAR 14250.00

acard simulate-purchase card_1ynk… 30000 "Steam" --mcc 5816
# Declined: merchant_category_not_allowed
```

### 3. Approve what's held for you

Give a card an approval threshold, buy something above it, then:

```bash
acard approvals                       # approve, deny or skip each pending charge
```

After you approve, the agent retries the same charge once and it clears. The approval mints a single-use grant for that card and merchant, up to the approved amount.

| Command | Does |
|---|---|
| `signup` | Create an org; save the key |
| `fund <cents> [--currency USD]` | Instant sandbox credit |
| `balance` | Every currency wallet: available, held, posted |
| `create-card` | Interactive card builder. For totals, velocity and category rules, use the API or MCP. |
| `cards` / `close-card <id>` | List / close |
| `simulate-purchase <card> <cents> <merchant> [--mcc 5411]` | Run a charge through the real authorization path |
| `transactions [--card <id>]` | History, with decline reasons |
| `approvals` | Decide pending charges |

---

## MCP

Give Claude (or any MCP client) its own card. The MCP server is a thin adapter over the REST API, so the agent gets exactly the same guardrails as every other client.

### Claude Desktop

Add this to `claude_desktop_config.json` (Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "acard": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/a-card/apps/mcp/src/index.ts"],
      "env": {
        "ACARD_API_URL": "http://localhost:8787",
        "ACARD_API_KEY": "ak_live_…"
      }
    }
  }
}
```

Restart Claude Desktop, then ask: *"Create a single-use grocery card capped at R500, then pay R120 at Woolworths Food (MCC 5411)."*

### Claude Code

```bash
claude mcp add acard \
  --env ACARD_API_URL=http://localhost:8787 \
  --env ACARD_API_KEY=ak_live_… \
  -- npx tsx /absolute/path/to/a-card/apps/mcp/src/index.ts
```

Or, against a deployed server:

```bash
claude mcp add --transport http acard https://your-api-host/mcp -H "Authorization: Bearer ak_live_…"
```

### A deployed server (Streamable HTTP)

```json
{
  "mcpServers": {
    "acard": {
      "url": "https://your-api-host/mcp",
      "headers": { "Authorization": "Bearer ak_live_…" }
    }
  }
}
```

### The tools

| Tool | Does |
|---|---|
| `create_card` | Issue a card. **Single-use by default.** Limits in cents, MCC allow-list, approval threshold. |
| `get_card` / `list_cards` / `close_card` | Inspect and revoke |
| `pay_checkout` | Charge a card (in the sandbox, simulates the issuer). Declines come back as `approved: false` plus `decline_reason`. A held charge comes back with `approval_id`. |
| `list_transactions` | History, with reasons |
| `get_wallet` | Available / held / posted, per currency |
| `find_offers` | Search A-MERCHANT for verified supply, with freshness and exclusion reasons |
| `pay_x402` | Fetch a URL that charges per request over x402, paid in USDC under the card's limits, allowed hosts and approvals. Needs AFP's x402 rail; see [x402](x402.md) |
| `get_merchant` | A merchant's profile and catalogue |

What a session looks like (captured from the real server):

```
create_card  { label: "mcp-agent", total_limit: 50000, allowed_merchant_categories: ["5411"] }
  → card_x35i…  singleUse: true  limits: { total: 50000 }
pay_checkout { card_id, amount: 12000, merchant_name: "Woolworths Food", merchant_category: "5411" }
  → approved: true
pay_checkout (the same card again)
  → approved: false, decline_reason: "card_closed"     ← single-use did its job
```

> **About `pay_checkout` in production.** In the sandbox, `pay_checkout` plays the card issuer by calling `/v1/simulate/purchase`. With a live issuing partner, the agent pays at a real merchant checkout with the card's credentials, and the issuer calls A-CARD for the decision. The rules, limits and decline reasons are identical either way.

---

## Next

- **Build an agent:** [`examples/03-procurement-agent.ts`](../examples/03-procurement-agent.ts), or Claude with tools in [`examples/02-claude-fuel-agent.ts`](../examples/02-claude-fuel-agent.ts)
- **Handle approvals:** [tutorial](../tutorials/written/12-handling-approvals-in-an-agent.md)
- **Every endpoint:** [API reference](api/reference.md) · [OpenAPI spec](api/openapi.json)
- **Every error and decline:** [errors.md](reference/errors.md)
- **Webhooks:** [webhooks.md](reference/webhooks.md)
