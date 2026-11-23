# Who can close the remaining blockers

A starting list from public information, as of late 2026. Verify each before contact: licences, products and regions change. We contact them; nothing here has been contacted. Questions to ask are in `docs/OUTREACH_PLAN.md` and `marketing/one-pagers/`.

## Licences (counsel)
**South Africa (FSCA crypto-asset provider (CASP) / FSP licence, SARB payments, FIC registration, POPIA)**
- Bowmans, Webber Wentzel, ENSafrica, Cliffe Dekker Hofmeyr, Werksmans: fintech and financial-regulation practices.
- Licence-application specialists: Novation Consulting, Moonstone Compliance (FSP and crypto applications, compliance officer services).

**UAE (VARA in Dubai, ADGM FSRA, DIFC DFSA, CBUAE for payments)**
- Al Tamimi & Company, Hadef & Partners, Clyde & Co, BSA Ahmad Bin Hezeem.
- Ask each: which regime fits an agent-wallet + card product, timeline, cost, and whether a free-zone sandbox (ADGM RegLab, DFSA Innovation Testing Licence, VARA) fits a pilot.

## Card issuer / BIN sponsor (real virtual cards)
- **South Africa:** Investec (programmable banking, already in our runbook), Ukheshe / EFT Corporation (issuing-as-a-service), Paymentology (issuer processor, works with sponsor banks), Standard Bank, Absa, Nedbank (corporate card / sponsor talks).
- **UAE / region:** NymCard (UAE issuing platform), Network International.
- **Ask:** virtual card API, per-card spend controls, real-time authorisation webhook (for our policy engine), MCC limits, minimums and fees.

## Rand on/off-ramp and customer-funds account
- **Crypto ramp (ZAR ⇄ USDC):** VALR, Luno, Ovex (OTC and API), Yellow Card (stablecoin payments API across Africa), AltCoinTrader.
- **UAE:** Rain, BitOasis.
- **Bank for customer funds (segregated / trust account):** Investec, Standard Bank, Sasfin. Ask about holding client money for a licensed CASP.

## Certified card vault / network tokens (attached cards)
- **PCI DSS Level 1 vaults:** Basis Theory, VGS (Very Good Security), Evervault, Skyflow.
- **Network tokens and checkout in SA:** Peach Payments, Paystack, Stitch, Adyen, Checkout.com (Visa Token Service / Mastercard MDES through them).
- **Ask:** proxy or token API we can call without seeing card numbers, passkey-gated release, network-token support, SA availability.

## Security audit and penetration test
- **Code and wallet audit:** Trail of Bits, Cure53, Zellic, Halborn, OpenZeppelin (smart-contract heavy; less relevant unless we deploy contracts).
- **Pen test (South Africa):** Orange Cyberdefense (SensePost), Telspace Systems.
- **Scope to send:** `apps/wallet-provider`, `packages/agent-wallet` (policy, signer, x402), `apps/api` auth, passkeys, attached cards, KMS signing, and the Fly deployment.

## Wallet screening and Travel Rule (Didit add-ons)
Checked on the A-CARD sandbox app, 2026-11-23:
- **Screening:** Merkle Science is built into Didit (no separate account). It worked on the sandbox app (demo result). To go live, check it is enabled on the live application, or bring your own key for Chainalysis, Elliptic, TRM Labs or Crystal (Didit adds US$0.02 per screen).
- **Travel Rule networks:** GTR, TRUST, VerifyVASP, Sygna Bridge (available, bring your own membership); Notabene, TRISA, CODE, Veriscope (on request). Membership needs a licence first.
