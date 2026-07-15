# A-CARD

Virtual cards for AI agents, over MCP — an Agentcard.sh-style platform targeting **South Africa (ZAR) first**, then emerging markets.

Agents get scoped, budget-capped, single-use virtual cards funded from a prepaid wallet. Every charge runs through a real-time authorization path: rules engine → human-in-the-loop approval → double-entry ledger hold. The sandbox ships with a mock issuer (deterministic `4242…` PANs) so the whole system runs locally with zero external dependencies; the issuer integration point is a single signed webhook, designed to be swapped for a real BIN-sponsored partner (Ukheshe/EFT Eclipse, Paymentology, Sudo Africa, Bridgecard, Stripe Issuing).

State is durable (Postgres-backed), billable (Paystack ZAR subscriptions), and deployable to AWS today — see `infra/cdk`.

## Layout

| Path | What it is |
|---|---|
| `packages/core` | Domain logic: double-entry ledger (holds/captures/releases, overspend guard), card lifecycle, freemium tier limits, hot-path rules engine, human approvals with consumable grants, API keys, idempotency, HMAC webhook signing, whole-platform snapshot serialization |
| `apps/api` | Hono REST API: signup, wallet funding, cards, transactions, approvals, billing (Paystack), the signed issuer webhook (real-time authorization), a sandbox purchase simulator, and Postgres-backed persistence |
| `apps/mcp` | MCP server — stdio (`index.ts`, for local desktop clients) and Streamable HTTP (`index-http.ts`, for hosting as a real service) — exposing `create_card`, `get_card`, `list_cards`, `pay_checkout`, `close_card`, `list_transactions`, `get_wallet` |
| `apps/cli` | `acard` CLI (commander + clack): signup, fund, create-card, approvals console, purchase simulation |
| `apps/dashboard` | Next.js console: wallet stats, card management, transaction history, approve/deny queue |
| `infra/cdk` | AWS CDK stack: VPC, RDS Postgres, ALB, three Fargate services — `npx cdk deploy` and you have a live URL |

## Quick start

```bash
npm install
npm test                 # 43 tests: ledger invariants, auth flow, approvals, billing, webhooks, API e2e
npm run dev:api          # sandbox API on :8787 (in-memory unless DATABASE_URL is set)
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

### Durable state (Postgres)

```bash
docker compose up -d postgres
DATABASE_URL=postgres://acard:acard@localhost:5432/acard npm run dev:api
```

Without `DATABASE_URL`, the API runs exactly as before — in-memory, reset on restart. With it, the whole platform state (ledger, cards, approvals, API keys) is snapshotted to Postgres after every mutating request and reloaded on boot. This is a single-writer model — correct for one API instance, documented as the next step before scaling to several (see `apps/api/src/persistence.ts`).

### Billing (Paystack, ZAR subscriptions)

Three tiers — `free` (5 cards/month), `basic` (R149/mo, 25 cards), `pro` (R499/mo, 100 cards) — enforced in `packages/core/src/billing.ts`. Set `PAYSTACK_SECRET_KEY` and `PAYSTACK_WEBHOOK_SECRET` (see the external dependencies list) to enable `POST /v1/billing/checkout` and the `/webhooks/paystack` upgrade flow. Omit both and every account just stays on the free tier.

### Approval notifications (Slack)

Set `SLACK_APPROVALS_WEBHOOK_URL` and every `approval.requested` event posts to that channel with a link back to the dashboard. Omit it and approvals are still fully functional — just check the dashboard or `acard approvals` instead of getting pinged.

### MCP (Claude Desktop / Claude Code — local, stdio)

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

### MCP (remote, once deployed)

```json
{
  "mcpServers": {
    "acard": {
      "url": "https://<your-alb-or-domain>/mcp",
      "headers": { "Authorization": "Bearer ak_live_..." }
    }
  }
}
```

## Deploying to AWS

```bash
cd infra/cdk
npm install
npx cdk bootstrap aws://<account-id>/<region>
npx cdk deploy --parameters IssuerWebhookSecret="$(openssl rand -hex 32)"
```

10–15 minutes later you have a live URL (dashboard, API, and MCP server, all behind one ALB, path-routed) backed by a real Postgres instance. Full details, cost tradeoffs, and the production-hardening checklist are in `infra/cdk/README.md`.

## How an authorization is decided

1. Merchant charge hits the issuer; the issuer calls `POST /webhooks/issuer` with an HMAC-signed `authorization.request` (Stripe-style `t=…,v1=…` header, timing-safe verify, replay-window check).
2. The decision path (`Platform.authorize`) is synchronous and in-memory — built for a sub-2-second issuer window:
   - exactly-once guard on the issuer authorization id
   - rules pass: card active, currency, MCC allow-list, per-transaction / total / velocity limits
   - approval threshold: above it, the auth is declined with `pending_human_approval` and an approval request is opened (and pushed to Slack if configured); a human decision creates a **grant** the retried authorization consumes (amount-bounded, single-use)
   - atomic **hold** against wallet available balance in the double-entry ledger — the overspend guard
3. `transaction.capture` settles the hold (partial capture supported); single-use cards auto-close. `authorization.reversal` releases funds.

The sandbox's `POST /v1/simulate/purchase` plays the issuer: it signs a webhook and feeds it through the real verification path, so what you test locally is the exact production code path.

## Design decisions

- **Money is integer minor units everywhere.** No floats near a balance.
- **The ledger is the source of truth.** Every top-up, hold, capture, and release is a balanced double-entry transaction; available balance = posted − held, and holds are refused beyond it.
- **PANs stay out of scope.** Only the sandbox generates (test) PANs; the production plan is issuer-hosted credentials so the platform never enters PCI scope.
- **Durability without rewriting the ledger into SQL.** `Platform.serialize()`/`Platform.hydrate()` snapshot the whole in-memory state to a single Postgres row after every request. It's honest about being single-writer — a real multi-instance deployment needs row-level ledger tables, noted as the next step rather than pretended away.
- **The MCP server is a pure protocol adapter**, in both its stdio and HTTP forms. It calls the REST API with an API key, so agents get identical guardrails to any other client — and the HTTP transport is stateless per-request, so it can run behind a load balancer with no sticky sessions.

## What's intentionally not built yet

- **Multi-user dashboard auth (Better Auth/RBAC).** The API's real security boundary is the API key, which is enforced everywhere. A full login system with per-user roles is the next layer, not a blocker to deploying — building half of it would be worse than being explicit that it's not there yet.
- **Fraud ML.** The rules engine carries hot-path decisions today, which is the correct sequencing — ML scoring is a post-launch layer.
- **KYC/FICA.** Deliberately not built in-house — this should ride the issuing partner's compliance, not duplicate it, so it depends on which issuer is chosen.
- **A contracted issuer.** No code gap — the webhook contract is issuer-agnostic and already built. This is a business relationship, not an engineering task; see the external dependencies list for where to start.

## Scripts

```bash
npm test              # vitest across all workspaces
npm run typecheck     # tsc over core, api, mcp, cli
npm run dev:api       # API on :8787
npm run dev:mcp       # MCP server, stdio (needs ACARD_API_KEY)
npm run dev:dashboard # Next.js on :3000
docker compose up -d  # Postgres for local durable-state testing
```
