# Roadmap to live money and launch

Written 24 November 2026. Owner column: **You** (founders), **Counsel**, **Partner**, **Build** (engineering). Dates are targets; the licence route sets the real pace.

## Phase 0: this week (sandbox launch)
| # | Step | Owner |
|---|---|---|
| 0.1 | Deploy API + dashboard on Fly; run `scripts/check-deploy.sh`; set `ACARD_OPERATOR_TOKEN` | You |
| 0.2 | Fix AWS keys; run `kms-smoke.ts` | You |
| 0.3 | Base Sepolia transfer with `testnet-smoke.ts` | You |
| 0.4 | Mailboxes: support@, privacy@, security@a-card.cc | You |
| 0.5 | Fill legal placeholders (reg no, Information Officer); register the Information Officer | You |
| 0.6 | Merge to main so the uptime check runs; publish Terms/Privacy/PAIA on a-card.cc | You / Build |

## Phase 1: weeks 1–4 (contracts and counsel)
| # | Step | Owner |
|---|---|---|
| 1.1 | Instruct SA counsel with `docs/legal/COUNSEL_BRIEF.md`; ask first: can we launch under VALR's licence? | You / Counsel |
| 1.2 | VALR: commercial terms, API access, KYC sharing, who holds customer funds | You / Partner |
| 1.3 | Basis Theory: contract, AOC, sandbox keys | You / Partner |
| 1.4 | Card issuer / BIN sponsor talks (Investec, Ukheshe, Paymentology) | You / Partner |
| 1.5 | Get 3 security-audit quotes; book a slot ~week 10 | You |
| 1.6 | Sign 3–5 sandbox pilot platforms (paid) | You |
| 1.7 | Basis Theory adapter: hosted card form, tokens, proxy release | Build |

## Phase 2: weeks 4–10 (build the live rails)
| # | Step | Owner |
|---|---|---|
| 2.1 | VALR adapter: ZAR ⇄ USDC quotes, conversions, deposits, withdrawals | Build |
| 2.2 | Issuer adapter (real virtual cards, real-time authorisation webhook) | Build |
| 2.3 | Live KYC/KYB through Didit's live app; confirm wallet screening enabled live | Build / You |
| 2.4 | Segregated customer-funds account and daily reconciliation (ledger vs bank vs VALR) | Build / Partner |
| 2.5 | Transactional emails (branded), status page, support inbox | Build |
| 2.6 | Code freeze for audit | Build |

## Phase 3: weeks 10–16 (assurance)
| # | Step | Owner |
|---|---|---|
| 3.1 | Security audit + penetration test; fix findings; retest | Auditor / Build |
| 3.2 | Counsel signs off Terms, Privacy, DPA, Agent Authority, card data; licence route confirmed in writing | Counsel |
| 3.3 | PCI scope confirmed (SAQ A expected); sign Basis Theory and issuer agreements | Counsel / Partner |
| 3.4 | Restore drill; incident drill; on-call rota live | You / Build |

## Phase 4: weeks 16–20 (controlled live launch)
| # | Step | Owner |
|---|---|---|
| 4.1 | Turn on mainnet gate: KMS signing, screening, Travel Rule, audit/licence/ramp references | Build |
| 4.2 | Live with 3–5 pilot platforms only; low limits (e.g. R1,000/transaction, R5,000/day) | You |
| 4.3 | Watch daily: reconciliation, declines, fraud, support; weekly review | You |
| 4.4 | Raise limits and open to more platforms after 30 clean days | You |

## Phase 5: after launch
Own licence application (FSCA CASP or partner arrangement long-term); SOC 2 Type 1; UAE entity and VARA/ADGM route; seed round on live traction.

## Gates (don't pass without)
- **Before any real money:** licence route in writing, signed partner contracts, audit findings fixed, counsel sign-off.
- **Before raising limits:** 30 days of clean reconciliation and no open SEV1/SEV2.
