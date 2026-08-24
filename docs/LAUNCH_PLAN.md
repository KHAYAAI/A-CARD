# A-CARD — Launch Plan

_Last updated: 2026-07-20_

This document explains what A-CARD is, the current state of the engineering,
whether it can go public, the external dependencies required, and a phased
plan to get from "sandbox that runs on a laptop" to "processing real money for
paying customers."

The companion document [`DEPLOYMENT.md`](./DEPLOYMENT.md) is the step-by-step
AWS runbook.

---

## 1. What A-CARD is

A-CARD gives AI agents their own **virtual cards** — scoped, budget-capped,
often single-use — funded from a prepaid **ZAR wallet**, with a human able to
approve or decline anything unusual. It targets **South Africa first**, then
other emerging markets.

The product surface:

- **Prepaid wallet** per organization, denominated in a minor-unit currency
  (cents). Money never touches a float.
- **Cards** an agent creates over MCP or the REST API with constraints: total
  budget, per-transaction cap, merchant-category (MCC) allow-list, velocity
  limits, single-use, and an approval threshold.
- **Real-time authorization** — when a charge hits the issuer, the issuer
  calls A-CARD's signed webhook; A-CARD decides approve/decline inside the
  card network's ~2-second window.
- **Human-in-the-loop** — charges above a card's threshold are declined with
  `pending_human_approval` and routed to a person (dashboard + optional Slack
  ping). Approving mints a one-time, amount-bounded grant the retry consumes.
- **Double-entry ledger** — every top-up, hold, capture, and release is a
  balanced transaction. Available balance = posted − held, and a hold beyond
  available is refused atomically. An agent physically cannot overspend.

### How it's built

| Layer | What runs there |
|---|---|
| `packages/core` | Pure domain logic: ledger, card lifecycle, rules engine, approvals, API keys, **users/roles/sessions (RBAC)**, idempotency, HMAC webhook signing. No I/O; fully unit-tested. |
| `apps/api` | Hono REST API behind an async `PlatformService` port with two backends: in-memory (sandbox/snapshot) and a **Postgres multi-writer row-level ledger** with per-wallet `FOR UPDATE` locks. |
| `apps/mcp` | MCP server (stdio + Streamable HTTP) exposing card tools to agents; a pure adapter over the REST API. |
| `apps/dashboard` | Next.js console: login/register, role-aware wallet/cards/transactions, approval queue, team management. |
| `apps/cli` | `acard` CLI for terminal-native onboarding and ops. |
| `infra/cdk` | AWS CDK: VPC (public/private/isolated subnets + NAT), RDS Postgres, ALB, WAF, optional ACM/TLS, three Fargate services. |

### What was recently hardened

- **Multi-writer persistence** — the ledger is now real SQL tables with
  per-wallet row locks, so several API instances share one database without
  racing the overspend guard (integration-tested with concurrent
  authorizations).
- **Human auth + RBAC** — passwords (scrypt), server-side sessions, and roles
  (`owner > admin > member > viewer`) alongside the programmatic API key.
- **Deployment hardening** — private subnets, WAF, encrypted RDS, and one-flag
  TLS with a custom domain.
- **Production hardening pass** — Multi-AZ RDS, a second NAT Gateway (one per
  AZ), CPU-based autoscaling on all three Fargate services, CloudTrail,
  GuardDuty, and durable WAF/ALB request logging to S3 via Kinesis Firehose.
  See `docs/DEPLOYMENT.md` §11 for what changed and the incremental cost.

---

## 2. Is it ready to go public?

**As a product/engineering artifact: yes, for a controlled/beta launch.**
**As a live money-movement service: not until an issuing + compliance partner
is contracted.** These are two different bars.

### ✅ Ready now (can go public today)

- **Sandbox / developer preview.** The whole platform runs end-to-end with a
  mock issuer (deterministic `4242…` test cards). You can put the dashboard,
  API, and MCP server on a public AWS URL, let developers sign up, create
  cards, and simulate purchases. This is a legitimate public beta.
- The authorization engine, ledger, rules, approvals, webhooks, auth/RBAC, and
  billing are production-quality and tested (57 automated tests + a live
  multi-writer integration suite).
- The AWS stack is hardened (private networking, WAF, TLS, encrypted DB) and
  deploys with one command.

### ❌ Not ready to move real cardholder money (the true gate)

1. **No contracted card issuer.** A-CARD *decides* authorizations; it does not
   *issue* cards or move funds on Visa/Mastercard. That requires a
   BIN-sponsored issuing partner (Ukheshe/EFT Eclipse, Paymentology, Stripe
   Issuing, Sudo Africa, etc.). **This is a commercial + regulatory
   relationship, not an engineering task** — and it's the single blocker.
2. **Regulatory / compliance (South Africa).** Holding customer funds and
   issuing cards implicates SARB, the National Payment System Act, and
   FICA/KYC. In practice you ride the issuing partner's licences and compliance
   rails — but that must be contractually in place before real money flows.
3. **Real funding rail.** PayFast is wired (`apps/api/src/payfast.ts`) —
   `/v1/wallet/fund/checkout` + `/webhooks/payfast` credit the wallet only on
   PayFast's confirmed settlement, and instant top-ups are disabled the
   moment `PayFastMerchantId`/`PayFastMerchantKey`/`PayFastPassphrase` are
   set. What's left: run it against PayFast's real sandbox end-to-end and
   confirm live before switching `PayFastSandbox` off.
4. **Operational readiness.** Backups tested, alerting wired, an on-call
   runbook, and a disclosed security contact.

### Bottom line

Ship the **developer sandbox** publicly now. Start **issuer conversations** in
parallel. The day a partner signs, the integration is a single
signed-webhook contract that is already built — flip from mock issuer to real
issuer and you are live.

---

## 3. External dependencies

Grouped by when you need them.

### Needed to deploy the sandbox publicly (Phase 1)

| Dependency | Purpose | Where / how | Cost (approx.) |
|---|---|---|---|
| **AWS account** | Hosting (VPC, RDS, ALB, WAF, Fargate) | aws.amazon.com → create account, `aws configure` | ~$130–200/mo at MVP size (see DEPLOYMENT.md breakdown) |
| **Domain name** | Public URL / TLS | Any registrar; simplest in **Route 53** | ~$12/yr + $0.50/mo hosted zone |
| **Docker** (local) | CDK builds the three images at deploy | Docker Desktop / engine on the deploy machine | free |
| **Issuer webhook secret** | Signs the issuer→A-CARD webhook | `openssl rand -hex 32` (you generate it) | free |

### Needed for billing (Phase 2 — charging subscriptions)

| Dependency | Purpose | Where / how | Cost |
|---|---|---|---|
| **Paystack account** | ZAR subscription collection (`free`/`basic`/`pro`) | paystack.com → Settings → API Keys & Webhooks | ~2.9% + fees per charge |
| **Slack workspace** (optional) | Approval push notifications | Slack → Incoming Webhooks → copy URL | free |

### Needed to process real payments (Phase 3 — the real gate)

| Dependency | Purpose | Where / how | Cost |
|---|---|---|---|
| **Card issuing partner (BIN sponsor)** | Actually issues Visa/Mastercard, hosts PANs (keeps you out of PCI scope), provides the real authorization webhook | Ukheshe/EFT Eclipse, Paymentology, Sudo Africa, Bridgecard, Stitch, or Stripe Issuing — start a commercial conversation | Deal-dependent (setup + per-card + interchange share) |
| **KYC/FICA provider** | Identity verification of account holders | Usually via the issuing partner; standalone options: Smile ID, Onfido | Per-verification |
| **Compliance/legal counsel** | SARB / NPS Act / FICA posture, T&Cs | SA fintech counsel | Project fee |
| **Production funding rail** | Real wallet top-ups that settle | PayFast — wired, needs real-sandbox verification (see §3 above) | ~2.9-3.5%+ per transaction |

### Recommended operational add-ons

- ~~CloudTrail + GuardDuty~~ — shipped by default in `infra/cdk` now (see
  DEPLOYMENT.md §11). What's still missing: someone/something actually
  reviewing what they find.
- **Error/uptime monitoring** (Sentry, Better Stack, or CloudWatch alarms).
- **A security contact / disclosure address** (`security@yourdomain`).

---

## 4. Phased launch plan

### Phase 0 — Pre-flight (0.5 day)
- [ ] Create AWS account, configure credentials, pick region (`af-south-1`).
- [ ] Register domain + Route 53 hosted zone.
- [ ] `cdk bootstrap` the account/region.
- [ ] Generate and safely store the issuer webhook secret.

### Phase 1 — Public developer sandbox (1 day)
- [ ] Deploy the hardened stack **with TLS** (see DEPLOYMENT.md).
- [ ] Smoke-test: register an owner, fund, create a card, simulate a purchase,
      confirm RBAC (viewer can't write).
- [x] CloudTrail + GuardDuty deploy automatically with the stack now; still
      add a couple of CloudWatch alarms (5xx rate, RDS CPU) on top.
- [ ] Publish docs: how to sign up, create an API key, connect the MCP server.
- [ ] **Announce as a sandbox/preview.** Real cards are explicitly not live yet.

### Phase 2 — Billing + notifications (0.5–1 day)
- [ ] Create Paystack account; add `PaystackSecretKey` / `PaystackWebhookSecret`.
- [ ] Point Paystack's webhook at `https://<domain>/webhooks/paystack`.
- [ ] (Optional) Create a Slack incoming webhook; set
      `SlackApprovalsWebhookUrl`.
- [ ] Verify a test upgrade raises the card cap.

### Phase 3 — Issuer integration (partner-dependent, weeks–months)
- [ ] Sign an issuing partner; complete their onboarding/compliance.
- [ ] Map their authorization webhook to A-CARD's contract (timestamp +
      signature scheme + field names) — the only code change needed.
- [ ] Point the real issuer's webhook at `https://<domain>/webhooks/issuer`.
- [ ] Run their sandbox end-to-end, then a small live pilot.
- [ ] Replace sandbox top-ups with the real funding rail.

### Phase 4 — General availability
- [ ] Load/security review, penetration test.
- [x] Multi-AZ RDS, second NAT, autoscaling on the API/MCP/dashboard services
      — all in `infra/cdk/lib/acard-stack.ts` by default now, not a GA-time addition.
- [ ] Published SLAs, status page, support process.
- [ ] Public launch with real cards.

---

## 5. Go / no-go checklist for real money

Do **not** move real cardholder money until every box is ticked:

- [ ] Signed issuing partner + their compliance onboarding complete.
- [ ] KYC/FICA flow live for account holders.
- [ ] Legal sign-off on SARB / NPS Act / FICA and customer T&Cs.
- [ ] Real funding rail settling into wallets.
- [ ] TLS on a real domain; secrets in Secrets Manager (already wired).
- [x] RDS Multi-AZ (`multiAz: true`) — restore-from-backup still needs a test run, not just the config.
- [x] CloudTrail, GuardDuty, WAF logging — all deployed by default; still needs
      a process for someone to actually review the findings, and alerting/an
      on-call runbook on top.
- [ ] Incident response + security disclosure process published.

---

## 6. Known limitations (carried forward honestly)

- **Fraud ML** is not built — the rules engine carries hot-path decisions,
  which is the correct sequencing; ML scoring is a post-launch layer.
- **KYC/FICA** is intentionally not built in-house — it rides the issuing
  partner's compliance.
- The **snapshot persistence mode** remains for single-instance simplicity but
  the multi-writer Postgres store is the default and the path to scale.
- Turning on CloudTrail/GuardDuty/WAF logging is not the same as someone
  watching them — no alerting or on-call process sits on top of them yet.
