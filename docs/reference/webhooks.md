# Webhooks and events

A-CARD sends and receives webhooks in five places. They all sign with HMAC-SHA256, but they are not interchangeable, so this page takes them one at a time.

| Webhook | Direction | Who calls whom | Signed with |
|---|---|---|---|
| [Issuer events](#issuer-events) | Inbound | Card issuer → A-CARD | Shared secret, `x-acard-signature` |
| [Merchant events](#merchant-events) | Outbound | A-CARD → a merchant's POS or ERP | **sha256 of** the merchant's secret, `x-acard-signature` |
| [Approval notifications](#approval-notifications-slack) | Outbound | A-CARD → Slack | Slack Incoming Webhook URL (unsigned) |
| [Verification decisions](#verification-decisions) | Inbound | Didit → A-CARD | Provider secret, `x-signature` |
| [PayFast ITN](#payfast-itn) | Inbound | PayFast → A-CARD | PayFast signature + confirm-back |

> **Not available yet: account-holder webhooks.** A-CARD records internal events (cards created, authorizations approved or declined, approvals requested; see [platform events](#platform-events)), but it doesn't yet deliver them to an account holder's own endpoint. Today, agents learn outcomes from the API response itself, and humans learn about held charges through Slack. If you need push delivery of authorization or approval events, poll `GET /v1/approvals?status=pending` and `GET /v1/transactions` for now. This is on the [roadmap](../versioning.md#roadmap-items-that-will-be-additive).

---

## The signature scheme

The issuer and merchant webhooks share one format, Stripe-style:

```
x-acard-signature: t=1761400000,v1=5f2b…c9a1
```

- `t` is the Unix time the payload was signed.
- `v1` is the lowercase hex HMAC-SHA256 of `` `${t}.${rawBody}` `` under the signing key.
- Deliveries more than **300 seconds** from your clock are rejected. This is replay protection, so keep NTP running.

### Verifying it

Verify the **raw request bytes**. If you parse the JSON and re-serialize it, key order and whitespace change and the signature won't match.

```ts
import { createHmac, timingSafeEqual } from "node:crypto";

export function verifyAcardSignature(rawBody: string, header: string | null, key: string, toleranceSeconds = 300): boolean {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(",").map((p) => p.trim().split("=", 2)));
  const t = Number(parts.t);
  if (!Number.isFinite(t) || !parts.v1) return false;
  if (Math.abs(Date.now() / 1000 - t) > toleranceSeconds) return false;
  const expected = createHmac("sha256", key).update(`${t}.${rawBody}`).digest();
  const given = Buffer.from(parts.v1, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}
```

Or use the SDK, which handles both key types for you:

```ts
import { verifyIssuerWebhook, verifyMerchantWebhook } from "@acard/sdk";
```

```python
import hashlib, hmac, time

def verify_acard_signature(raw_body: bytes, header: str, key: str, tolerance: int = 300) -> bool:
    parts = dict(p.strip().split("=", 1) for p in header.split(","))
    t = int(parts["t"])
    if abs(time.time() - t) > tolerance:
        return False
    expected = hmac.new(key.encode(), f"{t}.".encode() + raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, parts["v1"])
```

---

## Issuer events

**`POST /webhooks/issuer`** is how the card issuer asks A-CARD to decide on a charge. If you're integrating as an issuing partner, this is your contract. If you're building on A-CARD, you never call it directly: `/v1/simulate/purchase` (and MCP `pay_checkout`) sign and send these for you in the sandbox, through the exact same handler.

**Signing key:** the shared `ISSUER_WEBHOOK_SECRET`.

Every event has the same envelope:

```json
{ "id": "evt_01J…", "type": "authorization.request", "data": { … } }
```

### `authorization.request`

The real-time decision. A-CARD answers **in the HTTP response** and must do so inside the card network's ~2-second window, so the decision path makes no network calls.

```json
{
  "id": "evt_9c1…",
  "type": "authorization.request",
  "data": {
    "authorization_id": "auth_7f3…",
    "card_id": "card_2Lk…",
    "amount": 485000,
    "currency": "ZAR",
    "merchant": { "name": "Highveld Tyre & Fuel", "category": "5541", "country": "ZA" }
  }
}
```

`card_id` may be A-CARD's card id or the issuer's own card reference; both resolve.

**Response:**

```json
{ "approved": false, "decline_reason": "pending_human_approval", "approval_id": "apr_4Qx…" }
```

| Field | Present | Meaning |
|---|---|---|
| `approved` | always | Whether a hold was placed |
| `decline_reason` | when declined | One of the [decline reasons](errors.md#decline-reasons) |
| `approval_id` | when held for a human | The open review |

**Exactly-once.** Authorizations are idempotent by `authorization_id`. A retried request gets the original decision back and never places a second hold.

### `transaction.capture`

Settles a hold. `final_amount` is optional and supports partial capture (it must be > 0 and ≤ the amount held). Single-use cards close after their first capture.

```json
{ "id": "evt_…", "type": "transaction.capture", "data": { "authorization_id": "auth_7f3…", "final_amount": 470000 } }
```

### `authorization.reversal`

Releases a hold without capturing it.

```json
{ "id": "evt_…", "type": "authorization.reversal", "data": { "authorization_id": "auth_7f3…" } }
```

Captures and reversals are processed **at most once per event `id`**. A redelivered event returns `{ "received": true, "duplicate": true }` and changes nothing.

---

## Merchant events

A-CARD **pushes** order events to a merchant's own system, so a till learns about an agent's order the moment it's placed instead of on its next poll.

### Registering an endpoint

With a `read_write` merchant API key (`mk_live_…`):

```bash
curl -X PUT https://your-api-host/v1/merchant-api/webhook \
  -H "Authorization: Bearer mk_live_…" \
  -H "Content-Type: application/json" \
  -d '{ "url": "https://pos.example.co.za/acard", "events": ["order.placed", "order.cancelled"] }'
```

```json
{ "webhook": { "url": "https://pos.example.co.za/acard", "events": ["order.placed", "order.cancelled"], "consecutiveFailures": 0, … },
  "secret": "mwh_3f9a…" }
```

The `secret` is shown **once**. A-CARD stores only its SHA-256 digest. Leave `events` empty to receive everything.

### ⚠️ The signing key is sha256(secret), not the secret

Merchant events are signed with the **SHA-256 hex digest of your `mwh_` secret**, not the secret itself, because the digest is all A-CARD keeps. Derive the key once and verify with it:

```ts
import { createHash } from "node:crypto";
const signingKey = createHash("sha256").update(process.env.ACARD_WEBHOOK_SECRET!).digest("hex");
verifyAcardSignature(rawBody, req.headers["x-acard-signature"], signingKey);
```

```python
signing_key = hashlib.sha256(os.environ["ACARD_WEBHOOK_SECRET"].encode()).hexdigest()
```

If you verify with the raw secret, every delivery fails with a bad signature. The SDK's `verifyMerchantWebhook(rawBody, header, secret)` takes the raw secret and derives the key for you.

### Delivery

```
POST https://pos.example.co.za/acard
content-type: application/json
x-acard-event: order.placed
x-acard-signature: t=1761400000,v1=…
```

```json
{
  "id": "evt_mh3k2x_9fq1z0a4",
  "type": "order.placed",
  "created_at": "2026-10-25T09:14:03.112Z",
  "merchant_id": "mer_…",
  "data": { "order": { "id": "ord_…", "status": "placed", "lines": [ … ], "totalCents": 5750000, … } }
}
```

`data.order` is a full [`Order`](../api/reference.md#order).

| Event | When |
|---|---|
| `order.placed` | A buyer (usually an agent) placed an order with you. Also what `POST /v1/merchant-api/orders/{id}/redeliver` re-sends. |
| `order.cancelled` | The buyer cancelled an order |

Status changes **you** make (accept, dispatch, deliver) aren't echoed back to you. You made them, so you already know.

### Reliability: honest about what it is

Delivery is **attempted once**, with a 5-second timeout. It isn't a retrying queue, and that's deliberate:

- A failed delivery never fails the agent's order. The order is recorded either way.
- Every attempt is recorded on your merchant record (`lastDeliveryAt`, `lastDeliveryOk`, `consecutiveFailures`), so a dead endpoint is visible rather than silent.
- Nothing is lost. Orders are always readable from `GET /v1/merchant-api/orders`, and `POST /v1/merchant-api/orders/{id}/redeliver` resends a missed one.

**Recommended:** handle the push for speed, and reconcile with `GET /v1/merchant-api/orders?status=placed` on a schedule (every few minutes) so a missed delivery is caught.

Respond `2xx` quickly and do your work asynchronously. Use the event `id` to de-duplicate, because a redelivery carries a new `id` for the same order. The order id is the stable key.

---

## Approval notifications (Slack)

Set `SLACK_APPROVALS_WEBHOOK_URL` to a Slack Incoming Webhook, and every charge held for a human posts to that channel:

> :bank: **A-CARD approval needed**
> Card `card_2Lk…` wants to charge **18400.00**, waiting on a human decision.
> Open the approvals queue

The message links to the dashboard approvals queue when `DASHBOARD_URL` is set (otherwise it shows the approval id). Approving and denying happen in the dashboard, the CLI (`acard approvals`) or the API (`POST /v1/approvals/{id}/approve`), not from inside Slack.

---

## Verification decisions

**`POST /webhooks/compliance`** receives KYC/KYB/AML decisions from Didit when compliance is enabled. You configure this URL in Didit; you don't call it.

- Signed by the provider in `x-signature` (or `x-didit-signature`), checked against `DIDIT_WEBHOOK_SECRET`.
- A decision for a session A-CARD doesn't know about returns `{ "received": true, "matched": false }` so the provider stops retrying.
- An approved merchant becomes discoverable automatically, and a declined one is suspended, unless a human override already exists.

⚠️ The signature header and scheme are isolated in `apps/api/src/compliance/didit.ts` and haven't yet been verified against Didit's published API reference. A mismatch fails closed: every delivery is rejected and nothing is approved by accident.

---

## PayFast ITN

**`POST /webhooks/payfast`** receives PayFast's Instant Transaction Notification for real ZAR top-ups and subscription upgrades. A wallet is credited only after the ITN passes PayFast's signature check, a source-IP check and a confirm-back call to PayFast. A failing ITN returns `401 invalid_itn`. Non-`COMPLETE` payments are acknowledged and ignored.

---

## Platform events

Inside A-CARD, every state change emits an event. They drive the Slack notifier today, and they're the foundation for account-holder webhooks later.

| Event | Emitted when |
|---|---|
| `account_holder.created` | An organization signs up |
| `wallet.funded` | A wallet is credited |
| `wallet.embedded_provisioned` | An embedded crypto wallet is created at signup |
| `wallet.external_linked` / `wallet.unlinked` | A crypto wallet is linked or removed |
| `card.created` / `card.closed` | A card is issued or closed |
| `card.issuer_linked` | A real issuer provisioned the card |
| `authorization.approved` / `authorization.declined` | An authorization decision |
| `authorization.reversed` | A hold was released |
| `transaction.captured` | A hold was settled |
| `approval.requested` | A charge was held for a human (this one reaches Slack) |
| `department.created` / `policy.updated` | Enterprise governance changed |
| `subscription.updated` | The plan changed |
| `sso.configured` / `sso.login` | SSO set up or used |

Each event is `{ id, type, data, createdAt }`. Treat this list as informational until account-holder webhooks ship. Event names are stable, but delivery to your endpoint isn't available yet.
