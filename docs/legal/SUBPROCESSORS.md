# Subprocessors (operators)

**DRAFT.** Last updated 23 November 2026. We give 30 days' notice before adding one.

| Operator | Purpose | Data | Location |
|---|---|---|---|
| Basis Theory, Inc. | Card vault (PCI DSS Level 1) | full card details (A-CARD never receives them) | US [confirm region] |
| VALR (Pty) Ltd | ZAR ⇄ USDC conversion, on/off-ramp | identity, bank and wallet details, transactions | South Africa |
| Didit | Identity verification, liveness, AML, wallet screening | identity documents, biometrics, wallet addresses | EU (Spain) |
| Amazon Web Services | Key management (KMS), backups | wallet signing keys (never exported), encrypted backups | [eu-west-1 / af-south-1] |
| Fly.io | Application hosting and database | all platform data | South Africa (Johannesburg) region |
| PayFast (Network International) | Subscription billing | name, email, payment status | South Africa |
| WorkOS | Sign-in and SSO for business customers | name, email, organisation | US |
| Slack | Internal alerts | account identifiers, event summaries | US |
| GitHub | Source code, uptime checks | no customer data | US |
| [Card issuer] | Virtual card issuing | cardholder details, transactions | [TBC] |
