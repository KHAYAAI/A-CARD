# A-CARD

Virtual cards for AI agents, over MCP — an Agentcard.sh-style platform targeting **South Africa (ZAR) first**, then emerging markets.

Agents get scoped, budget-capped, single-use virtual cards funded from a prepaid wallet — each org holds **ZAR and USD wallets side by side** (and any other supported currency), fully independent, with cards drawing from their own currency. Every charge runs through a real-time authorization path: rules engine → human-in-the-loop approval → double-entry ledger hold. The sandbox ships with a mock issuer (deterministic `4242…` PANs) so the whole system runs locally with zero external dependencies; the issuer integration point is a single signed webhook, designed to be swapped for a real BIN-sponsored partner (Ukheshe/EFT Eclipse, Paymentology, Sudo Africa, Bridgecard, Stripe Issuing).

State is durable and **multi-writer** (a Postgres row-level ledger with per-wallet locks, so several API instances can share one database), access is guarded by both a programmatic API key and human **login with role-based access control**, it's billable (Paystack ZAR subscriptions), and it's deployable to a hardened AWS stack today (private subnets, WAF, optional TLS) — see `infra/cdk`.

## Layout

| Path | What it is |
|---|---|
| `packages/core` | Domain logic: double-entry ledger (holds/captures/releases, overspend guard), card lifecycle, freemium tier limits, hot-path rules engine, human approvals with consumable grants, API keys, users/roles/sessions (auth + RBAC), idempotency, HMAC webhook signing, whole-platform snapshot serialization |
| `apps/api` | Hono REST API: signup, login/RBAC, wallet funding, cards, transactions, approvals, billing (Paystack), the signed issuer webhook (real-time authorization), a sandbox purchase simulator, behind an async `PlatformService` port with two backends — in-memory (+ snapshot) and a Postgres multi-writer row-level ledger (`src/service/`) |
| `apps/mcp` | MCP server — stdio (`index.ts`, for local desktop clients) and Streamable HTTP (`index-http.ts`, for hosting as a real service) — exposing `create_card`, `get_card`, `list_cards`, `pay_checkout`, `close_card`, `list_transactions`, `get_wallet` |
| `apps/cli` | `acard` CLI (commander + clack): signup, fund, create-card, approvals console, purchase simulation |
| `apps/dashboard` | Next.js console: login/register, role-aware wallet stats, card management, transaction history, approve/deny queue, team management |
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

Without `DATABASE_URL`, the API runs in-memory and resets on restart. With it, the default is the **multi-writer Postgres store** (`apps/api/src/service/postgres.ts`): the ledger lives in real `accounts` / `ledger_transactions` / `postings` tables, balances are SQL aggregates, and every authorization takes a `SELECT ... FOR UPDATE` lock on the wallet's account row for the whole decision. Concurrent authorizations on the *same* wallet serialize on that row; different wallets run in parallel — so several API instances can share one database without racing the overspend guard (the CDK stack runs the API at `desiredCount: 2` for exactly this reason).

Set `ACARD_PERSISTENCE=snapshot` to instead use the earlier single-writer model — in-memory with a whole-platform JSONB snapshot after each mutation (`apps/api/src/persistence.ts`), correct only at one instance. Both modes pass the same test suite; the multi-writer path additionally has an integration suite (`apps/api/test/pg-service.test.ts`, gated on `ACARD_TEST_DATABASE_URL`) that proves five concurrent authorizations on a wallet with room for three approve exactly three and never drive the balance negative.

### Login & roles (dashboard)

Beyond the tenant API key (full programmatic access for agents/CLI/MCP), the API has a human auth layer: register/login with a password, a server-side session (`POST /v1/auth/register`, `/login`, `/logout`, `GET /v1/auth/me`), and role-based access control — `owner` > `admin` > `member` > `viewer`. Viewers are read-only; members transact; admins manage billing and team members (`/v1/auth/members`); owners have everything. The `/v1` guard accepts an API key *or* a session (bearer `sess_` token or the httpOnly cookie), and the dashboard ships a login/register screen with a role-aware UI.

### Personal vs Enterprise workspace (chosen at sign-up)

Registration picks a **workspace type** (`account_type: personal | enterprise`). Personal is the default and behaves exactly as before. **Enterprise** unlocks org-scale governance, enforced in the same authorization hot path:

- **Departments** with a monthly budget (`/v1/departments`). A card belongs to a department; when the department's captured+held spend for the month plus a new charge would exceed its budget, the authorization is declined (`department_budget_exceeded`) — a hard cap across all of a team's agents, checked under the same per-wallet row lock as the overspend guard.
- **Org policy** (`/v1/policy`): merchant categories blocked org-wide (declined ahead of per-card rules, `merchant_category_blocked_by_policy`), and an org approval threshold that routes large charges to a human even when the card has none.
- **Audit log** (`/v1/audit`): every authorization decision — approved, declined, or held — with its reason.

All of it lives in `packages/core/src/enterprise.ts`, is enforced in `Platform.authorize`, and is implemented in **both** the in-memory and Postgres multi-writer stores (new `acard_departments` / `acard_org_policies` tables; `account_type` and `department_id` columns added idempotently for existing deployments). The dashboard renders Departments, Policies, and Audit tabs plus a spend-by-department overview for enterprise accounts only. See `apps/demo/enterprise.html` for the standalone pitch demo of the same model.

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
- **Two persistence tiers, one API.** The REST API depends only on an async `PlatformService` port. The in-memory adapter wraps the synchronous `Platform` (sandbox, tests, single-writer snapshot); the Postgres adapter is a real row-level ledger with per-wallet `FOR UPDATE` locks for multi-instance deployments. Same handlers, same tests, either backend — the ledger arithmetic was reimplemented as SQL aggregates for the multi-writer path rather than pretended away.
- **Two auth boundaries.** The API key is a tenant-wide programmatic credential; human access is users + memberships + roles + sessions on top of it. Passwords are scrypt-hashed, session tokens stored only as SHA-256 hashes.
- **The MCP server is a pure protocol adapter**, in both its stdio and HTTP forms. It calls the REST API with an API key, so agents get identical guardrails to any other client — and the HTTP transport is stateless per-request, so it can run behind a load balancer with no sticky sessions.

## What's intentionally not built yet

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
