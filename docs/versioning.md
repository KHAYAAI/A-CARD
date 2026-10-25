# Versioning and compatibility

What A-CARD promises not to break, what counts as a breaking change, and how you'll hear about one.

## The API version is the path

Every endpoint lives under `/v1`. Within `/v1` we make **additive changes only**. A breaking change ships as `/v2`, alongside `/v1`, never in place of it.

There is no version header and no date-pinned version. If you're on `/v1`, you stay on `/v1` until you choose to move.

## What we may add without notice

Build your integration to tolerate these. They're not breaking changes:

| Change | What your code must do |
|---|---|
| New endpoints | Nothing |
| New **optional** request fields | Nothing |
| New response fields | **Ignore fields you don't recognise.** Don't fail on unknown keys. |
| New **error codes** | Treat an unknown `error.code` by its HTTP status class (4xx: don't retry; 5xx: retry with the same idempotency key) |
| New **decline reasons** | Treat an unknown `decline_reason` as a final decline: stop and report it. Only `pending_human_approval` means "wait". |
| New enum values in responses (e.g. a new order status) | Handle the unknown value gracefully, e.g. display it raw |
| New webhook event types | Ignore types you don't handle. Subscribe with an explicit `events` list if you only want some. |
| New MCP tools | Nothing. Agents see them on their next tool listing. |
| Wording of `message` fields | Nothing, as long as you never parse them |

The SDK already follows these rules. Its `DeclineReason` type is the known set, and the API may still send a reason not in it.

## What counts as breaking

Any of these goes to `/v2`, never into `/v1`:

- Removing or renaming an endpoint, a request field or a response field
- Making an optional request field required
- Changing a field's type or units (amounts stay integer minor units)
- Changing the meaning of an existing `error.code` or `decline_reason`
- Changing the order in which authorization checks run, when that changes *which* decline reason is reported
- Changing the webhook signature scheme for an existing endpoint
- Tightening validation so a previously valid request is rejected

**Not breaking**, and may change in `/v1`: response field order, `message` text, `id` formats (treat ids as opaque strings), rate limits, and fixes that make the API match its documentation.

## Deprecation

When something in `/v1` is superseded:

1. It's marked **deprecated** in the OpenAPI spec and the [changelog](../CHANGELOG.md), with its replacement.
2. Deprecated endpoints return a `Deprecation` header and a `Link` to the replacement.
3. It keeps working for **at least 12 months** after the deprecation notice.
4. Account holders whose keys called it in the previous 30 days are emailed before removal.

Nothing in `/v1` is deprecated today.

## Security exceptions

We'll make a breaking change inside `/v1` without the usual notice if leaving it in place would expose customers to fraud or a security vulnerability. When that happens, it's announced in the changelog with what changed and why.

## The SDK

`@acard/sdk` follows [semantic versioning](https://semver.org) independently of the API:

- **Patch**: fixes
- **Minor**: new methods and types for API additions
- **Major**: changes to the SDK's own surface (renamed methods, changed signatures) and support for a new API version

Pin a major version. The SDK isn't published to npm yet; the first published version will be `0.1.0`, and `1.0.0` marks a stable SDK surface.

## The OpenAPI document

`docs/api/openapi.json`, and `GET /openapi.json` on any deployment, is generated from the validators the API actually runs, and a test fails the build if it drifts. `info.version` tracks the API: `1.x.y` for `/v1`. The minor version increments when endpoints or fields are added.

## Roadmap items that will be additive

These are planned and will ship inside `/v1` without breaking anything:

- **Account-holder webhooks**: push delivery of `authorization.*`, `approval.*` and `card.*` events to your own endpoint, signed with the same `t=…,v1=…` scheme. Until then, poll `/v1/approvals` and `/v1/transactions`.
- **Live card issuance** with an issuing partner. Card responses gain issuer fields; the sandbox `sandboxPan` stops appearing in production.
- **Sandbox-specific key prefix** (`ak_test_`) for sandbox deployments. Existing `ak_live_` keys keep working.
- **AFP rails** beyond card (bank/EFT, and x402 and stablecoin going live) appear as new `rail` values.
- An **MCP `place_order` tool**, matching `POST /v1/merchants/{id}/orders`.
