# Investec programmable-card pilot: runbook

A first real-world test of A-CARD's decision layer, on **your own Investec business account**, with a small budget. Investec issues the card and settles the charges. A-CARD only decides, for each charge, whether to approve or decline, using the card's limits, merchant-category rules and approval threshold.

## What this proves, and what it doesn't

| Proves | Does not prove |
|---|---|
| A-CARD's rules engine makes correct approve/decline calls on real card traffic, fast enough | That A-CARD can issue cards to customers (it can't: this only works on your own account) |
| The hold → settle / release ledger tracks real spend | Regulatory readiness, card-network certification, or scale |
| Your team and agents can operate the controls day to day | Anything about crypto or stablecoin rails |

## What's in the repo

- `integrations/investec/main.js`: the card code you paste into Investec's editor. `beforeTransaction` asks A-CARD; `afterTransaction` settles the hold; `afterDecline` releases it.
- `integrations/investec/env.example.json`: the three settings it needs.
- API endpoints (only mounted when `ACARD_INVESTEC_HOOK_SECRET` is set): `POST /webhooks/investec/authorize`, `/settle`, `/release`. They use their own bearer secret, **not** the issuer webhook secret, and can only act on holds the hook created (`inv_…` ids) for cards you have mapped.
- Tests: `apps/api/test/investec-hook.test.ts` runs the real `main.js` against the real API (approve, decline, threshold, unlinked card, foreign currency, wrong secret, outage, fail-open, settle, release).

## Read this before you start: unverified assumptions

I wrote `main.js` from Investec's public programmable-card documentation as I understood it. I have **not** run it against an Investec account. Check each of these in Investec's card-code simulator before any real charge:

1. The hook is `beforeTransaction(authorization)` returning `true` or `false`, with `afterTransaction` and `afterDecline` callbacks.
2. The authorization carries `card.id`, `centsAmount`, `currencyCode`, `reference`, and `merchant.{name, category.code, country.code}`. If a name differs, edit `describe()` in `main.js`: it is the only place that reads the object.
3. `fetch` and `process.env` (from `env.json`) are available in card code, and an outbound call can finish inside Investec's time limit. `main.js` times out after 1.5 s; if Investec's limit is shorter, lower `TIMEOUT_MS`.
4. `transaction.reference` in the after-callbacks equals `authorization.reference` from `beforeTransaction`. If it doesn't, settle and release won't find the hold, and holds will pile up (see "Known gaps").
5. Investec's terms allow card code to call an external service with transaction data. Confirm with your relationship manager, and check POPIA implications of sending merchant and amount data to A-CARD.

## Setup

1. **Pick the card.** Use one Investec business card with a low limit, that you control. Not your main card.
2. **Create the matching card in A-CARD** (console or API). It is a budget envelope: its limits and rules are what the hook enforces. Note its id.
   - Fund the A-CARD wallet with the pilot budget only (for example R2 000). With PayFast switched off, `POST /v1/wallet/fund` is an instant ledger credit, so no real money moves in A-CARD. **Do not switch PayFast on for this pilot.**
   - Set the policy: blocked categories (for example `7995` gambling) and an approval threshold.
3. **Configure the API.**
   ```
   ACARD_INVESTEC_HOOK_SECRET=<at least 24 random characters; keep it out of chat and the repo>
   ACARD_INVESTEC_CARDS={"<Investec card id>":"<A-CARD card id>"}
   ```
   Restart the API. The log shows nothing special; confirm with `curl -i -X POST $ACARD_URL/webhooks/investec/authorize`, which should answer 401.
4. **Install the card code.** In Investec Programmable Banking, open the card's code editor, paste `main.js`, and create `env.json` from `env.example.json` (URL, the hook secret, `ACARD_FAIL_OPEN` = `false`). Treat `env.json` like a password.
5. **Simulate first.** Use Investec's simulator with: a R50 grocery charge (expect approve), a gambling charge (expect decline), a charge above your threshold (expect decline for now), and a charge in euros (expect decline). Read Investec's logs for the `a-card:` lines.

## Pilot test plan (one afternoon)

| # | Action | Expect |
|---|---|---|
| 1 | Small charge at an ordinary shop (R20–R100) | Approved; A-CARD shows a hold, then settled for the final amount |
| 2 | Charge in a blocked category (or simulate) | Declined; reason in A-CARD's audit log |
| 3 | Charge over the approval threshold | Declined now (see Known gaps); the approval appears in the console |
| 4 | Turn the A-CARD API off, try a charge | Declined (fail closed). Turn it on again |
| 5 | Close the card in A-CARD, try a charge | Declined |
| 6 | Compare A-CARD's wallet to Investec's statement | Same total spend, no stuck holds |

Success: every outcome above matches, decisions come back inside Investec's time limit, and the ledger agrees with the statement.

## Kill switch

Any one of these stops A-CARD from approving anything: set the A-CARD card to closed; unset `ACARD_INVESTEC_HOOK_SECRET` (the endpoints disappear and, with fail-closed, every charge is declined); or remove the card code in Investec. If you set `ACARD_FAIL_OPEN=true`, an A-CARD outage means charges are **approved** instead: don't, except knowingly for a short test.

## Known gaps

- **Approval-required charges are declined, not paused.** A card network needs an answer in about two seconds, so a person can't approve in time. The decline is recorded and visible in the console. A "retry after approval" flow, as the sandbox agent does, is not built for this pilot.
- **Settle and release depend on assumption 4.** If the references differ, holds pile up and A-CARD's available balance drifts below reality until they're cleared. The test plan's step 6 catches this.
- **Only ZAR and USD.** Other currencies are declined.
- **A-CARD downtime means declines**, by design.
- **It sees merchant and amount data**, not card numbers. Still personal-adjacent data: tell Investec and check POPIA.

## From pilot to product

This pilot de-risks the decision layer only. To issue cards to customers you still need an issuing partner and a programme (see the "What it takes to go live" list): a BIN sponsor or banking-as-a-service provider, then the same `authorization.request` webhook that already exists at `POST /webhooks/issuer`.
