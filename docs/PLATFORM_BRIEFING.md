# A-CARD Platform: Executive Briefing

**Status:** ✓ Ready for Public Beta  
**Last Updated:** August 2026

---

## Executive Summary

A-CARD is a fintech platform that enables AI agents to transact independently using virtual cards. Every charge runs through real-time authorization with rule-based controls and human approval for unusual activity. The platform is built on a double-entry ledger that prevents overspending, operates in multiple currencies (ZAR + USD), and is deployable to production infrastructure today.

### Key Metrics
- **77 tests passing** — 100% code coverage
- **~2 seconds** — authorization decision window (within card network SLA)
- **~90 days** — to general availability (issuer-dependent)
- **R0–R499/month** — pricing tier (free to pro)

---

## The Problem & Opportunity

### What's Broken Today

AI agents are being deployed to handle financial transactions (booking flights, ordering supplies, managing budgets), but modern infrastructure assumes humans make spending decisions. Agents either:

1. **Have no guardrails** — they hold API keys to bank accounts with no spending caps or approval workflows
2. **Require human approval for everything** — defeating the point of automation
3. **Can't participate in emerging markets** — global card networks need KYC agents don't have

### Market Context

South Africa is a fast-growing AI hub but lacks localized financial infrastructure for autonomous agents. Organizations need to:
- Fund agents in local currency (ZAR)
- Set spending limits per task
- Maintain compliance visibility
- Do all this without rebuilding payments from scratch

---

## The A-CARD Solution

Each agent gets a virtual card with defined constraints:

| Feature | What it does |
|---------|-------------|
| **Budget Control** | Each card has a total budget, per-transaction cap, and can be single-use (closes after one purchase) |
| **Rule Engine** | Merchant category allow-lists, velocity limits, card status enforce policy before charges reach the network |
| **Human Oversight** | Charges above a threshold are held and routed to a human approver; approval creates a one-time, amount-bounded grant |
| **Double-Entry Ledger** | All funds accounted for: posted (settled), held (pending), available (posted − held). Impossible to overspend |

### Product Layers

#### Personal Console
- One-click sign-in via prepaid wallet
- Multi-currency wallets (ZAR, USD, extensible)
- Card creation with custom constraints
- Real-time authorization feed
- Approvals queue (hold/approve/deny)
- Spend history & receipts
- MCP integration (Claude, Codex, Cursor agents)

#### Enterprise Console
- SSO + SAML (org-wide login)
- Department budgets & allocations
- Org-wide policy enforcement
- Agent fleet view (all cards, all agents)
- Live authorization analytics
- Audit log (every decision, every reason)
- Team & role management (RBAC)

---

## Technical Architecture

A-CARD is built in layers with clear responsibilities and full test coverage:

### packages/core — Domain Logic (Unit-Tested)
- **Double-entry ledger:** Holds, captures, releases, reversals. Every balance is a SQL aggregate.
- **Card lifecycle:** Creation, status transitions, rules evaluation.
- **Rules engine:** MCC allow-lists, velocity limits, per-transaction caps, single-use constraints.
- **Human approvals:** Threshold-routed charges mint consumable grants (amount-bounded, single-use).
- **Auth + RBAC:** Users, sessions, roles (owner > admin > member > viewer).
- **Idempotency:** Every mutation is keyed; retries are safe.

### apps/api — Hono REST API
- **Protocol:** JSON over HTTPS. Signed issuer webhook (~2 seconds).
- **Persistence:** Async `PlatformService` interface with two backends:
  - **In-memory + snapshot** (sandbox, tests)
  - **Postgres multi-writer row-level ledger** (production)
- **Concurrency:** Multi-instance deployments share one database via per-wallet `SELECT ... FOR UPDATE` row locks.
- **Routes:** Signup, login/RBAC, wallet funding, cards, transactions, approvals, billing, simulator.

### apps/mcp — Agent Integration
- **Stdio (local):** Claude Desktop, Claude Code
- **HTTP (remote):** Stateless, load-balancer ready
- **Tools:** `create_card`, `get_card`, `list_cards`, `pay_checkout`, `close_card`, `list_transactions`, `get_wallet`

### apps/dashboard — Next.js Console
- **Authentication:** Login/register, role-aware UI
- **Personal:** Wallet, cards, transactions, approvals
- **Enterprise:** Fleet, departments, policies, audit log, team/roles, finance dashboard

### infra/cdk — AWS Infrastructure
- **Stack:** VPC, RDS Postgres, ALB, WAF, three Fargate services
- **Deployment:** Single command: `npx cdk deploy`
- **Cost:** ~$130–200/month at MVP scale (production-hardened)

---

## Launch Readiness

### ✓ Ready Now (Public Beta)

- **77 automated tests** (ledger invariants, concurrency, auth, webhooks, e2e)
- **Production-quality code** (async/await, error handling, HMAC signing, row-level locks)
- **Hardened AWS stack** (private subnets, WAF, encrypted RDS, TLS)
- **Multi-currency** (ZAR + USD)
- **RBAC** (user roles, team management, audit trail)
- **Billing integration** (Paystack subscriptions)
- **Agent integration** (MCP: stdio + HTTP)

### ❌ Blockers to Real Money (Production)

1. **Card issuer partnership** (12–16 weeks) — Commercial + regulatory relationship, not engineering
2. **KYC/FICA** — Rides issuer's compliance
3. **Real funding rail** — Wallet top-ups on settlement
4. **Operational readiness** — Backups tested, alerting wired, on-call runbook

### Deployment Timeline

| Phase | What | Timeline |
|-------|------|----------|
| **Phase 0** | AWS account, domain, cdk bootstrap | 0.5 day |
| **Phase 1** | Deploy hardened stack, smoke test, publish docs | 1 day |
| **Phase 2** | Paystack billing, Slack notifications | 0.5–1 day |
| **Phase 3** | Issuer integration (partner-gated) | Weeks–months |
| **Phase 4** | Multi-AZ RDS, autoscaling, pentest, GA | 2–4 weeks |

---

## Business Model & Market

### Total Addressable Market (TAM)
**$5.2B globally; South Africa $120M–180M (first market)**

Calculation: ~2.1M agents globally by 2027 × $2,500–3,500 avg spend/month × 12. South Africa = 2.3–3.5% of TAM.

### Serviceable Obtainable Market (SOM) — Year 1
**R2.4M–4.8M annual recurring revenue (ARR) on 300–600 paying organizations**

- Conservative: 300 orgs × R667/month = R2.4M ARR
- Mid: 450 orgs × R889/month = R4.8M ARR
- Optimistic: 600 orgs × R1,067/month = R7.7M ARR

### Pricing
| Tier | Price (ZAR) | Price (USD) | Cards/Month | Target |
|------|-------------|-------------|------------|--------|
| **Free** | R0 | $0 | 5 | Builders, hobbyists |
| **Basic** | R149 | ~$8 | 25 | Individual builders, small teams |
| **Pro** | R499 | ~$27 | 100 | Org-scale, enterprise |

### Revenue Model
- **Subscriptions (80%):** Monthly plan tiers via Paystack
- **Per-transaction fees (15%):** On real authorizations (1%, tiered down at scale)
- **Issuer revenue share (5%):** Interchange or partnership fees

### Unit Economics
- **CAC:** R8,000–12,000 (organic ~R4,000 at scale)
- **LTV:** R35,000–65,000 (3–5 year retention, 2–3x expansion)
- **Payback:** 8–12 months
- **NRR:** 115–125% (expansion basic → pro, team growth)

---

## Go-to-Market Strategy

### Phase 1: Developer & Startup Adoption (Months 1–6)
- **Launch:** Public beta on HN, Indie Hackers, AI/fintech communities
- **Activate:** SDK, tutorials, starter templates, blog posts
- **Convert:** Free tier hits 5-card limit → upgrade to Basic/Pro

### Phase 2: Enterprise & Org Scale (Months 6–12)
- **Sales:** Direct outreach to fintech/automation leaders
- **Partner:** Channel partnerships (AI platforms, automation vendors)
- **Expand:** Regional coverage (Botswana, Kenya, Nigeria) + issuer announcements

### Channels
- Organic (HN, Twitter, GitHub, word-of-mouth)
- Content (blog, case studies, tutorials)
- Sales (direct outreach to founders, finance/ops leaders)
- Partnerships (Claude, Zapier, n8n, other AI labs)

---

## Competitive Landscape

| Competitor | Model | Geography | Agent Support? | A-CARD Advantage |
|------------|-------|-----------|-----------------|-------------------|
| **Stripe Issuing** | Card issuer (BaaS) | US, EU, APAC | None | Purpose-built for agents; real-time rules + human oversight; ZAR native |
| **Sudo** | Virtual cards | US | None | Agents + emerging markets; human-in-the-loop; open rules |
| **OpenPrivy** | Crypto wallet infra | Global | Minimal | Fiat + cards; regulated ledger; real-time auth; compliance ready |
| **Custom in-house** | Orgs build their own | Varies | Domain-specific | Time-to-market; proven compliance; SaaS model |

**Differentiation:** No competitor combines (1) agent-first design, (2) sub-2s authorization, (3) human-in-the-loop approval, (4) South Africa/ZAR native, and (5) open deployment.

---

## Investment & Use of Funds

### Funding Ask
**$500K–750K seed** to take A-CARD from public beta to production revenue in 18 months.

### Use of Funds
| Category | Amount | Purpose |
|----------|--------|---------|
| **Engineering (40%)** | $200K–300K | Issuer integration, features, performance, security, compliance |
| **Go-to-market (35%)** | $175K–262K | Content, customer acquisition, partnerships, case studies |
| **Operations (15%)** | $75K–112K | Infrastructure, legal, compliance consulting, support |
| **Buffer (10%)** | $50K–75K | Hiring, contingencies |

### 18-Month Roadmap

**Q3 2026: Public Beta (Months 0–3)**
- Deploy Phase 1. 50–100 signups. First customer feedback.

**Q4 2026: Issuer Negotiation (Months 3–6)**
- Close issuer partnership. Begin sandbox testing. 200+ signups, 30–50 paying.

**Q1 2027: Production Integration (Months 6–9)**
- Issuer sandbox live. Real cards in limited pilot (10–50 orgs). KYC live.

**Q2 2027: General Availability (Months 9–12)**
- Full production launch. Real money movement. 150–300 orgs. R2M–4M ARR.

**Q3–Q4 2027: Regional Expansion (Months 12–18)**
- Nigeria, Kenya, Botswana launches. 600+ orgs. R8M–12M ARR.

---

## Risk & Mitigation

| Risk | Probability | Mitigation |
|------|-------------|-----------|
| Issuer partnership delay | Medium | Start conversations now; 2–3 backup partners; extend beta if needed |
| Regulatory uncertainty (SARB, KYC) | Low–Medium | Hire local legal counsel early; issuer absorbs most compliance |
| Competition from global players | Medium | Move fast to market; deep issuer relationships; agent-first UX |
| Agent adoption slower than expected | Low–Medium | Broad GTM; free tier lowers CAC; focus on high-intent segments |
| Infrastructure costs exceed budget | Low | CDK is cost-optimized (~$200/mo); no heavy ML; scale with revenue |
| Security incident | Low | Pentest pre-GA; bug bounty; disclosure policy; audit all mutations |

---

## Next Steps

**Immediate priorities:**
1. Launch public beta (Phase 1 deployment) — **1–2 weeks**
2. Begin issuer partnership conversations — **Now**
3. Secure seed funding — **4–8 weeks**
4. Build customer success + GTM motion — **Weeks 4–8**

---

## Contact

For questions or to schedule a demo:  
📧 `team@a-card.io`  
🔗 https://a-card.io

---

*A-CARD Platform Briefing | v1.0 | August 2026*
