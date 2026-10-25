# 14 — From sandbox to production

**You'll learn:** exactly what changes when an integration leaves the sandbox, what doesn't, and what isn't live yet.
**Time:** 10 minutes to read · **Prereqs:** episode 9 (deploying to AWS)

## What doesn't change

The point of the sandbox is that the decision path **is** the production path. `/v1/simulate/purchase` signs an `authorization.request` and feeds it through the same `/webhooks/issuer` handler a live issuer calls. Your rules, limits, decline reasons, approvals, idempotency, ledger and audit trail all behave identically.

## What changes

| In the sandbox | In production | What you change |
|---|---|---|
| `sandbox.purchase` / MCP `pay_checkout` simulate the issuer | The agent pays at a real merchant checkout with the card's credentials, and the issuer asks A-CARD for each decision | How your agent *pays*: it uses card credentials at checkout instead of calling the simulator |
| Card creation returns a test `sandboxPan` once | Cards are provisioned with the issuing partner and credentials are issuer-hosted. A-CARD never sees a PAN. | Fetch card credentials from the issuer's hosted flow, never from A-CARD |
| `wallet.fund` credits instantly | Real ZAR top-ups go through PayFast checkout, and the wallet is credited only on a verified ITN. Instant ZAR funding returns `instant_funding_disabled`. | Use `POST /v1/wallet/fund/checkout` for ZAR |
| Verification runs against a sandbox provider that approves almost everyone | Didit runs real KYC/KYB/AML. With enforcement on, funding and card issuance return `verification_required` until verified. | Complete verification before going live; handle `verification_required` |
| In-memory state, resets on restart | Postgres, multi-writer, per-wallet row locks | Nothing: same API |
| `http://localhost:8787` | Your deployment's HTTPS URL. With `ACARD_REQUIRE_HTTPS=true` (set automatically when the CDK stack is deployed with a domain), plain HTTP is refused with `https_required`. | `baseUrl` |

## Keys

- Keys start `ak_live_` in **both** environments. Keep sandbox and production keys in separate secret stores, and never let a sandbox key near production config.
- Give every agent **its own key**. Use `read_only` for agents that only look, and `spend_cap_cents` to cap the total card budget a key can ever provision.
- Revoke instantly with `DELETE /v1/keys/{id}`.

## Before you flip the switch

- [ ] Every card an agent uses has a `total` limit and an MCC allow-list. No card should be "anything, anywhere".
- [ ] Approval thresholds are set on the org (`PUT /v1/policy`), not only on individual cards.
- [ ] Your agent handles `pending_human_approval` by waiting, and every other decline by stopping ([tutorial 12](12-handling-approvals-in-an-agent.md)).
- [ ] Writes send an `Idempotency-Key` (the SDK does this automatically).
- [ ] Someone is subscribed to approval notifications in Slack, so a held charge is seen within minutes.
- [ ] Merchant integrations verify webhooks with `sha256(secret)` and reconcile `?status=placed` on a schedule.

## What isn't live yet (so you can plan around it)

- **Card issuance with a live BIN sponsor.** The issuer integration is built and swappable. Live issuance starts once the issuing partnership is contracted.
- **Account-holder webhooks.** Approval and authorization events don't push to your endpoint yet, so poll `/v1/approvals` and `/v1/transactions`.
- **AFP's non-card rails.** x402 and stablecoin are built and gated. Bank/EFT is planned. Only the card rail moves money today.
- **A published SDK on npm.** Build it from this repo for now.

These are tracked in the [changelog](../../CHANGELOG.md). See [versioning](../../docs/versioning.md) for what we promise not to break while they land.
