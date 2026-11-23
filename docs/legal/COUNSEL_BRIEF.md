# Counsel brief: A-CARD

Prepared [DATE] for [FIRM]. Draft documents are in this folder.

## 1. What A-CARD does
A-CARD lets a person or business give an AI agent (software acting on their instructions) a way to pay, within limits they set:
- **Virtual cards** issued per agent, with spending rules (amount, merchant, category, time). *Today: simulated issuer only.*
- **Attached cards:** the customer's own card, held by our certified vault partner, Basis Theory; A-CARD never sees the number. Each charge is approved by the customer with a passkey. *Today: test vault only, off in production.*
- **Agent wallets:** stablecoin (USDC) wallets on public blockchains, keys held in AWS KMS, destination wallets screened, Travel Rule details collected above a threshold. *Today: test networks only; mainnet is blocked in code.*
- **A-MERCHANT:** merchants list products agents can buy.
- **Funding and billing** via PayFast (subscriptions; funding is sandbox).

Company: Agent Card (Pty) Ltd, incorporated in [South Africa / UAE free zone]. Customers: [consumers / businesses / both] in [South Africa first, then UAE].

## 2. Personal information we process
| Category | Examples | Source | Why |
|---|---|---|---|
| Account | name, email, password hash, passkey public keys | customer | run the account |
| Identity (KYC/KYB) | ID document, selfie/liveness, company documents, sanctions/PEP results | customer via Didit | FICA, fraud |
| Financial | card last 4 + brand (never full number), wallet addresses, transactions, limits | customer, partners | provide the service |
| Agent activity | what the agent tried to buy, approvals, declines | platform | controls, disputes |
| Travel Rule | originator and beneficiary names, counterparty VASP | customer | FATF R16 / FIC |
| Technical | IP, device, logs | automatic | security |

Special personal information: **biometric** data (face liveness, processed by Didit). Children: not offered to under-18s.
Cross-border transfers: Basis Theory (US; card data only), VALR (South Africa), AWS (EU/af-south-1), Fly.io (servers in Johannesburg; company in the US), Didit (EU), Slack, GitHub, WorkOS (US).

## 3. Questions
**Licensing**
1. Which licences do we need for each product: FSCA crypto-asset service provider (CASP) under FAIS; SARB/PASA for payments; FIC accountable institution registration; NCR (if any credit)? Which apply in the sandbox phase with test money only?
2. Our chosen partners are **VALR** (ZAR ⇄ USDC ramp; FSCA-licensed CASP) and **Basis Theory** (card vault). Can we launch faster under VALR's licence (as a juristic representative, agent, or white label), and what must the contract contain?
3. UAE: which regime fits (VARA, ADGM FSRA, DIFC DFSA, CBUAE stored value), and is a sandbox/innovation licence suitable for a pilot?

**AI agents**
4. When an agent makes a purchase within the customer's rules, is it the customer's act in law (ECTA s25 attribution of data messages)? Is our `AGENT_AUTHORITY.md` mandate enough?
5. Who bears loss when an agent buys the wrong thing within limits, when it exceeds limits (our bug), and when it's manipulated by a third party (prompt injection)?
6. Consumer Protection Act and ECTA s43–44 (cooling-off, disclosures): how do they apply to agent-made purchases?

**Cards and card data**
7. Attached cards: the vault partner holds the card and releases it only after passkey approval. Does A-CARD fall in PCI DSS scope (SAQ A or none)? Card-scheme rules on storing credentials on file (merchant-initiated transactions) and on a third party initiating them?
8. Issued cards: what must be in the cardholder agreement, and who must issue it (us or the sponsor bank)?

**POPIA**
9. Are we responsible party, operator, or both (we're operator for merchants' customer data)? Confirm the DPA.
10. Biometric data via Didit: s26–27 prior-authorisation or consent route? Is Didit's consent screen enough?
11. Cross-border transfers (s72): are the providers' terms adequate, or do we need binding agreements?
12. Do we need prior authorisation from the Information Regulator (s57) for any processing (e.g. credit/fraud profiling, linking accounts)?
13. Retention: FICA requires 5 years after the relationship ends. Confirm this overrides deletion requests.

**Crypto**
14. Travel Rule threshold for ZAR (FIC Directive 9: R5,000?) and what we must record and pass on.
15. Self-custody vs custodial: our provider holds keys in KMS for the user. Is that custody under the CASP regime?
16. Tax: VAT on fees; any reporting duties (CARF/CRS) on crypto transactions.

**Contract**
17. Review the Terms, Privacy Policy, PAIA manual, DPA, AUP and Agent Authority docs.
18. Liability cap, governing law (South Africa), dispute route (Ombud for Financial Services Providers once licensed).

## 4. What we want back
A licence map with timelines and costs; a yes/no on the partner route; marked-up documents; a POPIA compliance checklist; and a list of what must change before real money.
