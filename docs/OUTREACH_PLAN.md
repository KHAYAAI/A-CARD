# Partner outreach plan (issuer, counsel, Investec pilot)

_Created 2026-11-12. Decisions made: start with Paymentology, Union54 and Investec; approach counsel alongside the issuer calls, not after._

Nothing in this plan has been done yet. Every step marked **You** needs you: sending messages, taking calls and signing are outside what this repo or I can do. Supporting material is in `marketing/one-pagers/`: `A-CARD-partner-outreach-pack.pdf` (issuer shortlist and questions, legal brief and questions) and `outreach-drafts.md` (three drafts, not sent).

## Sequence

| When | Who | Step | Material | Goal |
|---|---|---|---|---|
| Day 1 | You | Send the **counsel** enquiry to two or three fintech firms | Draft 3, then the legal brief (page 2 of the pack) | Book scoping calls and get fee estimates. Counsel's answers shape every issuer call |
| Day 1 | You | Send the **Paymentology** (with Bank Zero) message | Draft 1, issuer page (page 1) | A first call this week or next |
| Day 1 | You | Send the **Union54** message | Draft 1 | Understand whether they are a faster route to a sponsor, or just another way to the same one |
| Day 1 | You | Send the **Investec** message | Draft 2 | Written answers on external calls, data protection and hook limits. Do not start the pilot until you have them |
| Days 2 to 5 | You | Enable Programmable Banking on your Investec account; create API credentials in Investec's portal | Pilot-day checklist in `docs/integrations/investec-pilot.md` | Be ready to run the simulator. Keep credentials out of chat and the repo |
| Week 1 to 2 | You | Issuer calls (30 minutes each) | Question list on page 1 of the pack | Fill the comparison table below. Do not agree to anything yet |
| Week 1 to 2 | You | Counsel scoping calls | Page 2 of the pack | Choose one firm; agree phase-one scope and fee |
| Week 2 to 3 | You | Run the Investec pilot in simulator, then one small real purchase | Runbook test plan | Prove the decision layer on real traffic and measure real latency |
| Week 3 to 6 | You | Second calls with the leading one or two issuers; ask for pricing and a draft term sheet | Same list | Decision gate (below) |

## What I can do in parallel (ask and I'll start)

- Deploy-ready sandbox for demos: the manual Fly steps, or a hardened AWS plan.
- Operational readiness: alerting, on-call runbook, tested backup restore, security contact and disclosure page.
- Penetration-test scoping: a written brief and the list of surfaces to include.
- An issuer adapter, once an issuer sends API documentation. The webhook contract is already issuer-agnostic.
- Update the unit-economics sheet with each issuer's real quote as soon as you have one.

## Comparison table to fill during the calls

| | Paymentology + Bank Zero | Union54 | Investec (pilot only) |
|---|---|---|---|
| Sponsor bank and BIN owner | | | Investec (own account) |
| Who holds customer funds | | | You (own account) |
| Non-bank programme allowed? | | | No (own cards only) |
| Real-time authorisation: time limit and failure behaviour | | | About 2 s, timeout declines |
| One-time cards per task by API; per-card cost | | | n/a |
| Per-transaction cost and interchange share | | | n/a |
| ZAR and USD | | | |
| KYC/KYB: accept our provider? | | | n/a |
| Fraud and dispute losses: who carries | | | |
| Sandbox and time to pilot | | | Simulator now |
| Agent-payment credentials (Mastercard Agent Pay, Visa IC) | | | |
| Red flags | | | |

## Decision gate (about week 4 to 6)

Pick one issuer to go deeper with only if **all** of these hold:
1. A written explanation of who is licensed, who holds funds, and which of our activities need our own authorisation, **confirmed by our counsel**.
2. Real-time decisioning through a webhook inside a stated time limit.
3. Pricing that leaves positive contribution per order on the unit-economics sheet at realistic order sizes.
4. A sandbox and a realistic pilot date.
5. No requirement we can't meet today (for example certifications we don't have). If one appears, write down what it would cost to meet.

Stop and reconsider if an issuer won't put the funds-holding and licence position in writing, or if counsel says the structure needs a licence we can't get.

## Rules while talking to anyone

- Say what A-CARD is today: **a working sandbox on test money, not live.** Don't say live, certified, or licensed.
- Don't promise integration dates before an issuer's API documentation exists.
- Keep credentials, customer data and anything private out of emails and attachments.
- Keep a short log of who said what, with dates. Written answers beat verbal ones.
