# A-CARD

Virtual cards for AI agents, over MCP — an Agentcard.sh-style platform targeting **South Africa (ZAR) first**, then emerging markets.

Agents get scoped, budget-capped, single-use virtual cards funded from a prepaid wallet. Every charge runs through a real-time authorization path: rules engine → human-in-the-loop approval → double-entry ledger hold. The sandbox ships with a mock issuer (deterministic `4242…` PANs) so the whole system runs locally with zero external dependencies; the issuer integration point is a single signed webhook, designed to be swapped for a real BIN-sponsored partner (Ukheshe/EFT Eclipse, Paymentology, Sudo Africa, Bridgecard, Stripe Issuing).

## Layout

| Path | What it is |
|---|---|
| `packages/core` | Domain logic: double-entry ledger (holds/captures/releases, overspend guard), card lifecycle, hot-path rules engine, human approvals with consumable grants, API keys, idempotency, HMAC webhook signing |
| `apps/api` | Hono REST API: signup, wallet funding, cards, transactions, approvals, the signed issuer webhook (real-time authorization), and a sandbox purchase simulator |
| `apps/mcp` | MCP server (stdio) exposing `create_card`, `get_card`, `list_cards`, `pay_checkout`, `close_card`, `list_transactions`, `get_wallet` |
| `apps/cli` | `acard` CLI (commander + clack): signup, fund, create-card, approvals console, purchase simulation |
| `apps/dashboard` | Next.js console: wallet stats, card management, transaction history, approve/deny queue |

## Quick start

```bash
npm install
npm test                 # 30 tests: ledger invariants, auth flow, approvals, webhooks, API e2e
npm run dev:api          # sandbox API on :8787
```

Onboard and transact (separate terminal):

```bash
npx tsx apps/cli/src/index.ts signup          # interactive; saves key to ~/.acard/config.json
npx tsx apps/cli/src/index.ts fund 100000     # R1000.00 (amounts are integer cents)
npx tsx apps/cli/src/index.ts create-card
npx tsx apps/cli/src/index.ts simulate-purchase <card_id> 20000 "Checkers Sixty60" --mcc 5411
npx tsx apps/cli/src/index.ts approvals       # decide anything routed to a human
```

Dashboard:

```bash
npm run dev:dashboard    # :3000 — paste your API key to connect
```

### MCP (Claude Desktop / Claude Code)

```json
{
  "mcpServers": {
    "acard": {
      "command": "npx",
      "args": ["tsx", "/path/to/A-CARD/apps/mcp/src/index.ts"],
      "env": {
        "ACARD_API_URL": "http://localhost:8787",
        "ACARD_API_KEY": "ak_live_..."
      }
    }
  }
}
```

## How an authorization is decided

1. Merchant charge hits the issuer; the issuer calls `POST /webhooks/issuer` with an HMAC-signed `authorization.request` (Stripe-style `t=…,v1=…` header, timing-safe verify, replay-window check).
2. The decision path (`Platform.authorize`) is synchronous and in-memory — built for a sub-2-second issuer window:
   - exactly-once guard on the issuer authorization id
   - rules pass: card active, currency, MCC allow-list, per-transaction / total / velocity limits
   - approval threshold: above it, the auth is declined with `pending_human_approval` and an approval request is opened; a human decision creates a **grant** the retried authorization consumes (amount-bounded, single-use)
   - atomic **hold** against wallet available balance in the double-entry ledger — the overspend guard
3. `transaction.capture` settles the hold (partial capture supported); single-use cards auto-close. `authorization.reversal` releases funds.

The sandbox's `POST /v1/simulate/purchase` plays the issuer: it signs a webhook and feeds it through the real verification path, so what you test locally is the exact production code path.

## Design decisions

- **Money is integer minor units everywhere.** No floats near a balance.
- **The ledger is the source of truth.** Every top-up, hold, capture, and release is a balanced double-entry transaction; available balance = posted − held, and holds are refused beyond it.
- **PANs stay out of scope.** Only the sandbox generates (test) PANs; the production plan is issuer-hosted credentials so the platform never enters PCI scope.
- **In-memory stores behind interfaces.** `LedgerStore`, approvals, keys, and idempotency are swappable for Postgres/Blnk/Redis adapters (`docker-compose.yml` stubs the infra) without touching business logic.
- **The MCP server is a pure protocol adapter.** It calls the REST API with an API key, so agents get identical guardrails to any other client.

## Roadmap (production path)

1. Postgres adapters for ledger/platform state; Redis + BullMQ for webhook retries and notifications
2. Real issuer integration behind the existing webhook contract (Sudo Africa / Bridgecard sandbox first; Ukheshe Eclipse or Paymentology for SA production — start those sales conversations early, they are the critical path)
3. Better Auth for dashboard login; ntfy/Slack push for approval notifications (HumanLayer-style)
4. Lago metering + Paystack ZAR subscription collection for freemium tiers
5. ZEN Engine for user-editable decision rules; ML fraud scoring off the hot path
6. FICA/KYC via the issuing partner; POPIA review

## Scripts

```bash
npm test              # vitest across all workspaces
npm run typecheck     # tsc over core, api, mcp, cli
npm run dev:api       # API on :8787
npm run dev:mcp       # MCP server (needs ACARD_API_KEY)
npm run dev:dashboard # Next.js on :3000
```
