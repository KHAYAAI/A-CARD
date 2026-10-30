# A-CARD API reference

> Generated from `docs/api/openapi.json` (version 1.0.0) by `npm run openapi`. Do not edit by hand.

Spending infrastructure for AI agents: scoped virtual cards, a double-entry ledger, human approvals, the A-MERCHANT supply directory, and AFP payment routing.

**Conventions.** Amounts are integer minor units (cents) everywhere. Request bodies are snake_case; responses serialize domain objects and are camelCase. Every error has the shape `{ error: { code, message } }` — branch on `code`, never on `message`.

**Versioning.** The `/v1` prefix is the API version. Additive changes ship without notice; breaking changes get a new prefix. See docs/versioning.md.

## Authentication

| Scheme | How to send it | Notes |
|---|---|---|
| `apiKey` | `Authorization: Bearer …` | Tenant API key, `ak_…`. Full programmatic access, or viewer-only for read_only keys. |
| `session` | `Authorization: Bearer …` | Human session, `sess_…` (or the httpOnly `acard_session` cookie). Permissions follow the user's role. |
| `merchantSession` | cookie `acard_merchant_session` | Merchant portal session (a bearer merchant session token is also accepted). |
| `merchantKey` | `Authorization: Bearer …` | Merchant machine key, `mk_live_…`. Scoped to one merchant; can never reach a wallet or card. |
| `webhookSignature` | header `x-acard-signature` | `t=<unix>,v1=<hex HMAC-SHA256 of "t.rawBody">` |

## Contents

- [Meta](#meta) — Health and this document.
- [Onboarding](#onboarding) — Create an organization and get an API key.
- [Auth](#auth) — Human login, sessions, MFA and SSO for the dashboard.
- [Team](#team) — Members and roles: owner > admin > member > viewer.
- [Enterprise](#enterprise) — Departments with monthly budgets, org-wide policy, and the audit log.
- [Wallets](#wallets) — Prepaid balances per currency, and linked crypto wallets.
- [Cards](#cards) — Scoped virtual cards with limits, category rules and approval thresholds.
- [Transactions](#transactions) — Every authorization, capture and decline, with reason codes.
- [Approvals](#approvals) — Charges held for a human, and the single-use grants approvals mint.
- [API keys](#api-keys) — Programmatic credentials, full or read-only.
- [SSO](#sso) — Federate an organization to its own identity provider.
- [Billing](#billing) — Subscription plans and upgrades.
- [Inbound webhooks](#inbound-webhooks) — Endpoints other systems call: the card issuer, PayFast, and the verification provider.
- [Sandbox](#sandbox) — Exercise the real authorization path without a card network.
- [A-MERCHANT](#a-merchant) — Agent-facing supply discovery, merchant detail, orders and purchase notices.
- [Merchant operations](#merchant-operations) — Operator-side merchant onboarding, KYB and catalogue management.
- [Merchant portal](#merchant-portal) — A merchant's own staff, signed in through the portal.
- [Merchant API](#merchant-api) — A merchant's POS or ERP, authenticated with an mk_live_ machine key.
- [AFP](#afp) — Payment intents routed across rails by cost, speed and finality. Disabled unless explicitly enabled.
- [Compliance](#compliance) — KYC, KYB, AML screening, cases, blocklists and transaction monitoring.
- [Schemas](#schemas)

## Meta

Health and this document.

### `GET /health`

**Liveness check**

- **Auth:** none

**Response `200`**

| Field | Type | Required | Notes |
|---|---|---|---|
| `ok` | boolean | yes |  |
| `service` | string | yes |  |

### `GET /openapi.json`

**This OpenAPI document**

- **Auth:** none

**Response `200`**

`object`

## Onboarding

Create an organization and get an API key.

### `POST /v1/signup`

**Create an organization and its first API key**

Returns the API key secret exactly once — store it. Funding and card issuance may require completed verification when the deployment enforces compliance.

- **Auth:** none

**Request body**

| Field | Type | Required | Notes |
|---|---|---|---|
| `email` | string | yes |  |
| `name` | string | yes |  |
| `currency` | `ZAR` \| `USD` \| `NGN` \| `KES` |  |  |
| `account_type` | `personal` \| `enterprise` |  |  |

**Response `201`**

| Field | Type | Required | Notes |
|---|---|---|---|
| `account_holder` | object | yes |  |
| `account_holder.id` | string | yes |  |
| `account_holder.email` | string | yes |  |
| `account_holder.name` | string | yes |  |
| `account_holder.currency` | `ZAR` \| `USD` \| `NGN` \| `KES` | yes |  |
| `account_holder.walletAccountId` | string | yes |  |
| `account_holder.subscriptionTier` | `free` \| `basic` \| `pro` \| `enterprise` | yes |  |
| `account_holder.accountType` | `personal` \| `enterprise` | yes |  |
| `account_holder.workosOrganizationId` | string |  |  |
| `account_holder.ssoDomain` | string |  |  |
| `account_holder.createdAt` | string | yes | ISO 8601 timestamp |
| `api_key` | string | yes | Secret, prefixed ak_. Shown once. |
| `api_key_id` | string | yes |  |

Errors: `400` — see [errors.md](../reference/errors.md).

## Auth

Human login, sessions, MFA and SSO for the dashboard.

### `POST /v1/auth/register`

**Register a human user and organization**

- **Auth:** none

**Request body**

| Field | Type | Required | Notes |
|---|---|---|---|
| `email` | string | yes |  |
| `name` | string | yes |  |
| `password` | string | yes |  |
| `currency` | `ZAR` \| `USD` \| `NGN` \| `KES` |  |  |
| `account_type` | `personal` \| `enterprise` |  |  |

**Response `201`**

| Field | Type | Required | Notes |
|---|---|---|---|
| `account_holder` | AccountHolder | yes |  |
| `session_token` | string |  |  |
| `user` | object |  |  |

Errors: `400` — see [errors.md](../reference/errors.md).

### `POST /v1/auth/login`

**Log in with email and password**

Returns a session, or `mfa_required` with a challenge token when TOTP is enabled.

- **Auth:** none

**Request body**

| Field | Type | Required | Notes |
|---|---|---|---|
| `email` | string | yes |  |
| `password` | string | yes |  |
| `account_holder_id` | string |  |  |

**Response `200`**

`object`

Errors: `400` — see [errors.md](../reference/errors.md).

### `POST /v1/auth/mfa/verify`

**Complete an MFA challenge**

- **Auth:** none

**Request body**

| Field | Type | Required | Notes |
|---|---|---|---|
| `challenge_token` | string | yes |  |
| `code` | string | yes |  |

**Response `200`**

`object`

Errors: `400` — see [errors.md](../reference/errors.md).

### `POST /v1/auth/sso/authorize`

**Start SSO login for an email's domain**

Requires WorkOS SSO to be configured; returns `sso_not_configured` otherwise.

- **Auth:** none

**Request body**

| Field | Type | Required | Notes |
|---|---|---|---|
| `email` | string | yes |  |

**Response `200`**

| Field | Type | Required | Notes |
|---|---|---|---|
| `redirect_url` | string | yes |  |

Errors: `400` — see [errors.md](../reference/errors.md).

### `GET /v1/auth/sso/callback`

**SSO callback (redirect target)**

Requires WorkOS SSO to be configured; returns `sso_not_configured` otherwise.

- **Auth:** none

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `code` | query | string | yes |  |

**Response `200`** — Redirects to the dashboard with a session when one is configured

| Field | Type | Required | Notes |
|---|---|---|---|
| `session_token` | string |  |  |

Errors: `400` — see [errors.md](../reference/errors.md).

### `GET /v1/auth/me`

**The current principal**

- **Auth:** `apiKey` or `session`

**Response `200`**

| Field | Type | Required | Notes |
|---|---|---|---|
| `account_holder` | AccountHolder | yes |  |
| `user` | object |  |  |
| `role` | string |  |  |

Errors: `401`, `403` — see [errors.md](../reference/errors.md).

### `POST /v1/auth/mfa/setup`

**Begin TOTP enrolment**

- **Auth:** `apiKey` or `session`

**Response `200`**

`object`

Errors: `401`, `403` — see [errors.md](../reference/errors.md).

### `POST /v1/auth/mfa/enable`

**Confirm TOTP enrolment**

- **Auth:** `apiKey` or `session`

**Request body**

| Field | Type | Required | Notes |
|---|---|---|---|
| `code` | string | yes |  |

**Response `200`**

| Field | Type | Required | Notes |
|---|---|---|---|
| `enabled` | boolean | yes |  |

Errors: `400`, `401`, `403` — see [errors.md](../reference/errors.md).

### `POST /v1/auth/mfa/disable`

**Turn TOTP off**

- **Auth:** `apiKey` or `session`

**Request body**

| Field | Type | Required | Notes |
|---|---|---|---|
| `password` | string | yes |  |
| `code` | string | yes |  |

**Response `200`**

| Field | Type | Required | Notes |
|---|---|---|---|
| `enabled` | boolean | yes |  |

Errors: `400`, `401`, `403` — see [errors.md](../reference/errors.md).

### `POST /v1/auth/logout`

**End the current session**

- **Auth:** `apiKey` or `session`

**Response `200`**

| Field | Type | Required | Notes |
|---|---|---|---|
| `ok` | boolean | yes |  |

Errors: `401`, `403` — see [errors.md](../reference/errors.md).

## Team

Members and roles: owner > admin > member > viewer.

### `GET /v1/auth/members`

**List organization members**

Requires the `admin` role or higher. Read-only API keys act as `viewer`.

- **Auth:** `apiKey` or `session`
- **Minimum role:** `admin`

**Response `200`**

| Field | Type | Required | Notes |
|---|---|---|---|
| `members` | object[] | yes |  |

Errors: `401`, `403` — see [errors.md](../reference/errors.md).

### `POST /v1/auth/members`

**Add a member with a role**

Requires the `admin` role or higher. Read-only API keys act as `viewer`.

- **Auth:** `apiKey` or `session`
- **Minimum role:** `admin`

**Request body**

| Field | Type | Required | Notes |
|---|---|---|---|
| `email` | string | yes |  |
| `name` | string |  |  |
| `password` | string |  |  |
| `role` | `owner` \| `admin` \| `member` \| `viewer` | yes |  |

**Response `201`**

`object`

Errors: `400`, `401`, `403` — see [errors.md](../reference/errors.md).

## Enterprise

Departments with monthly budgets, org-wide policy, and the audit log.

### `GET /v1/departments`

**List departments and their budgets**

- **Auth:** `apiKey` or `session`

**Response `200`**

| Field | Type | Required | Notes |
|---|---|---|---|
| `departments` | object[] | yes |  |

Errors: `401`, `403` — see [errors.md](../reference/errors.md).

### `POST /v1/departments`

**Create a department with a monthly budget**

Requires the `admin` role or higher. Read-only API keys act as `viewer`.

- **Auth:** `apiKey` or `session`
- **Minimum role:** `admin`

**Request body**

| Field | Type | Required | Notes |
|---|---|---|---|
| `name` | string | yes |  |
| `monthly_budget` | integer | yes |  |
| `lead` | string |  |  |

**Response `201`**

| Field | Type | Required | Notes |
|---|---|---|---|
| `department` | object |  |  |

Errors: `400`, `401`, `403` — see [errors.md](../reference/errors.md).

### `PATCH /v1/departments/{id}`

**Update a department**

Requires the `admin` role or higher. Read-only API keys act as `viewer`.

- **Auth:** `apiKey` or `session`
- **Minimum role:** `admin`

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `id` | path | string | yes |  |

**Request body**

| Field | Type | Required | Notes |
|---|---|---|---|
| `name` | string |  |  |
| `monthly_budget` | integer |  |  |
| `lead` | string |  |  |

**Response `200`**

| Field | Type | Required | Notes |
|---|---|---|---|
| `department` | object |  |  |

Errors: `400`, `401`, `403`, `404` — see [errors.md](../reference/errors.md).

### `GET /v1/policy`

**Read org policy**

- **Auth:** `apiKey` or `session`

**Response `200`**

| Field | Type | Required | Notes |
|---|---|---|---|
| `policy` | object |  |  |

Errors: `401`, `403` — see [errors.md](../reference/errors.md).

### `PUT /v1/policy`

**Replace org policy**

Blocked categories are enforced ahead of every per-card rule; the approval threshold routes charges to a human even when a card has none.

Requires the `admin` role or higher. Read-only API keys act as `viewer`.

- **Auth:** `apiKey` or `session`
- **Minimum role:** `admin`

**Request body**

| Field | Type | Required | Notes |
|---|---|---|---|
| `blocked_merchant_categories` | string[] |  |  |
| `approval_threshold` | integer |  |  |

**Response `200`**

| Field | Type | Required | Notes |
|---|---|---|---|
| `policy` | object |  |  |

Errors: `400`, `401`, `403` — see [errors.md](../reference/errors.md).

### `GET /v1/audit`

**Every authorization decision, with its reason**

- **Auth:** `apiKey` or `session`

**Response `200`**

| Field | Type | Required | Notes |
|---|---|---|---|
| `audit` | CardTransaction[] | yes |  |

Errors: `401`, `403` — see [errors.md](../reference/errors.md).

## Wallets

Prepaid balances per currency, and linked crypto wallets.

### `GET /v1/wallet`

**Wallet balances**

- **Auth:** `apiKey` or `session`

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `currency` | query | `ZAR` \| `USD` \| `NGN` \| `KES` |  | Which wallet to return as `wallet`. Defaults to the org's primary currency. |

**Response `200`**

| Field | Type | Required | Notes |
|---|---|---|---|
| `wallet` | WalletBalance | yes |  |
| `wallets` | object[] |  |  |
| `wallets[].currency` | `ZAR` \| `USD` \| `NGN` \| `KES` | yes |  |
| `wallets[].posted` | integer | yes | Settled balance |
| `wallets[].held` | integer | yes | Reserved by open authorizations |
| `wallets[].available` | integer | yes | posted − held. A hold beyond this is refused. |

Errors: `400`, `401`, `403` — see [errors.md](../reference/errors.md).

### `POST /v1/wallet/fund`

**Fund a wallet (sandbox instant credit)**

Instant credit, for the sandbox and for non-ZAR currencies. When real ZAR funding is configured this returns `instant_funding_disabled` for ZAR — use `/v1/wallet/fund/checkout`.

Requires the `member` role or higher. Read-only API keys act as `viewer`.

Accepts an `Idempotency-Key` header: a repeat with the same body replays the original response; a different body returns `idempotency_conflict`.

- **Auth:** `apiKey` or `session`
- **Minimum role:** `member`

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `Idempotency-Key` | header | string |  |  |

**Request body**

| Field | Type | Required | Notes |
|---|---|---|---|
| `amount` | integer | yes |  |
| `currency` | `ZAR` \| `USD` \| `NGN` \| `KES` |  |  |
| `reference` | string |  |  |

**Response `201`**

| Field | Type | Required | Notes |
|---|---|---|---|
| `wallet` | WalletBalance | yes |  |
| `wallets` | object[] |  |  |
| `wallets[].currency` | `ZAR` \| `USD` \| `NGN` \| `KES` | yes |  |
| `wallets[].posted` | integer | yes | Settled balance |
| `wallets[].held` | integer | yes | Reserved by open authorizations |
| `wallets[].available` | integer | yes | posted − held. A hold beyond this is refused. |
| `ledger_transaction` | object |  |  |

Errors: `400`, `401`, `403`, `409` — see [errors.md](../reference/errors.md).

### `POST /v1/wallet/fund/checkout`

**Start a real ZAR top-up via PayFast**

Requires the `member` role or higher. Read-only API keys act as `viewer`.

Accepts an `Idempotency-Key` header: a repeat with the same body replays the original response; a different body returns `idempotency_conflict`.

- **Auth:** `apiKey` or `session`
- **Minimum role:** `member`

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `Idempotency-Key` | header | string |  |  |

**Request body**

| Field | Type | Required | Notes |
|---|---|---|---|
| `amount` | integer | yes |  |

**Response `200`** — A form action and signed fields to post to PayFast. The wallet is credited only when PayFast confirms settlement.

| Field | Type | Required | Notes |
|---|---|---|---|
| `action` | string |  |  |
| `fields` | object |  |  |

Errors: `400`, `401`, `403`, `409` — see [errors.md](../reference/errors.md).

### `GET /v1/wallets/crypto`

**List linked crypto wallets**

- **Auth:** `apiKey` or `session`

**Response `200`**

| Field | Type | Required | Notes |
|---|---|---|---|
| `wallets` | object[] | yes |  |

Errors: `401`, `403` — see [errors.md](../reference/errors.md).

### `POST /v1/wallets/crypto/link`

**Link an external crypto wallet**

Requires the `member` role or higher. Read-only API keys act as `viewer`.

Accepts an `Idempotency-Key` header: a repeat with the same body replays the original response; a different body returns `idempotency_conflict`.

- **Auth:** `apiKey` or `session`
- **Minimum role:** `member`

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `Idempotency-Key` | header | string |  |  |

**Request body**

| Field | Type | Required | Notes |
|---|---|---|---|
| `chain` | `ethereum` \| `polygon` \| `solana` | yes |  |
| `address` | string | yes |  |
| `connector` | `metamask` \| `walletconnect` \| `coinbase` \| `other` | yes |  |
| `label` | string |  |  |

**Response `201`**

`object`

Errors: `400`, `401`, `403`, `409` — see [errors.md](../reference/errors.md).

### `POST /v1/wallets/crypto/{id}/default`

**Make a linked wallet the default**

Requires the `member` role or higher. Read-only API keys act as `viewer`.

Accepts an `Idempotency-Key` header: a repeat with the same body replays the original response; a different body returns `idempotency_conflict`.

- **Auth:** `apiKey` or `session`
- **Minimum role:** `member`

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `id` | path | string | yes |  |
| `Idempotency-Key` | header | string |  |  |

**Response `200`**

`object`

Errors: `401`, `403`, `404`, `409` — see [errors.md](../reference/errors.md).

### `DELETE /v1/wallets/crypto/{id}`

**Unlink a crypto wallet**

Requires the `member` role or higher. Read-only API keys act as `viewer`.

- **Auth:** `apiKey` or `session`
- **Minimum role:** `member`

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `id` | path | string | yes |  |

**Response `200`**

| Field | Type | Required | Notes |
|---|---|---|---|
| `ok` | boolean | yes |  |

Errors: `401`, `403`, `404` — see [errors.md](../reference/errors.md).

## Cards

Scoped virtual cards with limits, category rules and approval thresholds.

### `GET /v1/cards`

**List cards**

- **Auth:** `apiKey` or `session`

**Response `200`**

| Field | Type | Required | Notes |
|---|---|---|---|
| `cards` | Card[] | yes |  |

Errors: `401`, `403` — see [errors.md](../reference/errors.md).

### `POST /v1/cards`

**Issue a virtual card**

Every limit is in integer minor units of the card's currency. Single-use cards close after their first capture. In the sandbox the response carries a test PAN once; with a real issuer the card is provisioned there and linked, and a provisioning failure closes the card and returns `issuer_provisioning_failed`.

Requires the `member` role or higher. Read-only API keys act as `viewer`.

Accepts an `Idempotency-Key` header: a repeat with the same body replays the original response; a different body returns `idempotency_conflict`.

- **Auth:** `apiKey` or `session`
- **Minimum role:** `member`

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `Idempotency-Key` | header | string |  |  |

**Request body**

| Field | Type | Required | Notes |
|---|---|---|---|
| `label` | string |  |  |
| `currency` | `ZAR` \| `USD` \| `NGN` \| `KES` |  |  |
| `department_id` | string |  |  |
| `single_use` | boolean |  |  |
| `limits` | object |  |  |
| `limits.per_transaction` | integer |  |  |
| `limits.total` | integer |  |  |
| `limits.velocity` | object |  |  |
| `limits.velocity.amount` | integer | yes |  |
| `limits.velocity.window_seconds` | integer | yes |  |
| `allowed_merchant_categories` | string[] |  |  |
| `approval_threshold` | integer |  |  |
| `x402_allowed_hosts` | string[] |  |  |

**Response `201`**

| Field | Type | Required | Notes |
|---|---|---|---|
| `card` | CreatedCard | yes |  |

Errors: `400`, `401`, `403`, `409` — see [errors.md](../reference/errors.md).

### `GET /v1/cards/{id}`

**Get a card**

- **Auth:** `apiKey` or `session`

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `id` | path | string | yes |  |

**Response `200`**

| Field | Type | Required | Notes |
|---|---|---|---|
| `card` | Card | yes |  |

Errors: `401`, `403`, `404` — see [errors.md](../reference/errors.md).

### `POST /v1/cards/{id}/close`

**Close a card**

Requires the `member` role or higher. Read-only API keys act as `viewer`.

Accepts an `Idempotency-Key` header: a repeat with the same body replays the original response; a different body returns `idempotency_conflict`.

- **Auth:** `apiKey` or `session`
- **Minimum role:** `member`

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `id` | path | string | yes |  |
| `Idempotency-Key` | header | string |  |  |

**Response `200`**

| Field | Type | Required | Notes |
|---|---|---|---|
| `card` | Card | yes |  |

Errors: `401`, `403`, `404`, `409` — see [errors.md](../reference/errors.md).

## Transactions

Every authorization, capture and decline, with reason codes.

### `GET /v1/transactions`

**List card transactions**

- **Auth:** `apiKey` or `session`

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `card_id` | query | string |  |  |

**Response `200`**

| Field | Type | Required | Notes |
|---|---|---|---|
| `transactions` | CardTransaction[] | yes |  |

Errors: `400`, `401`, `403` — see [errors.md](../reference/errors.md).

## Approvals

Charges held for a human, and the single-use grants approvals mint.

### `GET /v1/approvals`

**List approval requests**

- **Auth:** `apiKey` or `session`

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `status` | query | `pending` \| `approved` \| `denied` \| `consumed` |  |  |

**Response `200`**

| Field | Type | Required | Notes |
|---|---|---|---|
| `approvals` | Approval[] | yes |  |

Errors: `400`, `401`, `403` — see [errors.md](../reference/errors.md).

### `POST /v1/approvals/{id}/approve`

**Approve a held charge**

Mints a single-use grant for this card and merchant, up to the approved amount. The agent's retried authorization consumes it; a second identical charge is held again.

Requires the `member` role or higher. Read-only API keys act as `viewer`.

Accepts an `Idempotency-Key` header: a repeat with the same body replays the original response; a different body returns `idempotency_conflict`.

- **Auth:** `apiKey` or `session`
- **Minimum role:** `member`

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `id` | path | string | yes |  |
| `Idempotency-Key` | header | string |  |  |

**Response `200`**

| Field | Type | Required | Notes |
|---|---|---|---|
| `approval` | Approval | yes |  |

Errors: `401`, `403`, `404`, `409` — see [errors.md](../reference/errors.md).

### `POST /v1/approvals/{id}/deny`

**Deny a held charge**

Requires the `member` role or higher. Read-only API keys act as `viewer`.

Accepts an `Idempotency-Key` header: a repeat with the same body replays the original response; a different body returns `idempotency_conflict`.

- **Auth:** `apiKey` or `session`
- **Minimum role:** `member`

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `id` | path | string | yes |  |
| `Idempotency-Key` | header | string |  |  |

**Response `200`**

| Field | Type | Required | Notes |
|---|---|---|---|
| `approval` | Approval | yes |  |

Errors: `401`, `403`, `404`, `409` — see [errors.md](../reference/errors.md).

## API keys

Programmatic credentials, full or read-only.

### `GET /v1/keys`

**List API keys**

Requires the `admin` role or higher. Read-only API keys act as `viewer`.

- **Auth:** `apiKey` or `session`
- **Minimum role:** `admin`

**Response `200`**

| Field | Type | Required | Notes |
|---|---|---|---|
| `keys` | object[] | yes |  |

Errors: `401`, `403` — see [errors.md](../reference/errors.md).

### `POST /v1/keys`

**Issue an API key**

`read_only` keys resolve to exactly the viewer role. `spend_cap_cents` limits the cumulative card budget this key may provision.

Requires the `admin` role or higher. Read-only API keys act as `viewer`.

Accepts an `Idempotency-Key` header: a repeat with the same body replays the original response; a different body returns `idempotency_conflict`.

- **Auth:** `apiKey` or `session`
- **Minimum role:** `admin`

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `Idempotency-Key` | header | string |  |  |

**Request body**

| Field | Type | Required | Notes |
|---|---|---|---|
| `name` | string |  |  |
| `scope` | `full` \| `read_only` |  |  |
| `spend_cap_cents` | integer |  |  |

**Response `201`**

| Field | Type | Required | Notes |
|---|---|---|---|
| `api_key` | string |  |  |
| `key` | object |  |  |

Errors: `400`, `401`, `403`, `409` — see [errors.md](../reference/errors.md).

### `DELETE /v1/keys/{id}`

**Revoke an API key**

Requires the `admin` role or higher. Read-only API keys act as `viewer`.

- **Auth:** `apiKey` or `session`
- **Minimum role:** `admin`

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `id` | path | string | yes |  |

**Response `200`**

| Field | Type | Required | Notes |
|---|---|---|---|
| `revoked` | boolean | yes |  |

Errors: `401`, `403`, `404` — see [errors.md](../reference/errors.md).

## SSO

Federate an organization to its own identity provider.

### `POST /v1/sso/setup`

**Start SSO setup for this organization**

Requires the `owner` role or higher. Read-only API keys act as `viewer`.

Accepts an `Idempotency-Key` header: a repeat with the same body replays the original response; a different body returns `idempotency_conflict`.

Requires WorkOS SSO to be configured; returns `sso_not_configured` otherwise.

- **Auth:** `apiKey` or `session`
- **Minimum role:** `owner`

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `Idempotency-Key` | header | string |  |  |

**Request body**

| Field | Type | Required | Notes |
|---|---|---|---|
| `domain` | string |  |  |

**Response `200`**

| Field | Type | Required | Notes |
|---|---|---|---|
| `portal_url` | string | yes |  |

Errors: `400`, `401`, `403`, `409` — see [errors.md](../reference/errors.md).

## Billing

Subscription plans and upgrades.

### `GET /v1/billing/plans`

**Subscription plans and their limits**

- **Auth:** `apiKey` or `session`

**Response `200`**

| Field | Type | Required | Notes |
|---|---|---|---|
| `plans` | object | yes |  |

Errors: `401`, `403` — see [errors.md](../reference/errors.md).

### `POST /v1/billing/checkout`

**Start a subscription upgrade via PayFast**

Requires the `admin` role or higher. Read-only API keys act as `viewer`.

Accepts an `Idempotency-Key` header: a repeat with the same body replays the original response; a different body returns `idempotency_conflict`.

- **Auth:** `apiKey` or `session`
- **Minimum role:** `admin`

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `Idempotency-Key` | header | string |  |  |

**Response `200`**

`object`

Errors: `401`, `403`, `409` — see [errors.md](../reference/errors.md).

## Inbound webhooks

Endpoints other systems call: the card issuer, PayFast, and the verification provider.

### `POST /webhooks/issuer`

**Card issuer events (real-time authorization)**

Called by the issuing partner. `authorization.request` must be answered inside the network's ~2-second window and returns the decision; `transaction.capture` settles a hold; `authorization.reversal` releases one. See docs/reference/webhooks.md.

- **Auth:** `webhookSignature`

**Response `200`**

| Field | Type | Required | Notes |
|---|---|---|---|
| `approved` | boolean |  |  |
| `decline_reason` | string |  |  |
| `approval_id` | string |  |  |
| `received` | boolean |  |  |

Errors: `401` — see [errors.md](../reference/errors.md).

### `POST /webhooks/payfast`

**PayFast ITN (payment notification)**

Form-encoded. Validated by signature, source, and confirm-back to PayFast before any wallet is credited.

- **Auth:** none

**Response `200`**

| Field | Type | Required | Notes |
|---|---|---|---|
| `received` | boolean | yes |  |

Errors: `401` — see [errors.md](../reference/errors.md).

### `POST /webhooks/compliance`

**Verification provider decisions**

Mounted when compliance is enabled (ACARD_ENABLE_COMPLIANCE=true).

- **Auth:** none

**Response `200`**

| Field | Type | Required | Notes |
|---|---|---|---|
| `received` | boolean |  |  |
| `matched` | boolean |  |  |

Errors: `401` — see [errors.md](../reference/errors.md).

## Sandbox

Exercise the real authorization path without a card network.

### `POST /v1/simulate/purchase`

**Simulate a purchase through the real authorization path**

Plays the card issuer: builds a signed `authorization.request` and feeds it through `/webhooks/issuer`, then captures it when approved. What you test here is the production decision path.

Requires the `member` role or higher. Read-only API keys act as `viewer`.

Accepts an `Idempotency-Key` header: a repeat with the same body replays the original response; a different body returns `idempotency_conflict`.

- **Auth:** `apiKey` or `session`
- **Minimum role:** `member`

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `Idempotency-Key` | header | string |  |  |

**Request body**

| Field | Type | Required | Notes |
|---|---|---|---|
| `card_id` | string | yes |  |
| `amount` | integer | yes |  |
| `currency` | `ZAR` \| `USD` \| `NGN` \| `KES` |  |  |
| `merchant` | object | yes |  |
| `merchant.name` | string | yes |  |
| `merchant.category` | string |  |  |
| `merchant.country` | string |  |  |

**Response `200`**

| Field | Type | Required | Notes |
|---|---|---|---|
| `authorization_id` | string | yes |  |
| `approved` | boolean | yes |  |
| `decline_reason` | string |  | See the decline reason reference |
| `approval_id` | string |  | Set when the charge was held for a human |
| `wallet` | object | yes |  |
| `wallet.currency` | `ZAR` \| `USD` \| `NGN` \| `KES` | yes |  |
| `wallet.posted` | integer | yes | Settled balance |
| `wallet.held` | integer | yes | Reserved by open authorizations |
| `wallet.available` | integer | yes | posted − held. A hold beyond this is refused. |

Errors: `400`, `401`, `403`, `409` — see [errors.md](../reference/errors.md).

## A-MERCHANT

Agent-facing supply discovery, merchant detail, orders and purchase notices.

### `GET /v1/merchants/search`

**Search verified supply**

Returns ranked offers with a score breakdown, and a sample of what was excluded and why. Only verified merchants are ever returned. There is no paid placement.

Mounted when the A-MERCHANT directory is configured.

- **Auth:** `apiKey` or `session`

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `q` | query | string |  | Free-text item search |
| `categories` | query | string |  | Comma-separated MCCs. Pass a card's allowed_merchant_categories to see only what that card can pay for. |
| `lat` | query | number |  |  |
| `lng` | query | number |  |  |
| `radius_km` | query | number |  | Defaults to 25 when lat/lng are given |
| `quantity` | query | integer |  |  |
| `max_total_cents` | query | integer |  |  |
| `max_lead_time_days` | query | integer |  |  |
| `max_inventory_age_hours` | query | number |  | Refuse offers whose stock was confirmed longer ago than this |
| `currency` | query | `ZAR` \| `USD` \| `NGN` \| `KES` |  |  |
| `limit` | query | integer |  |  |

**Response `200`**

`OfferSearchResult`

Errors: `400`, `401`, `403` — see [errors.md](../reference/errors.md).

### `GET /v1/merchants`

**List merchants**

Mounted when the A-MERCHANT directory is configured.

- **Auth:** `apiKey` or `session`

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `status` | query | `pending_kyb` \| `verified` \| `suspended` |  |  |

**Response `200`**

| Field | Type | Required | Notes |
|---|---|---|---|
| `merchants` | PublicMerchant[] | yes |  |

Errors: `400`, `401`, `403` — see [errors.md](../reference/errors.md).

### `GET /v1/merchants/{id}`

**Get a merchant, its catalogue and reliability**

Mounted when the A-MERCHANT directory is configured.

- **Auth:** `apiKey` or `session`

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `id` | path | string | yes |  |

**Response `200`**

| Field | Type | Required | Notes |
|---|---|---|---|
| `merchant` | PublicMerchant | yes |  |
| `items` | object[] |  |  |
| `items[].id` | string | yes |  |
| `items[].merchantId` | string | yes |  |
| `items[].sku` | string | yes |  |
| `items[].name` | string | yes |  |
| `items[].description` | string |  |  |
| `items[].unit` | string | yes |  |
| `items[].unitPriceCents` | integer | yes | Integer minor units (cents) |
| `items[].currency` | `ZAR` \| `USD` \| `NGN` \| `KES` | yes |  |
| `items[].availability` | `in_stock` \| `low_stock` \| `out_of_stock` \| `made_to_order` | yes |  |
| `items[].quantityAvailable` | integer |  |  |
| `items[].leadTimeDays` | integer | yes |  |
| `items[].inventoryUpdatedAt` | string | yes | When stock was last confirmed — not when the row was last edited |
| `items[].createdAt` | string | yes | ISO 8601 timestamp |
| `items[].updatedAt` | string | yes | ISO 8601 timestamp |
| `reliability` | object |  |  |

Errors: `401`, `403`, `404` — see [errors.md](../reference/errors.md).

### `GET /v1/merchants/{id}/health`

**Catalogue freshness health**

Mounted when the A-MERCHANT directory is configured.

- **Auth:** `apiKey` or `session`

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `id` | path | string | yes |  |

**Response `200`**

| Field | Type | Required | Notes |
|---|---|---|---|
| `items` | number | yes |  |
| `fresh` | number | yes |  |
| `aging` | number | yes |  |
| `stale` | number | yes |  |
| `medianInventoryAgeHours` | number | yes |  |

Errors: `401`, `403`, `404` — see [errors.md](../reference/errors.md).

### `POST /v1/merchants/{id}/orders`

**Place an order with a merchant**

Lines are priced from the catalogue, never the caller. No money moves through an order — pay by card as usual and pass `card_transaction_id` as evidence. The merchant's system is notified by signed webhook.

Requires the `member` role or higher. Read-only API keys act as `viewer`.

Accepts an `Idempotency-Key` header: a repeat with the same body replays the original response; a different body returns `idempotency_conflict`.

Mounted when the A-MERCHANT directory is configured.

- **Auth:** `apiKey` or `session`
- **Minimum role:** `member`

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `id` | path | string | yes |  |
| `Idempotency-Key` | header | string |  |  |

**Request body**

| Field | Type | Required | Notes |
|---|---|---|---|
| `lines` | object[] | yes |  |
| `lines[].item_id` | string | yes |  |
| `lines[].quantity` | integer | yes |  |
| `fulfilment` | object | yes |  |
| `fulfilment.method` | `collection` \| `delivery` | yes |  |
| `fulfilment.address` | string |  |  |
| `fulfilment.needed_by` | string |  |  |
| `card_transaction_id` | string |  |  |
| `note` | string |  |  |

**Response `201`**

| Field | Type | Required | Notes |
|---|---|---|---|
| `order` | Order | yes |  |

Errors: `400`, `401`, `403`, `404`, `409` — see [errors.md](../reference/errors.md).

### `GET /v1/orders`

**Your orders, across every merchant**

Mounted when the A-MERCHANT directory is configured.

- **Auth:** `apiKey` or `session`

**Response `200`**

| Field | Type | Required | Notes |
|---|---|---|---|
| `orders` | Order[] | yes |  |

Errors: `401`, `403` — see [errors.md](../reference/errors.md).

### `GET /v1/orders/{id}`

**Get an order**

Mounted when the A-MERCHANT directory is configured.

- **Auth:** `apiKey` or `session`

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `id` | path | string | yes |  |

**Response `200`**

| Field | Type | Required | Notes |
|---|---|---|---|
| `order` | Order | yes |  |

Errors: `401`, `403`, `404` — see [errors.md](../reference/errors.md).

### `POST /v1/orders/{id}/cancel`

**Cancel an order you placed**

Requires the `member` role or higher. Read-only API keys act as `viewer`.

Accepts an `Idempotency-Key` header: a repeat with the same body replays the original response; a different body returns `idempotency_conflict`.

Mounted when the A-MERCHANT directory is configured.

- **Auth:** `apiKey` or `session`
- **Minimum role:** `member`

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `id` | path | string | yes |  |
| `Idempotency-Key` | header | string |  |  |

**Response `200`**

| Field | Type | Required | Notes |
|---|---|---|---|
| `order` | Order | yes |  |

Errors: `401`, `403`, `404`, `409` — see [errors.md](../reference/errors.md).

### `POST /v1/merchants/{id}/purchases`

**Report a purchase to a merchant**

Tells the merchant a sale happened so they can restate stock. Records a claim; it never decrements stock or moves money.

Requires the `member` role or higher. Read-only API keys act as `viewer`.

Accepts an `Idempotency-Key` header: a repeat with the same body replays the original response; a different body returns `idempotency_conflict`.

Mounted when the A-MERCHANT directory is configured.

- **Auth:** `apiKey` or `session`
- **Minimum role:** `member`

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `id` | path | string | yes |  |
| `Idempotency-Key` | header | string |  |  |

**Request body**

| Field | Type | Required | Notes |
|---|---|---|---|
| `item_id` | string | yes |  |
| `quantity` | integer | yes |  |
| `card_transaction_id` | string |  |  |

**Response `201`**

| Field | Type | Required | Notes |
|---|---|---|---|
| `purchase` | object |  |  |

Errors: `400`, `401`, `403`, `404`, `409` — see [errors.md](../reference/errors.md).

### `GET /v1/purchases`

**Your reported purchases**

Mounted when the A-MERCHANT directory is configured.

- **Auth:** `apiKey` or `session`

**Response `200`**

| Field | Type | Required | Notes |
|---|---|---|---|
| `purchases` | object[] | yes |  |

Errors: `401`, `403` — see [errors.md](../reference/errors.md).

## Merchant operations

Operator-side merchant onboarding, KYB and catalogue management.

### `POST /v1/merchants`

**Register a merchant**

Requires the `admin` role or higher. Read-only API keys act as `viewer`.

Accepts an `Idempotency-Key` header: a repeat with the same body replays the original response; a different body returns `idempotency_conflict`.

Mounted when the A-MERCHANT directory is configured.

- **Auth:** `apiKey` or `session`
- **Minimum role:** `admin`

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `Idempotency-Key` | header | string |  |  |

**Request body**

| Field | Type | Required | Notes |
|---|---|---|---|
| `name` | string | yes |  |
| `trading_name` | string |  |  |
| `merchant_category_code` | string | yes |  |
| `address` | object | yes |  |
| `address.addressLine` | string | yes |  |
| `address.city` | string | yes |  |
| `address.province` | string | yes |  |
| `address.country` | string |  |  |
| `address.lat` | number | yes |  |
| `address.lng` | number | yes |  |
| `service_radius_km` | number |  |  |
| `currency` | `ZAR` \| `USD` \| `NGN` \| `KES` |  |  |
| `agent_access` | `open` \| `allowlist` |  |  |
| `allowed_account_holder_ids` | string[] |  |  |
| `kyb` | object | yes |  |
| `kyb.registration_number` | string | yes |  |
| `kyb.vat_number` | string |  |  |
| `kyb.contact_email` | string | yes |  |
| `kyb.contact_phone` | string |  |  |

**Response `201`**

| Field | Type | Required | Notes |
|---|---|---|---|
| `merchant` | object |  |  |

Errors: `400`, `401`, `403`, `409` — see [errors.md](../reference/errors.md).

### `PATCH /v1/merchants/{id}`

**Update a merchant's profile**

Requires the `admin` role or higher. Read-only API keys act as `viewer`.

Mounted when the A-MERCHANT directory is configured.

- **Auth:** `apiKey` or `session`
- **Minimum role:** `admin`

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `id` | path | string | yes |  |

**Request body**

| Field | Type | Required | Notes |
|---|---|---|---|
| `name` | string |  |  |
| `trading_name` | string |  |  |
| `address` | object |  |  |
| `address.addressLine` | string | yes |  |
| `address.city` | string | yes |  |
| `address.province` | string | yes |  |
| `address.country` | string |  |  |
| `address.lat` | number | yes |  |
| `address.lng` | number | yes |  |
| `service_radius_km` | number |  |  |
| `agent_access` | `open` \| `allowlist` |  |  |
| `allowed_account_holder_ids` | string[] |  |  |
| `merchant_category_code` | string |  |  |

**Response `200`**

| Field | Type | Required | Notes |
|---|---|---|---|
| `merchant` | object |  |  |

Errors: `400`, `401`, `403`, `404` — see [errors.md](../reference/errors.md).

### `GET /v1/merchants/{id}/purchases`

**A merchant's purchase notices**

Requires the `admin` role or higher. Read-only API keys act as `viewer`.

Mounted when the A-MERCHANT directory is configured.

- **Auth:** `apiKey` or `session`
- **Minimum role:** `admin`

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `id` | path | string | yes |  |

**Response `200`**

| Field | Type | Required | Notes |
|---|---|---|---|
| `purchases` | object[] | yes |  |

Errors: `401`, `403`, `404` — see [errors.md](../reference/errors.md).

### `POST /v1/merchants/{id}/kyb`

**Record a KYB decision**

Merchants are invisible to agents until verified.

Requires the `admin` role or higher. Read-only API keys act as `viewer`.

Accepts an `Idempotency-Key` header: a repeat with the same body replays the original response; a different body returns `idempotency_conflict`.

Mounted when the A-MERCHANT directory is configured.

- **Auth:** `apiKey` or `session`
- **Minimum role:** `admin`

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `id` | path | string | yes |  |
| `Idempotency-Key` | header | string |  |  |

**Request body**

| Field | Type | Required | Notes |
|---|---|---|---|
| `status` | `pending_kyb` \| `verified` \| `suspended` | yes |  |
| `note` | string |  |  |

**Response `200`**

| Field | Type | Required | Notes |
|---|---|---|---|
| `merchant` | object |  |  |

Errors: `400`, `401`, `403`, `404`, `409` — see [errors.md](../reference/errors.md).

### `GET /v1/merchants/{id}/portal-invites`

**List a merchant's portal invites**

Requires the `admin` role or higher. Read-only API keys act as `viewer`.

Mounted when the merchant portal (WorkOS AuthKit) is configured.

- **Auth:** `apiKey` or `session`
- **Minimum role:** `admin`

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `id` | path | string | yes |  |

**Response `200`**

| Field | Type | Required | Notes |
|---|---|---|---|
| `invites` | object[] | yes |  |

Errors: `401`, `403`, `404` — see [errors.md](../reference/errors.md).

### `POST /v1/merchants/{id}/portal-invites`

**Create a merchant portal invite**

Requires the `admin` role or higher. Read-only API keys act as `viewer`.

Accepts an `Idempotency-Key` header: a repeat with the same body replays the original response; a different body returns `idempotency_conflict`.

Mounted when the merchant portal (WorkOS AuthKit) is configured.

- **Auth:** `apiKey` or `session`
- **Minimum role:** `admin`

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `id` | path | string | yes |  |
| `Idempotency-Key` | header | string |  |  |

**Request body**

| Field | Type | Required | Notes |
|---|---|---|---|
| `role` | `owner` \| `staff` |  |  |

**Response `201`**

`object`

Errors: `400`, `401`, `403`, `404`, `409` — see [errors.md](../reference/errors.md).

### `GET /v1/merchants/{id}/kyb-documents`

**List KYB documents**

Requires the `admin` role or higher. Read-only API keys act as `viewer`.

Mounted when KYB document storage is configured.

- **Auth:** `apiKey` or `session`
- **Minimum role:** `admin`

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `id` | path | string | yes |  |

**Response `200`**

`object`

Errors: `401`, `403`, `404` — see [errors.md](../reference/errors.md).

### `POST /v1/merchants/{id}/kyb-documents`

**Request a KYB document upload URL**

Requires the `admin` role or higher. Read-only API keys act as `viewer`.

Accepts an `Idempotency-Key` header: a repeat with the same body replays the original response; a different body returns `idempotency_conflict`.

Mounted when KYB document storage is configured.

- **Auth:** `apiKey` or `session`
- **Minimum role:** `admin`

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `id` | path | string | yes |  |
| `Idempotency-Key` | header | string |  |  |

**Request body**

| Field | Type | Required | Notes |
|---|---|---|---|
| `filename` | string | yes |  |
| `content_type` | `application/pdf` \| `image/jpeg` \| `image/png` | yes |  |

**Response `200`**

`object`

Errors: `400`, `401`, `403`, `404`, `409` — see [errors.md](../reference/errors.md).

### `POST /v1/merchants/{id}/kyb-documents/confirm`

**Confirm an uploaded KYB document**

Requires the `admin` role or higher. Read-only API keys act as `viewer`.

Accepts an `Idempotency-Key` header: a repeat with the same body replays the original response; a different body returns `idempotency_conflict`.

Mounted when KYB document storage is configured.

- **Auth:** `apiKey` or `session`
- **Minimum role:** `admin`

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `id` | path | string | yes |  |
| `Idempotency-Key` | header | string |  |  |

**Request body**

| Field | Type | Required | Notes |
|---|---|---|---|
| `key` | string | yes |  |
| `filename` | string | yes |  |
| `content_type` | `application/pdf` \| `image/jpeg` \| `image/png` | yes |  |

**Response `200`**

`object`

Errors: `400`, `401`, `403`, `404`, `409` — see [errors.md](../reference/errors.md).

### `PUT /v1/merchants/{id}/items`

**Create or update a catalogue item**

Requires the `member` role or higher. Read-only API keys act as `viewer`.

Mounted when the A-MERCHANT directory is configured.

- **Auth:** `apiKey` or `session`
- **Minimum role:** `member`

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `id` | path | string | yes |  |

**Request body**

| Field | Type | Required | Notes |
|---|---|---|---|
| `sku` | string | yes |  |
| `name` | string | yes |  |
| `description` | string |  |  |
| `unit` | string |  |  |
| `unit_price_cents` | integer | yes |  |
| `currency` | `ZAR` \| `USD` \| `NGN` \| `KES` |  |  |
| `availability` | `in_stock` \| `low_stock` \| `out_of_stock` \| `made_to_order` |  |  |
| `quantity_available` | integer |  |  |
| `lead_time_days` | integer |  |  |

**Response `200`**

| Field | Type | Required | Notes |
|---|---|---|---|
| `item` | CatalogItem | yes |  |

Errors: `400`, `401`, `403`, `404` — see [errors.md](../reference/errors.md).

### `POST /v1/merchants/{id}/items/{itemId}/restate`

**Restate an item's stock**

Requires the `member` role or higher. Read-only API keys act as `viewer`.

Accepts an `Idempotency-Key` header: a repeat with the same body replays the original response; a different body returns `idempotency_conflict`.

Mounted when the A-MERCHANT directory is configured.

- **Auth:** `apiKey` or `session`
- **Minimum role:** `member`

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `id` | path | string | yes |  |
| `itemId` | path | string | yes |  |
| `Idempotency-Key` | header | string |  |  |

**Request body**

| Field | Type | Required | Notes |
|---|---|---|---|
| `availability` | `in_stock` \| `low_stock` \| `out_of_stock` \| `made_to_order` | yes |  |
| `quantity_available` | integer |  |  |

**Response `200`**

| Field | Type | Required | Notes |
|---|---|---|---|
| `item` | CatalogItem | yes |  |

Errors: `400`, `401`, `403`, `404`, `409` — see [errors.md](../reference/errors.md).

### `DELETE /v1/merchants/{id}/items/{itemId}`

**Remove a catalogue item**

Requires the `member` role or higher. Read-only API keys act as `viewer`.

Mounted when the A-MERCHANT directory is configured.

- **Auth:** `apiKey` or `session`
- **Minimum role:** `member`

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `id` | path | string | yes |  |
| `itemId` | path | string | yes |  |

**Response `200`**

| Field | Type | Required | Notes |
|---|---|---|---|
| `deleted` | boolean | yes |  |

Errors: `401`, `403`, `404` — see [errors.md](../reference/errors.md).

## Merchant portal

A merchant's own staff, signed in through the portal.

### `GET /v1/merchant-auth/authorize`

**Begin merchant login from an invite**

Mounted when the merchant portal (WorkOS AuthKit) is configured.

- **Auth:** none

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `invite` | query | string |  |  |

**Response `200`** — Redirects to WorkOS AuthKit

`object`

Errors: `400` — see [errors.md](../reference/errors.md).

### `GET /v1/merchant-auth/callback`

**Merchant login callback**

Mounted when the merchant portal (WorkOS AuthKit) is configured.

- **Auth:** none

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `code` | query | string |  |  |
| `state` | query | string |  |  |

**Response `200`** — Redirects to the portal with a session

| Field | Type | Required | Notes |
|---|---|---|---|
| `portal_token` | string |  |  |

Errors: `400` — see [errors.md](../reference/errors.md).

### `POST /v1/merchant-portal/logout`

**End the merchant session**

Mounted when the merchant portal (WorkOS AuthKit) is configured.

- **Auth:** `merchantSession`

**Response `200`**

| Field | Type | Required | Notes |
|---|---|---|---|
| `ok` | boolean | yes |  |

Errors: `401` — see [errors.md](../reference/errors.md).

### `GET /v1/merchant-portal/me`

**Current merchant user and shop**

Mounted when the merchant portal (WorkOS AuthKit) is configured.

- **Auth:** `merchantSession`

**Response `200`**

`object`

Errors: `401` — see [errors.md](../reference/errors.md).

### `GET /v1/merchant-portal/items`

**Your catalogue**

Mounted when the merchant portal (WorkOS AuthKit) is configured.

- **Auth:** `merchantSession`

**Response `200`**

| Field | Type | Required | Notes |
|---|---|---|---|
| `items` | CatalogItem[] | yes |  |

Errors: `401` — see [errors.md](../reference/errors.md).

### `PUT /v1/merchant-portal/items`

**Create or update an item**

Mounted when the merchant portal (WorkOS AuthKit) is configured.

- **Auth:** `merchantSession`

**Request body**

| Field | Type | Required | Notes |
|---|---|---|---|
| `sku` | string | yes |  |
| `name` | string | yes |  |
| `description` | string |  |  |
| `unit` | string |  |  |
| `unit_price_cents` | integer | yes |  |
| `currency` | `ZAR` \| `USD` \| `NGN` \| `KES` |  |  |
| `availability` | `in_stock` \| `low_stock` \| `out_of_stock` \| `made_to_order` |  |  |
| `quantity_available` | integer |  |  |
| `lead_time_days` | integer |  |  |

**Response `200`**

| Field | Type | Required | Notes |
|---|---|---|---|
| `item` | CatalogItem | yes |  |

Errors: `400`, `401` — see [errors.md](../reference/errors.md).

### `POST /v1/merchant-portal/items/{itemId}/restate`

**Restate an item's stock**

Mounted when the merchant portal (WorkOS AuthKit) is configured.

- **Auth:** `merchantSession`

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `itemId` | path | string | yes |  |

**Request body**

| Field | Type | Required | Notes |
|---|---|---|---|
| `availability` | `in_stock` \| `low_stock` \| `out_of_stock` \| `made_to_order` | yes |  |
| `quantity_available` | integer |  |  |

**Response `200`**

| Field | Type | Required | Notes |
|---|---|---|---|
| `item` | CatalogItem | yes |  |

Errors: `400`, `401`, `404` — see [errors.md](../reference/errors.md).

### `DELETE /v1/merchant-portal/items/{itemId}`

**Remove an item**

Mounted when the merchant portal (WorkOS AuthKit) is configured.

- **Auth:** `merchantSession`

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `itemId` | path | string | yes |  |

**Response `200`**

| Field | Type | Required | Notes |
|---|---|---|---|
| `deleted` | boolean | yes |  |

Errors: `401`, `404` — see [errors.md](../reference/errors.md).

### `GET /v1/merchant-portal/health`

**Catalogue freshness health**

Mounted when the merchant portal (WorkOS AuthKit) is configured.

- **Auth:** `merchantSession`

**Response `200`**

`object`

Errors: `401` — see [errors.md](../reference/errors.md).

### `GET /v1/merchant-portal/orders`

**Orders placed with your shop**

Mounted when the merchant portal (WorkOS AuthKit) is configured.

- **Auth:** `merchantSession`

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `status` | query | `placed` \| `accepted` \| `rejected` \| `preparing` \| `ready` \| `dispatched` \| `delivered` \| `cancelled` |  |  |

**Response `200`**

| Field | Type | Required | Notes |
|---|---|---|---|
| `orders` | Order[] | yes |  |

Errors: `400`, `401` — see [errors.md](../reference/errors.md).

### `POST /v1/merchant-portal/orders/{id}/advance`

**Move an order forward**

Illegal transitions are refused with `invalid_state`.

Mounted when the merchant portal (WorkOS AuthKit) is configured.

- **Auth:** `merchantSession`

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `id` | path | string | yes |  |

**Request body**

| Field | Type | Required | Notes |
|---|---|---|---|
| `status` | `accepted` \| `rejected` \| `preparing` \| `ready` \| `dispatched` \| `delivered` | yes |  |
| `note` | string |  |  |
| `promised_at` | string |  |  |
| `tracking_reference` | string |  |  |

**Response `200`**

| Field | Type | Required | Notes |
|---|---|---|---|
| `order` | Order | yes |  |

Errors: `400`, `401`, `404` — see [errors.md](../reference/errors.md).

### `GET /v1/merchant-portal/reliability`

**Your reliability score and its confidence**

Mounted when the merchant portal (WorkOS AuthKit) is configured.

- **Auth:** `merchantSession`

**Response `200`**

| Field | Type | Required | Notes |
|---|---|---|---|
| `reliability` | object |  |  |

Errors: `401` — see [errors.md](../reference/errors.md).

### `GET /v1/merchant-portal/purchases`

**Purchase notices for your shop**

Mounted when the merchant portal (WorkOS AuthKit) is configured.

- **Auth:** `merchantSession`

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `status` | query | `pending` \| `acknowledged` \| `disputed` |  |  |

**Response `200`**

| Field | Type | Required | Notes |
|---|---|---|---|
| `purchases` | object[] | yes |  |

Errors: `400`, `401` — see [errors.md](../reference/errors.md).

### `POST /v1/merchant-portal/purchases/{id}/acknowledge`

**Confirm a sale, optionally restating stock**

Mounted when the merchant portal (WorkOS AuthKit) is configured.

- **Auth:** `merchantSession`

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `id` | path | string | yes |  |

**Request body**

| Field | Type | Required | Notes |
|---|---|---|---|
| `note` | string |  |  |
| `restate` | object |  |  |
| `restate.availability` | `in_stock` \| `low_stock` \| `out_of_stock` \| `made_to_order` | yes |  |
| `restate.quantity_available` | integer |  |  |

**Response `200`**

| Field | Type | Required | Notes |
|---|---|---|---|
| `purchase` | object |  |  |

Errors: `400`, `401`, `404` — see [errors.md](../reference/errors.md).

### `POST /v1/merchant-portal/purchases/{id}/dispute`

**Dispute a reported sale**

Mounted when the merchant portal (WorkOS AuthKit) is configured.

- **Auth:** `merchantSession`

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `id` | path | string | yes |  |

**Request body**

| Field | Type | Required | Notes |
|---|---|---|---|
| `note` | string | yes |  |

**Response `200`**

| Field | Type | Required | Notes |
|---|---|---|---|
| `purchase` | object |  |  |

Errors: `400`, `401`, `404` — see [errors.md](../reference/errors.md).

### `GET /v1/merchant-portal/team`

**Your staff and invites**

Requires the shop `owner` role; staff receive `forbidden`.

Mounted when the merchant portal (WorkOS AuthKit) is configured.

- **Auth:** `merchantSession`

**Response `200`**

`object`

Errors: `401`, `403` — see [errors.md](../reference/errors.md).

### `PUT /v1/merchant-portal/hours`

**Set operating hours**

Requires the shop `owner` role; staff receive `forbidden`.

Mounted when the merchant portal (WorkOS AuthKit) is configured.

- **Auth:** `merchantSession`

**Request body**

`object`

**Response `200`**

| Field | Type | Required | Notes |
|---|---|---|---|
| `merchant` | object |  |  |

Errors: `400`, `401`, `403` — see [errors.md](../reference/errors.md).

### `GET /v1/merchant-portal/api-keys`

**List your machine API keys**

Requires the shop `owner` role; staff receive `forbidden`.

Mounted when the merchant portal (WorkOS AuthKit) is configured.

- **Auth:** `merchantSession`

**Response `200`**

| Field | Type | Required | Notes |
|---|---|---|---|
| `api_keys` | object[] | yes |  |

Errors: `401`, `403` — see [errors.md](../reference/errors.md).

### `POST /v1/merchant-portal/api-keys`

**Create a machine API key for your POS or ERP**

The `mk_live_` secret is returned once and stored only as a hash.

Requires the shop `owner` role; staff receive `forbidden`.

Mounted when the merchant portal (WorkOS AuthKit) is configured.

- **Auth:** `merchantSession`

**Request body**

| Field | Type | Required | Notes |
|---|---|---|---|
| `name` | string | yes |  |
| `scope` | `read_only` \| `read_write` |  |  |

**Response `201`**

| Field | Type | Required | Notes |
|---|---|---|---|
| `api_key` | object |  |  |
| `secret` | string |  |  |

Errors: `400`, `401`, `403` — see [errors.md](../reference/errors.md).

### `DELETE /v1/merchant-portal/api-keys/{id}`

**Revoke a machine API key**

Requires the shop `owner` role; staff receive `forbidden`.

Mounted when the merchant portal (WorkOS AuthKit) is configured.

- **Auth:** `merchantSession`

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `id` | path | string | yes |  |

**Response `200`**

| Field | Type | Required | Notes |
|---|---|---|---|
| `api_key` | object |  |  |

Errors: `401`, `403`, `404` — see [errors.md](../reference/errors.md).

### `POST /v1/merchant-portal/team/invites`

**Invite staff to your shop**

Requires the shop `owner` role; staff receive `forbidden`.

Mounted when the merchant portal (WorkOS AuthKit) is configured.

- **Auth:** `merchantSession`

**Request body**

| Field | Type | Required | Notes |
|---|---|---|---|
| `role` | `owner` \| `staff` |  |  |

**Response `201`**

`object`

Errors: `400`, `401`, `403` — see [errors.md](../reference/errors.md).

## Merchant API

A merchant's POS or ERP, authenticated with an mk_live_ machine key.

### `GET /v1/merchant-api/me`

**Identity, catalogue health and pending sales**

Mounted when the A-MERCHANT directory is configured.

- **Auth:** `merchantKey`

**Response `200`**

`object`

Errors: `401` — see [errors.md](../reference/errors.md).

### `GET /v1/merchant-api/catalog`

**Your catalogue**

Mounted when the A-MERCHANT directory is configured.

- **Auth:** `merchantKey`

**Response `200`**

| Field | Type | Required | Notes |
|---|---|---|---|
| `items` | CatalogItem[] | yes |  |

Errors: `401` — see [errors.md](../reference/errors.md).

### `PUT /v1/merchant-api/catalog`

**Bulk upsert by SKU**

Idempotent by your own SKU. Returns 207 with a per-SKU breakdown when some rows fail, so one bad row never discards the rest.

Requires a `read_write` merchant key; a `read_only` key receives `forbidden`.

Mounted when the A-MERCHANT directory is configured.

- **Auth:** `merchantKey`

**Request body**

| Field | Type | Required | Notes |
|---|---|---|---|
| `items` | object[] | yes |  |
| `items[].sku` | string | yes |  |
| `items[].name` | string | yes |  |
| `items[].description` | string |  |  |
| `items[].unit` | string |  |  |
| `items[].unit_price_cents` | integer | yes |  |
| `items[].currency` | `ZAR` \| `USD` \| `NGN` \| `KES` |  |  |
| `items[].availability` | `in_stock` \| `low_stock` \| `out_of_stock` \| `made_to_order` |  |  |
| `items[].quantity_available` | integer |  |  |
| `items[].lead_time_days` | integer |  |  |

**Response `200`**

| Field | Type | Required | Notes |
|---|---|---|---|
| `synced` | number | yes |  |

Errors: `400`, `401`, `403` — see [errors.md](../reference/errors.md).

### `POST /v1/merchant-api/stock`

**Bulk stock restate by SKU**

Requires a `read_write` merchant key; a `read_only` key receives `forbidden`.

Mounted when the A-MERCHANT directory is configured.

- **Auth:** `merchantKey`

**Request body**

| Field | Type | Required | Notes |
|---|---|---|---|
| `items` | object[] | yes |  |
| `items[].sku` | string | yes |  |
| `items[].availability` | `in_stock` \| `low_stock` \| `out_of_stock` \| `made_to_order` | yes |  |
| `items[].quantity_available` | integer |  |  |

**Response `200`**

| Field | Type | Required | Notes |
|---|---|---|---|
| `restated` | number | yes |  |

Errors: `400`, `401`, `403` — see [errors.md](../reference/errors.md).

### `GET /v1/merchant-api/orders`

**Orders placed with you**

Mounted when the A-MERCHANT directory is configured.

- **Auth:** `merchantKey`

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `status` | query | `placed` \| `accepted` \| `rejected` \| `preparing` \| `ready` \| `dispatched` \| `delivered` \| `cancelled` |  |  |

**Response `200`**

| Field | Type | Required | Notes |
|---|---|---|---|
| `orders` | Order[] | yes |  |

Errors: `400`, `401` — see [errors.md](../reference/errors.md).

### `POST /v1/merchant-api/orders/{id}/advance`

**Move an order forward**

Requires a `read_write` merchant key; a `read_only` key receives `forbidden`.

Mounted when the A-MERCHANT directory is configured.

- **Auth:** `merchantKey`

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `id` | path | string | yes |  |

**Request body**

| Field | Type | Required | Notes |
|---|---|---|---|
| `status` | `accepted` \| `rejected` \| `preparing` \| `ready` \| `dispatched` \| `delivered` | yes |  |
| `note` | string |  |  |
| `promised_at` | string |  |  |
| `tracking_reference` | string |  |  |

**Response `200`**

| Field | Type | Required | Notes |
|---|---|---|---|
| `order` | Order | yes |  |

Errors: `400`, `401`, `403`, `404` — see [errors.md](../reference/errors.md).

### `PUT /v1/merchant-api/webhook`

**Register your webhook endpoint**

Returns the signing secret once. Events are signed with the same `t=…,v1=…` scheme as every other A-CARD webhook.

Requires a `read_write` merchant key; a `read_only` key receives `forbidden`.

Mounted when the A-MERCHANT directory is configured.

- **Auth:** `merchantKey`

**Request body**

| Field | Type | Required | Notes |
|---|---|---|---|
| `url` | string | yes |  |
| `events` | string[] |  |  |

**Response `200`**

| Field | Type | Required | Notes |
|---|---|---|---|
| `webhook` | object |  |  |
| `secret` | string |  |  |

Errors: `400`, `401`, `403` — see [errors.md](../reference/errors.md).

### `DELETE /v1/merchant-api/webhook`

**Remove your webhook endpoint**

Requires a `read_write` merchant key; a `read_only` key receives `forbidden`.

Mounted when the A-MERCHANT directory is configured.

- **Auth:** `merchantKey`

**Response `200`**

| Field | Type | Required | Notes |
|---|---|---|---|
| `cleared` | boolean | yes |  |

Errors: `401`, `403` — see [errors.md](../reference/errors.md).

### `POST /v1/merchant-api/orders/{id}/redeliver`

**Redeliver an order event to your webhook**

Requires a `read_write` merchant key; a `read_only` key receives `forbidden`.

Mounted when the A-MERCHANT directory is configured.

- **Auth:** `merchantKey`

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `id` | path | string | yes |  |

**Response `200`**

| Field | Type | Required | Notes |
|---|---|---|---|
| `redelivered` | boolean | yes |  |

Errors: `401`, `403`, `404` — see [errors.md](../reference/errors.md).

### `GET /v1/merchant-api/reliability`

**Your reliability score**

Mounted when the A-MERCHANT directory is configured.

- **Auth:** `merchantKey`

**Response `200`**

| Field | Type | Required | Notes |
|---|---|---|---|
| `reliability` | object |  |  |

Errors: `401` — see [errors.md](../reference/errors.md).

### `GET /v1/merchant-api/purchases`

**Purchase notices to reconcile against your till**

Mounted when the A-MERCHANT directory is configured.

- **Auth:** `merchantKey`

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `status` | query | `pending` \| `acknowledged` \| `disputed` |  |  |

**Response `200`**

| Field | Type | Required | Notes |
|---|---|---|---|
| `purchases` | object[] | yes |  |

Errors: `400`, `401` — see [errors.md](../reference/errors.md).

### `POST /v1/merchant-api/purchases/{id}/acknowledge`

**Confirm a sale**

Requires a `read_write` merchant key; a `read_only` key receives `forbidden`.

Mounted when the A-MERCHANT directory is configured.

- **Auth:** `merchantKey`

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `id` | path | string | yes |  |

**Request body**

| Field | Type | Required | Notes |
|---|---|---|---|
| `note` | string |  |  |
| `restate` | object |  |  |
| `restate.availability` | `in_stock` \| `low_stock` \| `out_of_stock` \| `made_to_order` | yes |  |
| `restate.quantity_available` | integer |  |  |

**Response `200`**

| Field | Type | Required | Notes |
|---|---|---|---|
| `purchase` | object |  |  |

Errors: `400`, `401`, `403`, `404` — see [errors.md](../reference/errors.md).

## AFP

Payment intents routed across rails by cost, speed and finality. Disabled unless explicitly enabled.

### `POST /v1/afp/intents`

**Route a payment intent (moves nothing)**

Scores every eligible rail on cost, speed and finality and returns the decision with reasons. Nothing executes.

Requires the `member` role or higher. Read-only API keys act as `viewer`.

Accepts an `Idempotency-Key` header: a repeat with the same body replays the original response; a different body returns `idempotency_conflict`.

Mounted only when AFP is explicitly enabled (ACARD_ENABLE_AFP=true).

- **Auth:** `apiKey` or `session`
- **Minimum role:** `member`

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `Idempotency-Key` | header | string |  |  |

**Request body**

| Field | Type | Required | Notes |
|---|---|---|---|
| `amount` | integer | yes |  |
| `currency` | `ZAR` \| `USD` \| `NGN` \| `KES` | yes |  |
| `purpose` | string | yes |  |
| `counterparty` | string | yes |  |
| `allowed_rails` | `card` \| `x402` \| `stablecoin`[] |  |  |

**Response `201`**

`object`

Errors: `400`, `401`, `403`, `409` — see [errors.md](../reference/errors.md).

### `POST /v1/afp/intents/{id}/execute`

**Execute a routed intent**

Requires an `Idempotency-Key` header (`idempotency_key_required` otherwise) — enforced by a unique index, so a retry after a timeout is a lookup, never a second payment. An ambiguous rail outcome parks the transaction as `reconciling` rather than guessing.

Requires the `member` role or higher. Read-only API keys act as `viewer`.

Mounted only when AFP is explicitly enabled (ACARD_ENABLE_AFP=true).

- **Auth:** `apiKey` or `session`
- **Minimum role:** `member`

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `id` | path | string | yes |  |
| `Idempotency-Key` | header | string | yes |  |

**Request body**

| Field | Type | Required | Notes |
|---|---|---|---|
| `rail` | `card` \| `x402` \| `stablecoin` |  |  |

**Response `200`**

| Field | Type | Required | Notes |
|---|---|---|---|
| `transaction` | object |  |  |

Errors: `400`, `401`, `403`, `404` — see [errors.md](../reference/errors.md).

### `GET /v1/afp/transactions`

**Your AFP ledger**

Mounted only when AFP is explicitly enabled (ACARD_ENABLE_AFP=true).

- **Auth:** `apiKey` or `session`

**Response `200`**

| Field | Type | Required | Notes |
|---|---|---|---|
| `transactions` | object[] | yes |  |

Errors: `401`, `403` — see [errors.md](../reference/errors.md).

### `POST /v1/afp/x402/pay`

**Pay for a resource over x402, governed by a card**

Mounted when AFP's x402 rail is configured. Fetches `url`; on HTTP 402 it reads the price (x402 v2 `PAYMENT-REQUIRED` header or a v1 body), and pays only if the card allows it: categories empty or including `x402`, the host in `x402AllowedHosts` (if set), the exact price within `max_usd` and the card's per-transaction limit, and the cents it adds to the card's x402 tab through the normal authorization (limits, approval thresholds, org policy, department budget, balance). Prices below a cent are charged as they add up to whole cents. Requires an `Idempotency-Key`. A decline or a hold is a `200` with `status` `declined` or `held`; an outcome the server left unknown is a `202` with `status` `reconciling`, and its hold stays until it is reconciled. URLs must be HTTPS on a public host.

Requires the `member` role or higher. Read-only API keys act as `viewer`.

Mounted only when AFP is explicitly enabled (ACARD_ENABLE_AFP=true).

- **Auth:** `apiKey` or `session`
- **Minimum role:** `member`

**Request body**

| Field | Type | Required | Notes |
|---|---|---|---|
| `card_id` | string | yes |  |
| `url` | string | yes |  |
| `max_usd` | string | yes |  |
| `method` | `GET` \| `POST` |  |  |
| `body` | object |  |  |

**Response `200`**

| Field | Type | Required | Notes |
|---|---|---|---|
| `status` | `paid` \| `free` \| `held` \| `declined` \| `failed` \| `reconciling` | yes |  |
| `decline_reason` | string |  |  |
| `approval_id` | string |  |  |
| `message` | string |  |  |
| `price` | object |  |  |
| `price.amount_atomic` | string | yes |  |
| `price.usd` | string | yes |  |
| `price.network` | string | yes |  |
| `price.asset` | string | yes |  |
| `price.pay_to` | string | yes |  |
| `charged_cents` | integer |  |  |
| `tab` | object |  |  |
| `tab.card_id` | string | yes |  |
| `tab.payments` | integer | yes |  |
| `tab.paid_atomic` | string | yes |  |
| `tab.paid_usd` | string | yes |  |
| `tab.charged_cents` | integer | yes |  |
| `tab.credit_atomic` | string | yes |  |
| `settlement` | object |  |  |
| `settlement.success` | boolean | yes |  |
| `settlement.transaction` | string |  |  |
| `settlement.network` | string |  |  |
| `settlement.payer` | string |  |  |
| `settlement.errorReason` | string |  |  |
| `transaction` | object |  |  |
| `resource` | object |  |  |
| `resource.status` | integer | yes |  |
| `resource.content_type` | string |  |  |
| `resource.bytes` | integer | yes |  |
| `resource.body` | string |  |  |
| `resource.truncated` | boolean |  |  |
| `replayed` | boolean |  |  |

Errors: `400`, `401`, `403` — see [errors.md](../reference/errors.md).

### `GET /v1/afp/x402/tabs/{cardId}`

**A card's x402 tab**

Exact USDC a card has paid over x402 (atomic units, millionths of a dollar), the whole cents charged to it, and the unused credit.

Mounted only when AFP is explicitly enabled (ACARD_ENABLE_AFP=true).

- **Auth:** `apiKey` or `session`

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `cardId` | path | string | yes |  |

**Response `200`**

| Field | Type | Required | Notes |
|---|---|---|---|
| `tab` | object | yes |  |
| `tab.card_id` | string | yes |  |
| `tab.payments` | integer | yes |  |
| `tab.paid_atomic` | string | yes |  |
| `tab.paid_usd` | string | yes |  |
| `tab.charged_cents` | integer | yes |  |
| `tab.credit_atomic` | string | yes |  |

Errors: `401`, `403`, `404` — see [errors.md](../reference/errors.md).

## Compliance

KYC, KYB, AML screening, cases, blocklists and transaction monitoring.

### `POST /v1/compliance/verify`

**Start identity or business verification**

Requires the `admin` role or higher. Read-only API keys act as `viewer`.

Accepts an `Idempotency-Key` header: a repeat with the same body replays the original response; a different body returns `idempotency_conflict`.

Mounted when compliance is enabled (ACARD_ENABLE_COMPLIANCE=true).

- **Auth:** `apiKey` or `session`
- **Minimum role:** `admin`

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `Idempotency-Key` | header | string |  |  |

**Response `200`**

| Field | Type | Required | Notes |
|---|---|---|---|
| `verification` | object |  |  |

Errors: `401`, `403`, `409` — see [errors.md](../reference/errors.md).

### `GET /v1/compliance/me`

**Your verification status**

Mounted when compliance is enabled (ACARD_ENABLE_COMPLIANCE=true).

- **Auth:** `apiKey` or `session`

**Response `200`**

`object`

Errors: `401`, `403` — see [errors.md](../reference/errors.md).

### `POST /v1/compliance/merchants/{id}/verify`

**Start KYB for a merchant**

Requires the `admin` role or higher. Read-only API keys act as `viewer`.

Accepts an `Idempotency-Key` header: a repeat with the same body replays the original response; a different body returns `idempotency_conflict`.

Mounted when compliance is enabled (ACARD_ENABLE_COMPLIANCE=true).

- **Auth:** `apiKey` or `session`
- **Minimum role:** `admin`

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `id` | path | string | yes |  |
| `Idempotency-Key` | header | string |  |  |

**Response `200`**

| Field | Type | Required | Notes |
|---|---|---|---|
| `verification` | object |  |  |

Errors: `401`, `403`, `404`, `409` — see [errors.md](../reference/errors.md).

### `GET /v1/compliance/queue`

**Verifications awaiting review**

Requires the `admin` role or higher. Read-only API keys act as `viewer`.

Mounted when compliance is enabled (ACARD_ENABLE_COMPLIANCE=true).

- **Auth:** `apiKey` or `session`
- **Minimum role:** `admin`

**Response `200`**

| Field | Type | Required | Notes |
|---|---|---|---|
| `verifications` | object[] | yes |  |

Errors: `401`, `403` — see [errors.md](../reference/errors.md).

### `GET /v1/compliance/verifications`

**List verifications**

Requires the `admin` role or higher. Read-only API keys act as `viewer`.

Mounted when compliance is enabled (ACARD_ENABLE_COMPLIANCE=true).

- **Auth:** `apiKey` or `session`
- **Minimum role:** `admin`

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `subject` | query | string |  |  |

**Response `200`**

| Field | Type | Required | Notes |
|---|---|---|---|
| `verifications` | object[] | yes |  |

Errors: `400`, `401`, `403` — see [errors.md](../reference/errors.md).

### `POST /v1/compliance/verifications/{id}/override`

**Record an attributed human override**

Stored alongside the provider's decision, never over it.

Requires the `admin` role or higher. Read-only API keys act as `viewer`.

Accepts an `Idempotency-Key` header: a repeat with the same body replays the original response; a different body returns `idempotency_conflict`.

Mounted when compliance is enabled (ACARD_ENABLE_COMPLIANCE=true).

- **Auth:** `apiKey` or `session`
- **Minimum role:** `admin`

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `id` | path | string | yes |  |
| `Idempotency-Key` | header | string |  |  |

**Request body**

| Field | Type | Required | Notes |
|---|---|---|---|
| `status` | `approved` \| `declined` | yes |  |
| `reason` | string | yes |  |

**Response `200`**

| Field | Type | Required | Notes |
|---|---|---|---|
| `verification` | object |  |  |

Errors: `400`, `401`, `403`, `404`, `409` — see [errors.md](../reference/errors.md).

### `POST /v1/compliance/aml/screen`

**Screen a name against sanctions, PEP and adverse media**

Requires the `admin` role or higher. Read-only API keys act as `viewer`.

Accepts an `Idempotency-Key` header: a repeat with the same body replays the original response; a different body returns `idempotency_conflict`.

Mounted when compliance is enabled (ACARD_ENABLE_COMPLIANCE=true).

- **Auth:** `apiKey` or `session`
- **Minimum role:** `admin`

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `Idempotency-Key` | header | string |  |  |

**Request body**

| Field | Type | Required | Notes |
|---|---|---|---|
| `full_name` | string | yes |  |
| `entity_type` | `person` \| `company` |  |  |
| `date_of_birth` | string |  |  |
| `nationality` | string |  |  |
| `include_adverse_media` | boolean |  |  |
| `ongoing_monitoring` | boolean |  |  |

**Response `200`**

`object`

Errors: `400`, `401`, `403`, `409` — see [errors.md](../reference/errors.md).

### `GET /v1/compliance/registry/search`

**Search a company registry**

Requires the `admin` role or higher. Read-only API keys act as `viewer`.

Mounted when compliance is enabled (ACARD_ENABLE_COMPLIANCE=true).

- **Auth:** `apiKey` or `session`
- **Minimum role:** `admin`

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `country_code` | query | string | yes |  |
| `name` | query | string |  |  |
| `registration_number` | query | string |  |  |

**Response `200`**

| Field | Type | Required | Notes |
|---|---|---|---|
| `candidates` | object[] | yes |  |

Errors: `400`, `401`, `403` — see [errors.md](../reference/errors.md).

### `GET /v1/compliance/registry/{candidateId}`

**Fetch a registry record**

Requires the `admin` role or higher. Read-only API keys act as `viewer`.

Mounted when compliance is enabled (ACARD_ENABLE_COMPLIANCE=true).

- **Auth:** `apiKey` or `session`
- **Minimum role:** `admin`

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `candidateId` | path | string | yes |  |

**Response `200`**

| Field | Type | Required | Notes |
|---|---|---|---|
| `company` | object |  |  |

Errors: `401`, `403`, `404` — see [errors.md](../reference/errors.md).

### `GET /v1/compliance/cases`

**Open compliance cases**

Requires the `admin` role or higher. Read-only API keys act as `viewer`.

Mounted when compliance is enabled (ACARD_ENABLE_COMPLIANCE=true).

- **Auth:** `apiKey` or `session`
- **Minimum role:** `admin`

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `status` | query | string |  |  |

**Response `200`**

| Field | Type | Required | Notes |
|---|---|---|---|
| `cases` | object[] | yes |  |

Errors: `400`, `401`, `403` — see [errors.md](../reference/errors.md).

### `GET /v1/compliance/cases/{caseId}`

**Get a case**

Requires the `admin` role or higher. Read-only API keys act as `viewer`.

Mounted when compliance is enabled (ACARD_ENABLE_COMPLIANCE=true).

- **Auth:** `apiKey` or `session`
- **Minimum role:** `admin`

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `caseId` | path | string | yes |  |

**Response `200`**

| Field | Type | Required | Notes |
|---|---|---|---|
| `case` | object |  |  |

Errors: `401`, `403`, `404` — see [errors.md](../reference/errors.md).

### `GET /v1/compliance/blocklist`

**Blocklist entries**

Requires the `admin` role or higher. Read-only API keys act as `viewer`.

Mounted when compliance is enabled (ACARD_ENABLE_COMPLIANCE=true).

- **Auth:** `apiKey` or `session`
- **Minimum role:** `admin`

**Response `200`**

| Field | Type | Required | Notes |
|---|---|---|---|
| `entries` | object[] | yes |  |

Errors: `401`, `403` — see [errors.md](../reference/errors.md).

### `POST /v1/compliance/blocklist`

**Add a blocklist entry**

Requires the `admin` role or higher. Read-only API keys act as `viewer`.

Accepts an `Idempotency-Key` header: a repeat with the same body replays the original response; a different body returns `idempotency_conflict`.

Mounted when compliance is enabled (ACARD_ENABLE_COMPLIANCE=true).

- **Auth:** `apiKey` or `session`
- **Minimum role:** `admin`

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `Idempotency-Key` | header | string |  |  |

**Request body**

| Field | Type | Required | Notes |
|---|---|---|---|
| `entry_type` | `user` \| `business` \| `email` \| `phone` \| `document` \| `ip_address` | yes |  |
| `value` | string | yes |  |
| `reason` | string |  |  |

**Response `201`**

`object`

Errors: `400`, `401`, `403`, `409` — see [errors.md](../reference/errors.md).

### `GET /v1/compliance/crypto/status`

**Whether Travel Rule and wallet screening are active, and why**

Requires the `admin` role or higher. Read-only API keys act as `viewer`.

Mounted when compliance is enabled (ACARD_ENABLE_COMPLIANCE=true).

- **Auth:** `apiKey` or `session`
- **Minimum role:** `admin`

**Response `200`**

`object`

Errors: `401`, `403` — see [errors.md](../reference/errors.md).

### `POST /v1/compliance/crypto/screen`

**Screen a crypto wallet address**

Requires the `admin` role or higher. Read-only API keys act as `viewer`.

Accepts an `Idempotency-Key` header: a repeat with the same body replays the original response; a different body returns `idempotency_conflict`.

Mounted when crypto compliance is configured. Inert while AFP's crypto rails are sandboxed.

- **Auth:** `apiKey` or `session`
- **Minimum role:** `admin`

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `Idempotency-Key` | header | string |  |  |

**Request body**

| Field | Type | Required | Notes |
|---|---|---|---|
| `address` | string | yes |  |
| `chain` | `BTC` \| `ETH` \| `LTC` \| `XRP` \| `BCH` \| `DOGE` \| `TRX` \| `SOL` \| `MATIC` \| `BNB` \| `USDT` \| `USDC` | yes |  |
| `direction` | `inbound` \| `outbound` |  |  |

**Response `200`**

`object`

Errors: `400`, `401`, `403`, `409` — see [errors.md](../reference/errors.md).

### `GET /v1/compliance/crypto/vasps`

**Search Travel Rule counterparties**

Requires the `admin` role or higher. Read-only API keys act as `viewer`.

Mounted when crypto compliance is configured. Inert while AFP's crypto rails are sandboxed.

- **Auth:** `apiKey` or `session`
- **Minimum role:** `admin`

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `search` | query | string |  |  |

**Response `200`**

| Field | Type | Required | Notes |
|---|---|---|---|
| `vasps` | object[] | yes |  |

Errors: `400`, `401`, `403` — see [errors.md](../reference/errors.md).

### `POST /v1/compliance/crypto/inbound`

**Register an inbound transfer for Travel Rule**

Requires the `admin` role or higher. Read-only API keys act as `viewer`.

Accepts an `Idempotency-Key` header: a repeat with the same body replays the original response; a different body returns `idempotency_conflict`.

Mounted when crypto compliance is configured. Inert while AFP's crypto rails are sandboxed.

- **Auth:** `apiKey` or `session`
- **Minimum role:** `admin`

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `Idempotency-Key` | header | string |  |  |

**Request body**

| Field | Type | Required | Notes |
|---|---|---|---|
| `txid` | string | yes |  |
| `wallet_address` | string | yes |  |
| `chain` | string |  |  |
| `currency` | string |  |  |
| `amount` | string |  |  |
| `originating_vasp` | object |  |  |
| `originating_vasp.name` | string |  |  |
| `originating_vasp.lei` | string |  |  |
| `originating_vasp.travel_address` | string |  |  |

**Response `200`**

`object`

Errors: `400`, `401`, `403`, `409` — see [errors.md](../reference/errors.md).

### `POST /v1/compliance/transactions`

**Submit a transaction for AML monitoring**

Requires the `admin` role or higher. Read-only API keys act as `viewer`.

Accepts an `Idempotency-Key` header: a repeat with the same body replays the original response; a different body returns `idempotency_conflict`.

Mounted when compliance is enabled (ACARD_ENABLE_COMPLIANCE=true).

- **Auth:** `apiKey` or `session`
- **Minimum role:** `admin`

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `Idempotency-Key` | header | string |  |  |

**Request body**

| Field | Type | Required | Notes |
|---|---|---|---|
| `transaction_id` | string | yes |  |
| `card_id` | string | yes |  |
| `amount` | integer | yes |  |
| `currency` | `ZAR` \| `USD` \| `NGN` \| `KES` | yes |  |
| `merchant_name` | string | yes |  |
| `merchant_category` | string | yes |  |
| `merchant_country` | string |  |  |
| `occurred_at` | string |  |  |

**Response `200`**

`object`

Errors: `400`, `401`, `403`, `409` — see [errors.md](../reference/errors.md).

## Schemas

### Error

| Field | Type | Required | Notes |
|---|---|---|---|
| `error` | object | yes |  |
| `error.code` | string | yes | Stable, machine-readable error code — see docs/reference/errors.md |
| `error.message` | string | yes | Human-readable explanation. Do not parse; it may change. |
| `error.issues` | object[] |  | Validation issues, present on invalid_request |

### AccountHolder

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | yes |  |
| `email` | string | yes |  |
| `name` | string | yes |  |
| `currency` | `ZAR` \| `USD` \| `NGN` \| `KES` | yes |  |
| `walletAccountId` | string | yes |  |
| `subscriptionTier` | `free` \| `basic` \| `pro` \| `enterprise` | yes |  |
| `accountType` | `personal` \| `enterprise` | yes |  |
| `workosOrganizationId` | string |  |  |
| `ssoDomain` | string |  |  |
| `createdAt` | string | yes | ISO 8601 timestamp |

### WalletBalance

| Field | Type | Required | Notes |
|---|---|---|---|
| `currency` | `ZAR` \| `USD` \| `NGN` \| `KES` | yes |  |
| `posted` | integer | yes | Settled balance |
| `held` | integer | yes | Reserved by open authorizations |
| `available` | integer | yes | posted − held. A hold beyond this is refused. |

### Card

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | yes |  |
| `accountHolderId` | string | yes |  |
| `walletAccountId` | string | yes |  |
| `departmentId` | string |  |  |
| `currency` | `ZAR` \| `USD` \| `NGN` \| `KES` | yes |  |
| `status` | `active` \| `closed` | yes |  |
| `singleUse` | boolean | yes |  |
| `limits` | object | yes |  |
| `limits.perTransaction` | integer |  | Integer minor units (cents) |
| `limits.total` | integer |  | Integer minor units (cents) |
| `limits.velocity` | object |  |  |
| `limits.velocity.amount` | integer | yes | Integer minor units (cents) |
| `limits.velocity.windowSeconds` | integer | yes |  |
| `allowedMerchantCategories` | string[] | yes | MCC allow-list. Empty means all categories. |
| `approvalThreshold` | integer |  | Integer minor units (cents) |
| `x402AllowedHosts` | string[] |  | Hosts this card may pay over x402. Unset means any host. |
| `last4` | string | yes |  |
| `expiryMonth` | integer | yes |  |
| `expiryYear` | integer | yes |  |
| `label` | string |  |  |
| `issuerCardId` | string |  |  |
| `createdAt` | string | yes | ISO 8601 timestamp |
| `closedAt` | string |  | ISO 8601 timestamp |
| `closeReason` | string |  |  |

### CreatedCard

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | yes |  |
| `accountHolderId` | string | yes |  |
| `walletAccountId` | string | yes |  |
| `departmentId` | string |  |  |
| `currency` | `ZAR` \| `USD` \| `NGN` \| `KES` | yes |  |
| `status` | `active` \| `closed` | yes |  |
| `singleUse` | boolean | yes |  |
| `limits` | object | yes |  |
| `limits.perTransaction` | integer |  | Integer minor units (cents) |
| `limits.total` | integer |  | Integer minor units (cents) |
| `limits.velocity` | object |  |  |
| `limits.velocity.amount` | integer | yes | Integer minor units (cents) |
| `limits.velocity.windowSeconds` | integer | yes |  |
| `allowedMerchantCategories` | string[] | yes | MCC allow-list. Empty means all categories. |
| `approvalThreshold` | integer |  | Integer minor units (cents) |
| `x402AllowedHosts` | string[] |  | Hosts this card may pay over x402. Unset means any host. |
| `last4` | string | yes |  |
| `expiryMonth` | integer | yes |  |
| `expiryYear` | integer | yes |  |
| `label` | string |  |  |
| `issuerCardId` | string |  |  |
| `createdAt` | string | yes | ISO 8601 timestamp |
| `closedAt` | string |  | ISO 8601 timestamp |
| `closeReason` | string |  |  |
| `sandboxPan` | string |  | Sandbox test PAN, returned only at creation and only in the sandbox. Real issuers host credentials; A-CARD never sees a PAN. |

### CardTransaction

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | yes |  |
| `cardId` | string | yes |  |
| `accountHolderId` | string | yes |  |
| `type` | `authorization` \| `capture` \| `refund` \| `declined` | yes |  |
| `status` | `pending` \| `completed` \| `declined` \| `reversed` | yes |  |
| `amount` | integer | yes | Integer minor units (cents) |
| `currency` | `ZAR` \| `USD` \| `NGN` \| `KES` | yes |  |
| `merchantName` | string | yes |  |
| `merchantCategory` | string | yes |  |
| `declineReason` | string |  | Present when declined — see the decline reason reference |
| `approvalId` | string |  |  |
| `ledgerTransactionId` | string |  |  |
| `createdAt` | string | yes | ISO 8601 timestamp |

### Approval

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | yes |  |
| `cardId` | string | yes |  |
| `accountHolderId` | string | yes |  |
| `amount` | integer | yes | Integer minor units (cents) |
| `currency` | `ZAR` \| `USD` \| `NGN` \| `KES` | yes |  |
| `merchantName` | string | yes |  |
| `merchantCategory` | string | yes |  |
| `reason` | string | yes | amount_requires_human_approval (card threshold) or amount_requires_org_approval (org policy) |
| `status` | `pending` \| `approved` \| `denied` \| `consumed` | yes |  |
| `createdAt` | string | yes | ISO 8601 timestamp |
| `decidedAt` | string |  | ISO 8601 timestamp |
| `decidedBy` | string |  |  |

### CatalogItem

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | yes |  |
| `merchantId` | string | yes |  |
| `sku` | string | yes |  |
| `name` | string | yes |  |
| `description` | string |  |  |
| `unit` | string | yes |  |
| `unitPriceCents` | integer | yes | Integer minor units (cents) |
| `currency` | `ZAR` \| `USD` \| `NGN` \| `KES` | yes |  |
| `availability` | `in_stock` \| `low_stock` \| `out_of_stock` \| `made_to_order` | yes |  |
| `quantityAvailable` | integer |  |  |
| `leadTimeDays` | integer | yes |  |
| `inventoryUpdatedAt` | string | yes | When stock was last confirmed — not when the row was last edited |
| `createdAt` | string | yes | ISO 8601 timestamp |
| `updatedAt` | string | yes | ISO 8601 timestamp |

### PublicMerchant

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | yes |  |
| `name` | string | yes |  |
| `tradingName` | string |  |  |
| `merchantCategoryCode` | string | yes |  |
| `address` | object | yes |  |
| `address.addressLine` | string | yes |  |
| `address.city` | string | yes |  |
| `address.province` | string | yes |  |
| `address.country` | string | yes |  |
| `address.lat` | number | yes |  |
| `address.lng` | number | yes |  |
| `serviceRadiusKm` | number | yes |  |
| `currency` | `ZAR` \| `USD` \| `NGN` \| `KES` | yes |  |
| `status` | `pending_kyb` \| `verified` \| `suspended` | yes |  |
| `agentAccess` | `open` \| `allowlist` | yes |  |
| `allowedAccountHolderIds` | string[] | yes |  |
| `operatingHours` | object |  | Keyed by weekday 0 (Sunday) – 6. null = closed that day. Absent = unknown, which reads as open. |
| `verified` | boolean | yes |  |
| `createdAt` | string | yes | ISO 8601 timestamp |
| `updatedAt` | string | yes | ISO 8601 timestamp |

### Offer

| Field | Type | Required | Notes |
|---|---|---|---|
| `merchant` | object | yes |  |
| `merchant.id` | string | yes |  |
| `merchant.name` | string | yes |  |
| `merchant.tradingName` | string |  |  |
| `merchant.merchantCategoryCode` | string | yes |  |
| `merchant.address` | object | yes |  |
| `merchant.address.addressLine` | string | yes |  |
| `merchant.address.city` | string | yes |  |
| `merchant.address.province` | string | yes |  |
| `merchant.address.country` | string | yes |  |
| `merchant.address.lat` | number | yes |  |
| `merchant.address.lng` | number | yes |  |
| `merchant.serviceRadiusKm` | number | yes |  |
| `merchant.currency` | `ZAR` \| `USD` \| `NGN` \| `KES` | yes |  |
| `merchant.status` | `pending_kyb` \| `verified` \| `suspended` | yes |  |
| `merchant.agentAccess` | `open` \| `allowlist` | yes |  |
| `merchant.allowedAccountHolderIds` | string[] | yes |  |
| `merchant.operatingHours` | object |  | Keyed by weekday 0 (Sunday) – 6. null = closed that day. Absent = unknown, which reads as open. |
| `merchant.verified` | boolean | yes |  |
| `merchant.createdAt` | string | yes | ISO 8601 timestamp |
| `merchant.updatedAt` | string | yes | ISO 8601 timestamp |
| `item` | object | yes |  |
| `item.id` | string | yes |  |
| `item.merchantId` | string | yes |  |
| `item.sku` | string | yes |  |
| `item.name` | string | yes |  |
| `item.description` | string |  |  |
| `item.unit` | string | yes |  |
| `item.unitPriceCents` | integer | yes | Integer minor units (cents) |
| `item.currency` | `ZAR` \| `USD` \| `NGN` \| `KES` | yes |  |
| `item.availability` | `in_stock` \| `low_stock` \| `out_of_stock` \| `made_to_order` | yes |  |
| `item.quantityAvailable` | integer |  |  |
| `item.leadTimeDays` | integer | yes |  |
| `item.inventoryUpdatedAt` | string | yes | When stock was last confirmed — not when the row was last edited |
| `item.createdAt` | string | yes | ISO 8601 timestamp |
| `item.updatedAt` | string | yes | ISO 8601 timestamp |
| `quantity` | integer | yes |  |
| `unitPriceCents` | integer | yes | Integer minor units (cents) |
| `totalCents` | integer | yes | Integer minor units (cents) |
| `currency` | `ZAR` \| `USD` \| `NGN` \| `KES` | yes |  |
| `distanceKm` | number |  |  |
| `leadTimeDays` | integer | yes |  |
| `availability` | `in_stock` \| `low_stock` \| `out_of_stock` \| `made_to_order` | yes |  |
| `inventoryAgeHours` | number | yes |  |
| `freshness` | `fresh` \| `aging` \| `stale` | yes | fresh ≤ 24h, aging ≤ 7d, stale beyond |
| `score` | number | yes | 0–1, deterministic. No paid placement exists. |
| `matchReasons` | string[] | yes |  |

### OfferSearchResult

| Field | Type | Required | Notes |
|---|---|---|---|
| `offers` | object[] | yes |  |
| `offers[].merchant` | object | yes |  |
| `offers[].merchant.id` | string | yes |  |
| `offers[].merchant.name` | string | yes |  |
| `offers[].merchant.tradingName` | string |  |  |
| `offers[].merchant.merchantCategoryCode` | string | yes |  |
| `offers[].merchant.address` | object | yes |  |
| `offers[].merchant.address.addressLine` | string | yes |  |
| `offers[].merchant.address.city` | string | yes |  |
| `offers[].merchant.address.province` | string | yes |  |
| `offers[].merchant.address.country` | string | yes |  |
| `offers[].merchant.address.lat` | number | yes |  |
| `offers[].merchant.address.lng` | number | yes |  |
| `offers[].merchant.serviceRadiusKm` | number | yes |  |
| `offers[].merchant.currency` | `ZAR` \| `USD` \| `NGN` \| `KES` | yes |  |
| `offers[].merchant.status` | `pending_kyb` \| `verified` \| `suspended` | yes |  |
| `offers[].merchant.agentAccess` | `open` \| `allowlist` | yes |  |
| `offers[].merchant.allowedAccountHolderIds` | string[] | yes |  |
| `offers[].merchant.operatingHours` | object |  | Keyed by weekday 0 (Sunday) – 6. null = closed that day. Absent = unknown, which reads as open. |
| `offers[].merchant.verified` | boolean | yes |  |
| `offers[].merchant.createdAt` | string | yes | ISO 8601 timestamp |
| `offers[].merchant.updatedAt` | string | yes | ISO 8601 timestamp |
| `offers[].item` | object | yes |  |
| `offers[].item.id` | string | yes |  |
| `offers[].item.merchantId` | string | yes |  |
| `offers[].item.sku` | string | yes |  |
| `offers[].item.name` | string | yes |  |
| `offers[].item.description` | string |  |  |
| `offers[].item.unit` | string | yes |  |
| `offers[].item.unitPriceCents` | integer | yes | Integer minor units (cents) |
| `offers[].item.currency` | `ZAR` \| `USD` \| `NGN` \| `KES` | yes |  |
| `offers[].item.availability` | `in_stock` \| `low_stock` \| `out_of_stock` \| `made_to_order` | yes |  |
| `offers[].item.quantityAvailable` | integer |  |  |
| `offers[].item.leadTimeDays` | integer | yes |  |
| `offers[].item.inventoryUpdatedAt` | string | yes | When stock was last confirmed — not when the row was last edited |
| `offers[].item.createdAt` | string | yes | ISO 8601 timestamp |
| `offers[].item.updatedAt` | string | yes | ISO 8601 timestamp |
| `offers[].quantity` | integer | yes |  |
| `offers[].unitPriceCents` | integer | yes | Integer minor units (cents) |
| `offers[].totalCents` | integer | yes | Integer minor units (cents) |
| `offers[].currency` | `ZAR` \| `USD` \| `NGN` \| `KES` | yes |  |
| `offers[].distanceKm` | number |  |  |
| `offers[].leadTimeDays` | integer | yes |  |
| `offers[].availability` | `in_stock` \| `low_stock` \| `out_of_stock` \| `made_to_order` | yes |  |
| `offers[].inventoryAgeHours` | number | yes |  |
| `offers[].freshness` | `fresh` \| `aging` \| `stale` | yes | fresh ≤ 24h, aging ≤ 7d, stale beyond |
| `offers[].score` | number | yes | 0–1, deterministic. No paid placement exists. |
| `offers[].matchReasons` | string[] | yes |  |
| `considered` | integer | yes |  |
| `excluded` | object[] | yes | A capped sample of what was filtered out, each with a plain-language reason |
| `excluded[].merchantId` | string | yes |  |
| `excluded[].itemId` | string |  |  |
| `excluded[].reason` | string | yes |  |

### Order

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | yes |  |
| `merchantId` | string | yes |  |
| `accountHolderId` | string | yes |  |
| `lines` | object[] | yes |  |
| `lines[].itemId` | string | yes |  |
| `lines[].sku` | string | yes |  |
| `lines[].name` | string | yes |  |
| `lines[].unit` | string | yes |  |
| `lines[].quantity` | integer | yes |  |
| `lines[].unitPriceCents` | integer | yes | Integer minor units (cents) |
| `lines[].lineTotalCents` | integer | yes | Integer minor units (cents) |
| `totalCents` | integer | yes | Integer minor units (cents) |
| `currency` | `ZAR` \| `USD` \| `NGN` \| `KES` | yes |  |
| `status` | `placed` \| `accepted` \| `rejected` \| `preparing` \| `ready` \| `dispatched` \| `delivered` \| `cancelled` | yes |  |
| `fulfilment` | object | yes |  |
| `fulfilment.method` | `collection` \| `delivery` | yes |  |
| `fulfilment.address` | string |  |  |
| `fulfilment.neededBy` | string |  |  |
| `fulfilment.promisedAt` | string |  |  |
| `fulfilment.deliveredAt` | string |  |  |
| `fulfilment.trackingReference` | string |  |  |
| `cardTransactionId` | string |  |  |
| `note` | string |  |  |
| `createdAt` | string | yes | ISO 8601 timestamp |
| `updatedAt` | string | yes | ISO 8601 timestamp |
| `history` | object[] | yes |  |
| `history[].status` | `placed` \| `accepted` \| `rejected` \| `preparing` \| `ready` \| `dispatched` \| `delivered` \| `cancelled` | yes |  |
| `history[].at` | string | yes | ISO 8601 timestamp |
| `history[].by` | `buyer` \| `merchant` | yes |  |
| `history[].note` | string |  |  |
