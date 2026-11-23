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

## What production needs (not built)

1. **Card storage done by someone certified.** Either Visa Intelligent Commerce and Mastercard Agent Pay network tokens (agent-scoped tokens with step-up authentication; requires approval as an enabler), or a PCI-certified vault provider that holds the card and releases it per approved purchase. A-CARD should never store card numbers itself.
2. **Real passkey approval** (WebAuthn) on the holder's device, not a button.
3. **Checkout integration**: how the stand-in reaches the merchant (network token at the merchant's processor, or a vault proxy into the merchant's payment API). Browser autofill is the weakest option.
4. **Counsel's view** on card-data handling and POPIA. Likely simpler than issuing, because A-CARD holds no funds, but not yet checked.
