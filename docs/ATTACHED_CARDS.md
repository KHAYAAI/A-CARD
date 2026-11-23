# Attached cards (bring your own card) alongside issued cards

_Status: a sandbox prototype exists (`apps/sandbox/src/vault.ts`, Wallet, then "Your cards"). Nothing here handles a real card._

## Two ways an agent can pay, behind the same controls

| | Issued card (today's model) | Attached card (new) |
|---|---|---|
| Whose card | A virtual card A-CARD issues through a partner, funded from the A-CARD wallet | The customer's own existing card |
| Needs | An issuing partner (BIN sponsor), funds handling | A card vault or network tokens; no issuer, no funds held by A-CARD |
| Where A-CARD decides | At authorisation, when the network asks (`/webhooks/issuer`) | Before the card is released: rules, limits, then the holder's approval, then a single-use stand-in |
| Disputes and rewards | Through A-CARD's programme | The customer's own bank |
| Best for | Companies giving agents budgets; per-task cards | Individuals and small businesses who want agents to use a card they already have |

Both share the same rules engine, organisation policy, approvals and audit log, so a customer can use either or both. In routing terms, an attached card is one more rail.

## What the sandbox prototype shows

- Attach a card. Only published test numbers are accepted, and only brand and last four digits are kept.
- The agent calls `pay_with_my_card`. A-CARD applies the organisation's blocked categories and the holder's per-purchase cap; anything over the holder's auto-approve amount waits for the holder (a passkey or Face ID prompt in production).
- Only after approval is a single-use stand-in released, bound to one merchant and one amount, and expiring in 10 minutes. A second charge, a higher amount or a different merchant is refused.

## Built in the platform (not only the sandbox)

`apps/api/src/attachedCards/` and the dashboard's Wallet, then "Your cards":

| Need | What exists | What's still missing |
|---|---|---|
| **Card storage by someone certified** | A `CardVaultProvider` contract (`provider.ts`): `describe`, `release`, `remove`. A-CARD stores only the provider's reference plus brand, last four and expiry. Every attached-cards request containing a card number is refused (`card_number_refused`). A test provider for development, refused in production. | A real adapter: Visa Intelligent Commerce / Mastercard Agent Pay tokens, or a PCI-certified vault. Needs a signed partner and their API docs. |
| **Real passkey approval** | WebAuthn with `@simplewebauthn` (MIT). Register a passkey on the holder's device; approve a held purchase with a signature bound to that purchase, requiring user verification (Face ID, fingerprint or PIN), checking origin, single use, expiring in 5 minutes. Agent API keys are refused (`person_required`). Tested with a software authenticator in `apps/api/test/attached-cards.test.ts`, and end to end in a browser with Chromium's virtual authenticator. | Done: see "Lost phone" below. |
| **Checkout integration** | The release contract: the provider delivers a single-use credential, bound to merchant and amount, straight to the merchant's checkout, by `network_token` (to the merchant's acquirer or processor) or `vault_proxy` (into the merchant's payment API). A-CARD never handles the credential; it records the provider's release and charge references. A purchase fails closed if the provider's binding doesn't match. | Real delivery depends on the provider. For A-MERCHANT suppliers, each supplier will need a payment destination (processor id or payment endpoint) on their profile. |
| **Counsel's view** | Questions are in the outreach pack (page 3). | Not asked yet. |

**Lost phone (passkey recovery):**
1. *Second device (best):* add a passkey on a second device; remove the lost phone's passkey by signing with the other one. The lost passkey can't sign its own removal.
2. *No other device:* 10 one-time recovery codes come with the first passkey (shown once; only hashes are stored). A code **plus the account password** removes every passkey, so the lost phone can't approve anything. Repeated wrong codes are throttled.
3. *Cooling-off:* for 24 hours after a recovery, approvals and raising limits are paused (lowering still works), in case the recovery wasn't the holder. Every passkey event is recorded and shown on the dashboard.
4. New codes need a passkey signature and replace the old ones.
Not built: email or SMS alerts on recovery (there's no email sender in the platform yet), and admin-assisted resets for organisations.

**Storage:** with `DATABASE_URL` set, cards, settings, purchases, passkeys and passkey challenges live in Postgres (`apps/api/src/attachedCards/postgres.ts`); the vault reference is encrypted at rest with `ACARD_ENCRYPTION_KEY`. Approval is single-winner in SQL (a purchase moves out of `awaiting_approval` in one conditional update) and a passkey challenge is taken with `DELETE ... RETURNING`, so both hold across several API instances. Tested in `apps/api/test/pg-attached-cards.test.ts`, including ten racing approvals from two instances and a restart. Without a database it falls back to memory and says so on startup.

Turn it on locally: `ACARD_ATTACHED_CARDS_PROVIDER=test DASHBOARD_URL=http://localhost:3000` on the API. Passkeys use `ACARD_PASSKEY_RP_ID` and `ACARD_PASSKEY_ORIGINS` (default: the dashboard URL's host and origin).

## What production needs

1. **Card storage done by someone certified.** Either Visa Intelligent Commerce and Mastercard Agent Pay network tokens (agent-scoped tokens with step-up authentication; requires approval as an enabler), or a PCI-certified vault provider that holds the card and releases it per approved purchase. A-CARD should never store card numbers itself.
2. **Real passkey approval** (WebAuthn) on the holder's device, not a button.
3. **Checkout integration**: how the stand-in reaches the merchant (network token at the merchant's processor, or a vault proxy into the merchant's payment API). Browser autofill is the weakest option.
4. **Counsel's view** on card-data handling and POPIA. Likely simpler than issuing, because A-CARD holds no funds, but not yet checked.
