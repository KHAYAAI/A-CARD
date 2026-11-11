# Changelog

All notable changes to A-CARD. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the API's compatibility promises are in [docs/versioning.md](docs/versioning.md).

**There are no tagged releases yet.** The platform is pre-launch (sandbox only), so entries are grouped by date. The REST API is `v1` throughout. The first tagged release will be `1.0.0` of the API and `0.1.0` of `@acard/sdk`, cut when live card issuance begins.

Each entry is marked **Added**, **Changed**, **Fixed**, **Security** or **Docs**, and notes anything that affects integrators.

---

## [Unreleased]: self-hosted wallet provider and testnet USDC transfer

### Added
- **`apps/wallet-provider`**: a self-hostable embedded-wallet provider. Real key generation (secp256k1, ed25519), AES-256-GCM sealed storage with HKDF per-record keys, EIP-55 / base58 addresses, USDC balances, and signed USDC transfers on EVM test networks (Sepolia, Amoy by default). Solana: keys and balances only; transfers return 501. Per-transfer and daily caps, idempotent transfers, per-wallet nonce serialisation, and a startup refusal of any non-testnet network without `PROVIDER_ALLOW_MAINNET=true`. Unaudited.
- **Provider-backed stablecoin rail** (`apps/api/src/rails/providerStablecoin.ts`), enabled by `ACARD_WALLET_PROVIDER_URL` + `ACARD_WALLET_PROVIDER_KEY`. It pays from the holder's embedded wallet, uses the intent id as the idempotency key, treats an unconfirmed or transport-failed broadcast as reconciling, and reads `carriesRealValue` from the provider. The same variables also turn on signup auto-provisioning of the embedded wallet, which was previously only wired in code.
- Tests against a fake JSON-RPC node that independently decodes and verifies the signed transaction. No real chain was reached.

## [Unreleased]: agent wallet in the MCP server

### Added
- **`@acard/agent-wallet`** (`packages/agent-wallet`): a governed on-chain wallet for agents. Every transfer is previewed, checked against policy (limits, allow and deny lists, sanctions), approved by a person when required, then signed. Sandbox only: a mock chain and a dev signer that refuses real networks.
- **One MCP server for cards and the wallet.** `apps/mcp` mounts the wallet's six tools (`wallet_status`, `get_balances`, `receive_info`, `send_preview`, `send_execute`, `approval_status`) when `ACARD_ENABLE_WALLET=true`; off by default, so the plugin still offers 10 tools. Approvals are decided by an operator out of band: `acard-mcp wallet-approvals`, `wallet-approve <id>`, `wallet-reject <id>`. The plugin bundle and skill are updated.
- **Wallet phases 2–4 (sandbox):** `x402_preview` and `x402_pay` (v1 and v2, a per-request cap and domain allow-list, hosts the policy disallows are never contacted), `swap_quote` and `swap_execute` (pair and slippage policy), `defi_positions` (read-only), an `OpenFireblocksSigner` threshold-signing client, and a mainnet gate (needs the openfireblocks signer and an explicit flag). The stdio server offers 21 tools with the wallet on.
- **The hosted (HTTP) server can offer the wallet** with `ACARD_MCP_HTTP_WALLET=true` and `ACARD_WALLET_OPERATOR_TOKEN`: one wallet per API key in memory (single instance), approvals decided over HTTP with an operator token the agent doesn't hold.

### Changed
- The x402 wire format and URL guard moved to `@acard/agent-wallet`; `apps/api` re-exports them. No behaviour change.
- `get_wallet`'s description now says it is A-CARD's fiat wallet, to tell it apart from the on-chain one.

### Fixed
- Wallet: an execute attempt before approval used up the preview, so the person's approval couldn't be used and the agent had to start over. It no longer does.

---

## [Unreleased]: x402 under card controls, and agent-app plugins

### Added
- **x402 payments governed by A-CARD's card controls**: `POST /v1/afp/x402/pay` and `GET /v1/afp/x402/tabs/{cardId}`, mounted when AFP's x402 rail is configured.
  - An agent names a card, a URL and its own `max_usd`. A-CARD reads the 402, then pays only what the card allows. That covers categories (`x402`), the new per-card `x402_allowed_hosts`, the exact price against `max_usd` and the per-transaction limit, and then the normal authorization: limits, approval thresholds, org policy, department budget and balance.
  - Prices below a cent are charged through a per-card tab, in whole cents as they add up.
  - Payments are recorded before they're signed. An unknown outcome is parked as `reconciling` with the hold kept.
  - Guide: [docs/x402.md](docs/x402.md).
- **x402 wire format v2 and v1.** v2 uses the `PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE` and `PAYMENT-RESPONSE` headers; v1 uses the 402 body, `X-PAYMENT` and `X-PAYMENT-RESPONSE`.
- **A real EIP-3009 signer** (`createEip3009Signer`), checked byte for byte against viem. It starts only with `ACARD_AFP_X402_SIGNER_KEY` **and** `ACARD_AFP_X402_REAL_VALUE=true`, and defaults to Base Sepolia. Mainnet must be listed in `ACARD_AFP_X402_NETWORKS`.
- **`x402_allowed_hosts` on cards** (`POST /v1/cards`; `x402AllowedHosts` on the card). Additive and optional.
- **MCP:** a `pay_x402` tool, and `x402_allowed_hosts` on `create_card`. The stdio server now also reads `~/.acard/config.json`, the CLI's file, when `ACARD_API_KEY` isn't set, and `acard-mcp setup --api-key …` writes it.
- **SDK:** `acard.x402.pay()` and `acard.x402.tab()`, plus `x402_allowed_hosts` on `cards.create()`.
- **Plugins for Claude Code, Codex and OpenClaw** in [`plugins/acard`](plugins/acard/README.md), with marketplaces at `.claude-plugin/marketplace.json` and `.agents/plugins/marketplace.json`. Each was installed through its own CLI. The bundled server (`npm run plugins:build`) runs with plain Node, and a test fails if it's stale.

### Changed
- **AFP's x402 rail** (`POST /v1/afp/intents/:id/execute`) now refuses a quote above the intent's amount, pays only USDC `exact` on configured networks, and refuses non-HTTPS or private-network URLs unless `ACARD_AFP_X402_ALLOW_PRIVATE_NETWORKS=true` (sandbox only). A 5xx after a signed payment is now `reconciling` rather than `failed`, because the server may already have settled it.
- AFP transactions carry an optional `metadata` object (Postgres: an additive `metadata` column).

### Security
- **AFP execute idempotency keys are scoped per organization.** Before, a key was looked up across every org, so one org reusing another's key got that org's transaction back. Keys used before this change won't match on replay.
- x402 URLs are checked against private and reserved address ranges, and redirects aren't followed, so agents can't use A-CARD to reach its own network.

---

## [Unreleased]: developer platform

### Added
- **OpenAPI 3.1 spec** for all 122 operations at [`docs/api/openapi.json`](docs/api/openapi.json), served live at `GET /openapi.json` (unauthenticated). Request schemas are generated from the same zod objects the routes validate with. A test fails if a route exists without documentation, if the committed spec is stale, or if a real response carries a field the spec doesn't document. Validated with Redocly: no errors.
- **Generated API reference** at [`docs/api/reference.md`](docs/api/reference.md), readable on GitHub, plus a Redoc page at `docs/api/index.html`.
- **`@acard/sdk`**, a TypeScript client (`packages/sdk`) with zero runtime dependencies. Automatic idempotency keys on every write, retries on network errors, 429 and 5xx that can never double-apply, typed `DeclineReason`, `AcardError` with stable `code`, `approvals.waitForDecision()`, an `AcardMerchant` client for POS integrations, and webhook verification helpers. Tested over real HTTP against a live API. Not yet published to npm.
- **Example agents** in [`examples/`](examples/README.md): a curl walkthrough, a Claude fuel agent (Anthropic SDK tool runner), a procurement agent, an approval-aware Python agent (standard library only), a merchant POS sync, and `seed-demo-world.ts`. All are exercised by `npm test` against a live API.
- **Docs:** [quickstart](docs/quickstart.md) (REST, CLI, MCP, each run end to end), [error and decline reference](docs/reference/errors.md), [webhooks and events](docs/reference/webhooks.md), [integration guides](docs/integrations/README.md) (Claude, OpenAI Agents SDK, LangChain, Vercel AI SDK), [written tutorials 10–14](tutorials/README.md#written-series-building-on-a-card), and this changelog with a [versioning policy](docs/versioning.md).
- `npm run openapi` regenerates the spec and its markdown reference.

### Changed
- **CLI:** `ACARD_API_KEY` now overrides the key in `~/.acard/config.json`, the same variable the MCP server reads. Additive: existing configs behave as before.
- API request schemas moved from `apps/api/src/app.ts` into `apps/api/src/schemas.ts`. No behaviour change.

### Fixed
- **Merchant webhook signatures were unverifiable as documented.** Deliveries are signed with `sha256(secret)`, the only form A-CARD stores, but a code comment and the implied contract said "verify with the secret you were given", which fails every time. The wire behaviour is unchanged; the contract is now documented correctly, handled by `verifyMerchantWebhook()`, and pinned by an end-to-end test. **Integrators:** derive your HMAC key as the lowercase hex SHA-256 of your `mwh_` secret.
- README: the Postgres-gated test count (63, not 73), and a "not built yet" entry for AFP lifecycle workers that had already shipped.

---

## 2026-09-14: compliance, merchant API, orders

### Added
- **KYC, KYB and AML via Didit**: SA ID verification against Home Affairs, CIPC registry including beneficial owners, sanctions/PEP/adverse-media screening with ongoing monitoring. A-CARD keeps its own records: the provider's decision and a human override are separate fields, and an override never overwrites.
- **Money-movement gating** (`ACARD_COMPLIANCE_ENFORCE`): funding and card issuance return `verification_required` until an org is verified. Computed per request, never cached.
- **AML transaction monitoring** on settled captures (never on the authorization path), including an agent-specific card fan-out rule; **case reading** and **blocklists** checked at signup.
- **Travel Rule and crypto wallet screening**: complete but dormant. They activate on their own when an AFP rail carries real value, never through configuration alone.
- **Per-merchant machine API** (`/v1/merchant-api/*`, `mk_live_` keys, `read_only` / `read_write`): catalogue sync by SKU with per-row results, stock restate, orders, purchase notices.
- **Orders and fulfilment**: `placed → accepted → preparing → ready → dispatched → delivered`, with `rejected` / `cancelled`. Illegal transitions are refused.
- **Supplier reliability**: acceptance, fulfilment, on-time and dispute rates, computed on read, with confidence. New merchants score neutral.
- **Operating hours**: unknown hours read as open.
- **Merchant webhooks**: `order.placed` and `order.cancelled` pushed to a merchant endpoint, signed, attempted once, failures visible, redeliverable.
- **AFP lifecycle workers**: a settlement sweep, and reconciliation that asks the rail and never guesses.

## 2026-09-07

### Added
- **Purchase notices**: buyers report a sale, and the merchant acknowledges (optionally restating stock) or disputes it. No money moves and no stock is decremented automatically.

### Docs
- Reconciled stale test counts and claims across README, launch plan and briefing.

## 2026-09-01: A-MERCHANT and AFP

### Added
- **A-MERCHANT**: supply-side directory and agent discovery. Inventory freshness (`fresh` / `aging` / `stale`), deterministic ranking with no paid placement, exclusion reasons, KYB-gated visibility.
- Operator console, WorkOS-authenticated merchant portal, staff invites, KYB document upload (S3).
- A-MERCHANT **Postgres adapter**, migrated independently, with search proven identical to the in-memory ranking.
- **AFP**: routing engine scoring rails on cost, speed and finality; a cross-rail ledger with typed finality (`instant`, `reversal_window`, `settlement_delay`) and a `reconciling` state for ambiguous outcomes. Card rail live; x402 and stablecoin rails built and sandboxed. Off unless `ACARD_ENABLE_AFP=true`.
- MCP tools `find_offers` and `get_merchant`.

## 2026-08-17 – 2026-08-31: security and billing

### Security
- Card data encrypted at rest (AES-256-GCM); HTTPS enforced server-side (`ACARD_REQUIRE_HTTPS`).
- Login rate limiting: WAF IP guard plus per-account lockout (`account_locked`).
- API key scoping (`read_only`, `spend_cap_cents`) and TOTP multi-factor authentication.
- AWS hardening: CloudTrail, GuardDuty, second NAT, autoscaling, durable WAF/ALB logs, Multi-AZ RDS.

### Added
- **WorkOS SSO**, alongside password and MFA login.
- Cards linked to a real issuer's own card reference, so authorization resolves either id.
- **PayFast** for real ZAR wallet funding and for subscriptions. Tiers: free / $8 / $28 / $2,800, with per-card caps on USD cards.
- Nine-part video tutorial series and high-resolution dashboard stills.

## 2026-07-15 – 2026-08-11: the platform

### Added
- **A-CARD core**: double-entry ledger with an atomic overspend guard, virtual cards with per-transaction / total / velocity limits and MCC allow-lists, single-use cards, the real-time authorization path, human approvals with consumable grants, signed issuer webhooks, a sandbox issuer.
- **MCP server** (stdio and Streamable HTTP), CLI, Next.js dashboard.
- **Durability**: Postgres multi-writer store with per-wallet row locks; snapshot mode for single instances.
- **Human auth and RBAC**: owner > admin > member > viewer.
- **Multi-currency**: ZAR and USD wallets side by side (NGN and KES supported).
- **Enterprise workspaces**: departments with monthly budgets, org policy (blocked categories, org approval threshold), audit log.
- Embedded and external crypto wallet linking.
- **AWS CDK stack**: VPC with private subnets, RDS Postgres, ALB, WAF, TLS, three Fargate services.
- Investor and enterprise demos, platform walkthrough videos, launch plan, deployment runbook, platform briefing.
