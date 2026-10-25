# Errors and decline reasons

Two different things go wrong in A-CARD, and they are reported differently:

- **An API error** means the request itself failed: bad input, missing permission, a resource that does not exist. You get a non-2xx status and an `error` body.
- **A decline** means the request worked and the answer was *no*: a card authorization the rules refused. The HTTP call succeeds; the decision carries a `decline_reason`.

An agent that treats a decline as an error will retry something that will never succeed. An agent that treats an error as a decline will give up on something it could fix. Keep them apart.

> This page is checked by `apps/api/test/errors-reference.test.ts`: every error code and decline reason in the source must appear here, so a new code can't ship undocumented.

---

## The error envelope

Every API error has the same shape:

```json
{
  "error": {
    "code": "not_found",
    "message": "card card_7Hq2 not found"
  }
}
```

- **Branch on `code`.** It is stable within `/v1`. See [versioning](../versioning.md).
- **Don't parse `message`.** It is for humans, and its wording can change.
- **`invalid_request` adds `issues`**: the validation problems, one per field, so you can show exactly what to fix.

```json
{
  "error": {
    "code": "invalid_request",
    "message": "Number must be greater than 0",
    "issues": [{ "code": "too_small", "path": ["limits", "total"], "message": "Number must be greater than 0" }]
  }
}
```

A few errors carry extra top-level fields next to `error`:

| Code | Extra field | Why |
|---|---|---|
| `verification_required` | `verification_status` | Where the org is in verification: `not_started`, `pending`, `declined`, and so on |
| `no_viable_rail` | `rejected` | Each rail AFP considered and why it couldn't carry the intent |
| `execution_failed` | `transaction` | The AFP transaction, recorded as failed |

## HTTP status codes

| Status | Meaning | Retry? |
|---|---|---|
| `400` | The request is malformed or breaks a rule about its own contents | No. Fix the request. |
| `401` | No credential, or an invalid one | No. Fix the credential. |
| `402` | Your plan or balance doesn't cover this | No, until you upgrade or fund |
| `403` | Authenticated, but not allowed | No. Needs a different role, key or verification state. |
| `404` | Doesn't exist, **or isn't yours**. A resource owned by another org always returns 404, never 403, so its existence isn't revealed. | No |
| `409` | Conflicts with current state | Usually no. Re-read the resource first. |
| `422` | Understood, but nothing can carry it out right now | Maybe later |
| `429` | Rate-limited | Yes, after waiting |
| `5xx` | Our side, or a partner's | Yes, with backoff **and the same `Idempotency-Key`** |

### Retrying safely

Every write that moves money or creates something accepts an `Idempotency-Key` header. Send a fresh unique key per logical operation and reuse it on every retry of that same operation:

- Same key, same body: you get the original response back, and nothing happens twice.
- Same key, different body: `409 idempotency_conflict`.
- AFP execution (`POST /v1/afp/intents/{id}/execute`) **requires** the key, enforced by a database unique index, because a duplicated payment cannot be undone.

---

## Error codes

### Requests and authentication

| Code | Status | What it means | What to do |
|---|---|---|---|
| `invalid_request` | 400 | A field failed validation. See `issues`. | Fix the named fields |
| `unauthorized` | 401 | Missing, invalid or revoked credential | Check the `Authorization: Bearer` header and the key prefix (`ak_`, `sess_`, `mk_live_`) |
| `forbidden` | 403 | Your role, key scope or shop role doesn't allow this | Use a higher role, a `full` / `read_write` key, or the shop owner |
| `https_required` | 400 | The deployment enforces HTTPS and the request came over HTTP | Call the `https://` URL |
| `session_required` | 403 | MFA is managed by a signed-in person, not an API key | Use a dashboard session |
| `idempotency_conflict` | 409 | An `Idempotency-Key` was reused with a different body | Use a new key for a new operation |
| `idempotency_key_required` | 400 | AFP execution needs an `Idempotency-Key` | Send one |
| `internal` | 500 | Unexpected failure on our side | Retry with the same idempotency key; report it if it persists |

### Accounts, login and team

| Code | Status | What it means |
|---|---|---|
| `invalid_credentials` | 401 | Wrong email or password |
| `account_locked` | 429 | Too many failed logins. Wait a few minutes. |
| `weak_password` | 400 | Passwords need at least 8 characters |
| `password_required` | 400 | Adding a brand-new member requires a starting password |
| `no_membership` | 403 | The user belongs to no organization |
| `invalid_mfa_challenge` | 401 | The MFA login attempt expired. Sign in again. |
| `invalid_mfa_code` | 401 | Wrong authenticator code |
| `blocked` | 403 | This identity is on a compliance blocklist and can't be onboarded |
| `sso_not_configured` | 501 / 404 | SSO isn't set up on this deployment (501), or not for this domain or org (404) |

### Plans and keys

| Code | Status | What it means |
|---|---|---|
| `plan_limit_exceeded` | 402 | Your plan's monthly card count is used up. Upgrade, or wait for next month. |
| `plan_card_cap_exceeded` | 402 | The requested card total is above your plan's per-card cap. Lower `limits.total` or upgrade. |
| `api_key_spend_cap_exceeded` | 403 | This API key has provisioned all the card budget it is allowed (`spend_cap_cents`) |
| `card_budget_required` | 400 | A spend-capped key must set `limits.total` on every card it creates |

### Resources and state

| Code | Status | What it means |
|---|---|---|
| `not_found` | 404 | No such resource, or not yours |
| `invalid_state` | 409 | The resource isn't in a state that allows this: approving an approval that was already decided, enabling MFA twice, linking a wallet that is already linked, and so on |
| `invalid_department` | 400 | Department name missing, budget not a positive integer, or the department belongs to another org |
| `invalid_policy` | 400 | Policy approval threshold isn't a positive integer |

### Money and the ledger

| Code | Status | What it means |
|---|---|---|
| `insufficient_funds` | 402 | Not enough available balance. As an API error this comes from ledger operations; card charges report it as a [decline](#decline-reasons). |
| `invalid_amount` | 400 | Amounts must be positive integers of minor units |
| `currency_mismatch` | 400 | Ledger postings must share the transaction's currency. Also a decline reason. |
| `invalid_capture_amount` | 400 | A capture must be greater than 0 and no more than the amount held |
| `invalid_posting` | 400 | A ledger posting amount isn't a positive integer |
| `unbalanced_transaction` | 400 | Debits must equal credits, across at least two postings. Internal invariant; you should never see this. |
| `instant_funding_disabled` | 409 | Real ZAR funding is configured, so instant credit is off for ZAR. Use `POST /v1/wallet/fund/checkout`. |
| `funding_not_configured` | 501 | PayFast isn't configured on this deployment |
| `billing_not_configured` | 501 | Subscription billing isn't configured on this deployment |
| `invalid_itn` | 401 | A PayFast notification failed signature, source or confirm-back checks |

### Cards and issuing

| Code | Status | What it means |
|---|---|---|
| `issuer_provisioning_failed` | 502 | The card issuer couldn't provision the card. A-CARD has closed the local card rather than return one that can never authorize. Safe to retry. |
| `invalid_signature` | 401 | An inbound webhook signature didn't verify. The `message` gives the reason (see [webhook signature failures](#webhook-signature-failures)). |

### A-MERCHANT

| Code | Status | What it means |
|---|---|---|
| `empty_order` | 400 | An order needs at least one line |
| `invalid_quantity` | 400 | Quantities must be positive integers |
| `address_required` | 400 | A delivery order needs a delivery address |
| `wrong_merchant` | 400 | An item on the order belongs to a different merchant |
| `mixed_currency` | 400 | Every line on an order must share a currency |
| `forbidden_transition` | 400 | Only the buyer can cancel, and only the merchant can advance an order |
| `invalid_price` | 400 | Unit prices must be non-negative integers of minor units |
| `reviewer_required` | 400 | A KYB decision must name who made it |
| `uploader_required` | 400 | A KYB document must record who uploaded it |
| `issuer_required` | 400 | A portal invite or merchant API key must record who issued it |
| `invalid_key` | 400 | This KYB document key wasn't issued for this merchant |
| `invalid_invite` | 400 | The portal invite link is invalid |
| `invite_used` | 400 | The portal invite has already been used |
| `invite_expired` | 400 | The portal invite has expired |

Ordering a non-verified merchant, or moving an order backwards (e.g. `delivered` → `preparing`), returns `invalid_state`.

### AFP

| Code | Status | What it means |
|---|---|---|
| `no_viable_rail` | 422 | No configured rail can carry this intent. `rejected` says why for each rail. |
| `execution_failed` | 402 | The rail definitively refused the payment. The transaction is recorded as failed. An *ambiguous* outcome never returns this: it parks the transaction as `reconciling` instead. |
| `not_reversible` | 400 | The rail settles instantly. The ledger won't pretend to reverse it; record a new offsetting transfer. |

### Compliance

| Code | Status | What it means |
|---|---|---|
| `verification_required` | 403 | With enforcement on, funding and card issuance require completed verification, and a sanctions hit blocks them pending review. Reads, discovery and onboarding are never gated. |
| `reason_required` | 400 | A compliance override must say why |
| `country_required` | 400 | Registry search needs `country_code` |

### Webhook signature failures

When `/webhooks/issuer` rejects a delivery with `401 invalid_signature`, the `message` is one of these:

| Reason | Meaning |
|---|---|
| `missing_signature` | No `x-acard-signature` header |
| `malformed_signature` | The header isn't `t=<unix>,v1=<hex>` |
| `malformed_timestamp` | `t` isn't a number |
| `timestamp_out_of_tolerance` | More than 300 seconds between `t` and now. This is replay protection: check the sender's clock. |
| `bad_signature` | The HMAC doesn't match. Wrong secret, or the body was modified (for example re-serialized JSON). |

---

## Decline reasons

A decline is the answer to a card authorization. You'll see it in three places:

- `decline_reason` on the `/v1/simulate/purchase` response, and on the issuer webhook's decision
- `declineReason` on the declined [`CardTransaction`](../api/reference.md#cardtransaction) in `/v1/transactions` and `/v1/audit`
- the result of an MCP `pay_checkout` call (`approved: false` with `decline_reason`). It comes back as a normal tool result, not a tool error, because the call itself succeeded.

### The order they're checked in

Checks run in a fixed order and **the first failure wins**. A charge that would break three rules reports only the first. This is the real order in `Platform.authorize`:

| # | Check | Decline reason |
|---|---|---|
| 1 | Exactly-once guard on the issuer authorization id | — (a retry returns the original decision) |
| 2 | The card exists | `card_not_found` |
| 3 | Org policy: category not blocked org-wide | `merchant_category_blocked_by_policy` |
| 4 | Card is active | `card_closed` |
| 5 | Charge currency is the card's currency | `currency_mismatch` |
| 6 | Merchant category is on the card's allow-list (an empty list allows all) | `merchant_category_not_allowed` |
| 7 | Amount ≤ per-transaction limit | `per_transaction_limit_exceeded` |
| 8 | Spend to date + amount ≤ total limit | `card_total_limit_exceeded` |
| 9 | Spend in the velocity window + amount ≤ velocity limit | `velocity_limit_exceeded` |
| 10 | Amount below the card's or the org's approval threshold, or a matching grant exists | `pending_human_approval` |
| 11 | Department monthly budget has room | `department_budget_exceeded` |
| 12 | Atomic hold fits in available balance | `insufficient_funds` |

### What each one means for an agent

| Decline reason | Meaning | What the agent should do |
|---|---|---|
| `card_not_found` | No such card | Stop. The card id is wrong. |
| `merchant_category_blocked_by_policy` | The organization blocks this category for every card | Stop. No card in this org can buy here. Tell the human. |
| `card_closed` | The card is closed. Single-use cards close after their first capture. | Ask for a new card |
| `currency_mismatch` | Card and charge currencies differ | Use a card in the charge's currency |
| `merchant_category_not_allowed` | This card isn't allowed at this kind of merchant | Stop. Wrong card for this purchase. |
| `per_transaction_limit_exceeded` | Over this card's single-charge ceiling | Ask. Splitting a charge to get under the limit defeats the control, so only do it if the human has said so. |
| `card_total_limit_exceeded` | The card's lifetime budget would be exceeded | Ask for more budget or a new card |
| `velocity_limit_exceeded` | Too much spent inside the rolling window | Wait for the window to roll, or ask |
| `pending_human_approval` | At or above an approval threshold. **A review is now open.** | Wait. When a human approves, **retry the same charge once**. It consumes a single-use grant for this card and merchant, up to the approved amount. If it's denied, stop. |
| `department_budget_exceeded` | The department's monthly budget is spent | Ask. Resets next month. |
| `insufficient_funds` | The wallet's available balance can't cover the hold | Ask the human to fund the wallet |

`pending_human_approval` is the only decline that expects a retry, and only after a decision. The `approval_id` returned with it points at the open review: poll `GET /v1/approvals?status=pending`, or watch for the human to act.

### Review reasons

When a charge is held, the open approval's `reason` says which threshold caught it. These appear on the [`Approval`](../api/reference.md#approval) object, not as decline reasons:

| Reason | Set by |
|---|---|
| `amount_requires_human_approval` | The card's own `approval_threshold` |
| `amount_requires_org_approval` | The org policy's `approval_threshold`, which applies even when the card has none |

### Card close reasons

`closeReason` on a closed card:

| Reason | Meaning |
|---|---|
| `single_use_completed` | A single-use card closed itself after its first capture |
| `issuer_provisioning_failed` | The issuer couldn't provision it, so A-CARD closed it rather than leave a card that can never work |
