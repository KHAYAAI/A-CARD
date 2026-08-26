# A-CARD — Video Tutorial Series

Nine screen recordings covering the platform end to end, from `git clone` to an
AWS deploy. Every recording is **real footage of the actual product**: the
dashboard is the live Next.js app driven by a real browser, and every terminal
block replays a command that was genuinely executed against a running API, with
its genuine output.

There is no voiceover — the explanation is carried by on-screen captions, so the
videos work with sound off. This document is the written companion: what each
episode covers, and the points worth pausing on.

| # | Episode | Length | What it covers |
|---|---|---|---|
| 1 | `01-what-acard-is.mp4` | 1:52 | The problem, the four-part answer, the codebase layout, a tour of the live dashboard |
| 2 | `02-setup-and-first-run.mp4` | 1:29 | Prerequisites, install, the test suite, running the API, the three persistence modes |
| 3 | `03-wallet-and-first-card.mp4` | 2:50 | Signing up, funding a prepaid wallet, issuing a card, and every guardrail on it |
| 4 | `04-the-authorization-engine.mp4` | 2:25 | The ~2-second hot path, and four purchases — one approved, three refused |
| 5 | `05-human-approvals.mp4` | 2:37 | Holding a charge, the approval queue, one-time consumable grants |
| 6 | `06-team-roles-and-access.mp4` | 2:19 | Four roles, server-side enforcement, scoped API keys, MFA and lockout |
| 7 | `07-enterprise.mp4` | 2:07 | Departments and shared budgets, org policy, the real decision order, audit log |
| 8 | `08-connecting-an-agent.mp4` | 1:49 | MCP setup, the seven agent tools, and an honest look at what's still missing |
| 9 | `09-deploying-to-aws.mp4` | 2:43 | The CDK stack, bootstrap and deploy, hardening defaults, and the real launch gate |

**Total runtime: 20 minutes 10 seconds.** Watch in order — each one assumes the previous.

---

## Episode 1 — What A-CARD actually is

**The problem.** You want an agent to buy things, so you give it a card number.
That agent can now spend your entire limit, at any merchant, any number of
times. A hallucination, a prompt injection, or a retry loop becomes a financial
incident.

**The answer, in four parts:**

- **Prepaid wallet** — the agent spends a balance you topped up, never your
  credit line. It can only ever lose what you put in.
- **Per-card rules** — total budget, per-transaction cap, merchant-category
  allow-list, velocity limits, single-use.
- **Real-time refusal** — decided inside the card network's authorization
  window. Outside the rules means *declined at the network*, not refunded later.
- **Human-in-the-loop** — above a threshold you set, the charge is held and
  routed to a person before any money moves.

**How it's built:**

| Layer | Role |
|---|---|
| `packages/core` | Pure domain logic — ledger, card lifecycle, rules engine, approvals, RBAC. No I/O, fully unit-tested. |
| `apps/api` | Hono REST API. Two backends: in-memory sandbox, or Postgres with per-wallet row locks. |
| `apps/mcp` | MCP server — how an agent talks to the platform. A thin adapter over the REST API. |
| `apps/dashboard` | Next.js console for humans. |
| `infra/cdk` | AWS: VPC, Multi-AZ Postgres, ALB + WAF, three Fargate services, CloudTrail, GuardDuty. |

---

## Episode 2 — Setup and first run

**You need Node 20+ and npm.** That is genuinely the whole list. No database, no
AWS account, no card issuer, no payment provider. Leave `DATABASE_URL` unset and
the platform runs entirely in memory.

```bash
git clone https://github.com/KHAYAAI/A-CARD.git && cd A-CARD
npm install
npm test
npm run dev:api
```

**The test run is the point.** Those tests cover the places where a bug costs
real money: ledger invariants, the overspend guard under concurrency, webhook
signature verification, and every authorization decision path. If they pass, the
money-safety core is behaving.

**Three persistence modes:**

| Mode | Behaviour |
|---|---|
| No `DATABASE_URL` | In-memory. Ephemeral, resets on restart. Right for local dev. |
| `DATABASE_URL` set | Postgres multi-writer — row-level ledger with per-wallet `FOR UPDATE` locks. Several API instances share one database safely. **Production default.** |
| `+ ACARD_PERSISTENCE=snapshot` | In-memory plus a single-writer JSONB snapshot. Correct only at one instance. |

---

## Episode 3 — Your first wallet and card

Sign up (personal or enterprise), fund the wallet, issue a card.

**Money is always in minor units — cents.** Deliberately: there is no
floating-point money anywhere in the system. `250000` is R2,500.00.

**Every top-up is a balanced double-entry transaction**, not a number being
incremented. Available balance is `posted − held`, and a hold beyond available
is refused atomically.

The dashboard's create-card dialog is deliberately simple (name, currency). The
full rule set is set through the API — which is also how an agent creates its
own cards:

```bash
curl -X POST $API/v1/cards \
  -H "authorization: Bearer $TOKEN" \
  -d '{
    "label": "Grocery agent",
    "single_use": false,
    "limits": { "total": 50000, "per_transaction": 25000 },
    "allowed_merchant_categories": ["5411"],
    "approval_threshold": 20000
  }'
```

| Field | Effect |
|---|---|
| `total` | Lifetime cap. Once spent, the card is done regardless of wallet balance. |
| `per_transaction` | Caps any single charge — limits blast radius on one bad decision. |
| `allowed_merchant_categories` | MCC allow-list. `5411` is grocery stores; anything else is refused. |
| `approval_threshold` | At or above this, a human decides before money moves. |
| `single_use` | `true` closes the card after one successful capture. |
| `velocity` | Caps spend inside a rolling window, e.g. R100/hour. |

---

## Episode 4 — The authorization engine

The most important episode. When a merchant charges the card, the network gives
you roughly two seconds to answer.

```
Merchant charges the card
  ↓
Issuer calls POST /webhooks/issuer  (HMAC-signed)
  ↓
A-CARD resolves the card — by our id, or the issuer's own reference
  ↓
Org policy → card rules → approval threshold → department budget
  ↓
approve + place a ledger hold    or    decline with a reason
```

Four purchases on one card (`total` R500, `per_transaction` R250, MCC `5411`
only, `approval_threshold` R200):

| Purchase | Result | Why |
|---|---|---|
| R80 at Checkers · 5411 | `approved` | Inside every limit, correct category, under threshold. |
| R50 at Steam · 5816 | `merchant_category_not_allowed` | Well under budget — refused anyway. The card is scoped to groceries. |
| R300 at Checkers · 5411 | `per_transaction_limit_exceeded` | Right category, money available — breaches the R250 per-charge cap. |
| R220 at Makro · 5411 | `pending_human_approval` | Nothing is wrong with it. It's above R200, so a person decides. |

**Why this is refusal, not reporting.** Most spend controls are *detective* —
they tell you afterwards and you chase a refund. These four decisions happened
inside the authorization window. The declined charges were never funded; there
is nothing to claw back. An agent stuck in a retry loop hits the same wall every
time.

---

## Episode 5 — Human-in-the-loop approvals

Set a card's cap too low and the agent is useless; too high and one bad decision
is expensive. `approval_threshold` is the third option.

Following the money through the full sequence:

```
Funded                                          R1,000.00
Approved  — Checkers, R80                        − R80.00
Declined  — Steam, wrong category                   R0.00
Declined  — R300, over per-charge cap                R0.00
Held      — Makro, R220, awaiting a human            R0.00
Approved by a human, retried                    − R220.00
                                                ───────────
Final balance                                     R700.00
```

Three refusals cost exactly nothing.

**Approval mints a one-time, amount-bounded grant** — good for that merchant,
that amount, once. The obvious implementation would be to raise the card's
limit and let the retry through, but that leaves the card permanently more
powerful than you intended. You approved *one purchase*, not a new spending
level. The next charge over the threshold stops here too.

---

## Episode 6 — Team, roles and access

Four strictly ranked roles: `owner > admin > member > viewer`.

| Role | Can |
|---|---|
| `owner` | Everything, including billing and ownership transfer. |
| `admin` | Manage the team, set org policy, approve spend, start a subscription checkout. |
| `member` | Fund the wallet, create cards, spend. The day-to-day operating role. |
| `viewer` | Read-only. Cannot create, fund, spend, or approve. |

**Hiding a button is not security.** A viewer doesn't see *Create card*, but
that's a courtesy. Every write route is gated by `requireRole` on the server — a
viewer calling the API directly with their own token gets `403`.

**API keys carry the same model**, plus two extra limits:

- `scope: read_only` maps onto the viewer role — right for a reporting agent
  that must never spend.
- `spendCapCents` is a cumulative ceiling on the *card budget* that key may
  provision. Even a full-access key can't quietly issue R1,000,000 of cards.

**Protecting the human login:** TOTP MFA (a wrong code consumes the challenge,
so it can't be brute-forced), single-use hashed recovery codes, a per-account
lockout of 5 failed attempts / 15 minutes shared across every API instance via
Postgres, and a separate WAF rule scoped to `/v1/auth/login` at the edge.
WorkOS SSO is optional and purely additive — it never replaces password + MFA.

---

## Episode 7 — Enterprise: departments, policy, audit

Personal accounts are flat. Enterprise adds a layer **above the cards** —
controls that apply to every card whether or not the card asked for them.

**Departments** carry a monthly budget shared by every agent inside them. Two
agents in Procurement draw from the *same pool*, not one budget each. Once it's
exhausted, every card in that department declines — which forces a conversation
with finance rather than silent overspend.

**Org policy** has two absolute controls:
- `blocked_merchant_categories` — refused org-wide, *even for a card that
  explicitly allows them*.
- `approval_threshold` — routes to a human regardless of what the card permits.

**The real decision order** in `Platform.authorize` — any one can stop the charge:

1. **Org blocked category** — checked before the card is even consulted.
2. **The card's own rules** — budget, per-transaction cap, MCC list, velocity.
3. **Org approval threshold** — applies even when the card set none.
4. **Department budget** — the shared monthly pool.

**Audit log** records every decision with its reason and which layer made it.
That's what finance and compliance actually need: not just outcomes, but *why*.

> **Personal:** wallet → card rules → approve or decline
> **Enterprise:** wallet → org policy → card rules → org threshold → department budget

---

## Episode 8 — Connecting a real AI agent

One command:

```bash
claude mcp add --transport http acard \
  http://localhost:8787/mcp \
  --header "Authorization: Bearer ak_live_…"
```

Seven tools, defined in `apps/mcp/src/server.ts`: `create_card`, `get_card`,
`list_cards`, `pay_checkout`, `close_card`, `list_transactions`, `get_wallet`.

**There is no "agent mode".** Every MCP tool is a thin call into the same REST
API the dashboard uses — same auth, same roles, same rules engine, same ledger.
An agent gets no privileged path and no relaxed limits.

### ⚠️ An honest limitation

In the sandbox, `pay_checkout` calls the **purchase simulator** — it plays the
role of the issuer's authorization callback. It does not open a real merchant's
checkout page.

A-CARD is the **control plane**: it decides whether a charge is allowed, however
the card was presented. Getting real card credentials in front of a real
merchant is a separate problem — browser automation, a per-merchant API
integration, or an emerging agent-payment protocol. **That layer is not built
here**, and a contracted card issuer is still required before any of this
touches real money.

---

## Episode 9 — Deploying to AWS

```
Internet ──▶ WAF ──▶ ALB (public subnets)
                      ├─▶ /v1/*, /webhooks/*  → api  (private, ×2–6)
                      ├─▶ /mcp*               → mcp  (private)
                      └─▶ /*                  → dashboard (private)
                                │
                      RDS Postgres, Multi-AZ (isolated subnets)
```

Only the load balancer has a public route in; the database is unreachable from
the internet. `cdk synth` produces **98 resources across 38 types**.

```bash
cd infra/cdk && npm install
npx cdk bootstrap aws://<ACCOUNT_ID>/af-south-1
npx cdk deploy \
  --parameters IssuerWebhookSecret="$(openssl rand -hex 32)" \
  --parameters PayFastMerchantId="..." \
  --parameters PayFastMerchantKey="..." \
  --parameters PayFastPassphrase="..." \
  -c domain=app.yourdomain.com \
  -c hostedZoneId=Z0123456789ABCDEFGHIJ \
  -c hostedZoneName=yourdomain.com
```

All parameters are `noEcho`, stored in Secrets Manager, injected as container
secrets — never baked into an image or a log line. RDS credentials and the
assembled `DATABASE_URL` are generated automatically.

**On by default**, not a checklist for later: Multi-AZ RDS, two NAT gateways
(one per AZ), CPU autoscaling on all three services, WAF with a login-scoped
rate limit, CloudTrail, GuardDuty, and durable WAF/ALB request logs to encrypted
S3. Roughly **$195–330/month** at rest in `af-south-1`.

Turning those on is not the same as someone watching them — alerting and an
on-call runbook are still yours to add.

### Two different bars

- **Public developer sandbox: ready.** Deploy it, put it on a real domain, let
  people sign up and simulate purchases. That's a legitimate public beta.
- **Real cardholder money: not yet.** A-CARD decides authorizations; it does not
  issue cards on Visa or Mastercard. That needs a contracted, BIN-sponsored
  issuing partner — a commercial and regulatory relationship, not an engineering
  task. The integration point is already built and tested; the day a partner
  signs, it's a wiring job.

---

## Reproducing these recordings

The recordings are produced by driving the real dashboard with Playwright and
replaying genuinely-executed commands. Nothing is mocked or re-enacted.

```bash
# terminal 1 — the API, in-memory
PORT=8787 DASHBOARD_URL=http://localhost:3000 npx tsx apps/api/src/index.ts

# terminal 2 — the dashboard
cd apps/dashboard && NEXT_PUBLIC_ACARD_API_URL=http://localhost:8787 npx next dev -p 3000
```

Then run the capture step (which executes each command for real and records its
actual stdout) followed by the episode scripts. See `tutorials/production/`.

## Format note

Recordings are **H.264 / MP4 at 1280×720**, encoded at CRF 20 with
`+faststart` so they begin playing before the whole file has downloaded. That
plays everywhere without conversion — browsers, QuickTime, VLC, Slack, Google
Drive, Notion, PowerPoint, Keynote, and every major NLE.

Playwright captures VP8/WebM natively; `finalize.sh` transcodes to MP4, which is
both more portable and roughly half the size (47 MB → 22 MB across the series).
The raw WebM takes are kept out of git by `.gitignore`.
