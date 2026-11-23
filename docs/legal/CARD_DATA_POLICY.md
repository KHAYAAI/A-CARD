# Card Data Policy

**DRAFT.** Owner: [CTO]. Reviewed annually and after any change to card flows.

## 1. Rule
**A-CARD never receives, stores, processes or transmits full card numbers (PAN), security codes (CVV/CVC) or PINs.** This keeps A-CARD out of, or minimally in, PCI DSS scope. [⚖️ Counsel / QSA: confirm SAQ type; likely SAQ A.]

## 2. How cards are attached
1. The customer types card details into **Basis Theory's** hosted form (an iframe served by Basis Theory) inside our dashboard. The details go directly from the browser to Basis Theory.
2. Basis Theory returns a token reference. We store only: that reference (encrypted at field level), brand, last 4 digits, expiry month/year, and the customer's nickname for the card.
3. To pay, A-CARD asks Basis Theory to forward the card to the merchant or payment processor (Basis Theory proxy). The card is detokenised inside Basis Theory, never in our systems.
4. Each release requires the customer's passkey approval of that specific amount and merchant, unless the customer has set a rule allowing it without approval, within limits.

## 3. Technical controls (built)
- API middleware rejects any request body containing something that looks like a card number (Luhn check), returning `card_number_not_accepted`.
- The vault contract (`CardVaultProvider`) has no method that returns a card number.
- The test vault is refused when `NODE_ENV=production`.
- Logs never contain card data; reviewed in code review.

## 4. Issued cards
Virtual cards will be issued by a sponsor bank / issuer processor. Card numbers are shown to the customer through the issuer's secure display component; A-CARD's servers do not receive them. [Confirm with issuer.]

## 5. Responsibilities
- Basis Theory: PCI DSS Level 1 service provider. We keep its current Attestation of Compliance (AOC) on file and check it yearly.
- A-CARD: complete the applicable SAQ yearly; keep the hosted form unmodified; protect the page that hosts it (CSP, script integrity; PCI DSS v4 req. 6.4.3 and 11.6.1).
- Scheme rules on stored credentials: agreements with the customer for merchant-initiated or agent-initiated transactions are in the Agent Authority terms.

## 6. If card data shows up where it shouldn't
Treat as a SEV1 incident (`BREACH_RESPONSE.md`): remove it, find how it got there, notify Basis Theory and, if required, the card brands and acquirer.
