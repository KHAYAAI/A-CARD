# A-CARD — AWS Deployment Runbook

_Last updated: 2026-08-18_

Step-by-step guide to deploying A-CARD to AWS. Pairs with
[`LAUNCH_PLAN.md`](./LAUNCH_PLAN.md) (strategy) and
[`../infra/cdk/README.md`](../infra/cdk/README.md) (stack reference).

The stack: one VPC (public + private + isolated subnets, two NAT Gateways —
one per AZ), one Multi-AZ RDS Postgres, one Application Load Balancer with a
WAF, and three Fargate services (`api`, `mcp`, `dashboard`) sharing the ALB by
path, each scaling out on CPU utilization. CloudTrail and GuardDuty watch the
account; ALB access logs and WAF's full request log both land in S3. The API
runs the multi-writer Postgres store at a floor of 2 tasks.

```
Internet ──► WAF ──► ALB (public subnets) ──► /v1/*, /webhooks/*  → api  (private)
                                          ├─► /mcp*               → mcp  (private)
                                          └─► /* (default)        → dashboard (private)
                                                                     │
                                                        RDS Postgres (isolated subnets)
```

---

## 0. Prerequisites

- **AWS account** with admin (or sufficient) credentials, configured locally
  (`aws configure` or `AWS_PROFILE`).
- **Node 20+** and **npm**.
- **Docker running locally** — CDK builds and pushes the three images at deploy.
- **(For TLS)** a domain and a **Route 53 hosted zone** for it.

Verify:

```bash
aws sts get-caller-identity      # confirms credentials
docker info                      # confirms Docker is up
node -v                          # >= 20
```

---

## 1. One-time bootstrap

```bash
cd infra/cdk
npm install
npx cdk bootstrap aws://<ACCOUNT_ID>/<REGION>   # e.g. af-south-1 (Cape Town)
```

`af-south-1` is the default (ZAR-first, low latency to SA issuers). Override
with `CDK_DEFAULT_REGION`.

---

## 2. Generate and store secrets

Generate the issuer webhook secret and **save it** — the sandbox simulator and
any real issuer both sign webhooks with it:

```bash
openssl rand -hex 32
```

The stack takes these as CloudFormation parameters (all `noEcho`) and stores
each in AWS Secrets Manager. RDS credentials and the assembled `DATABASE_URL`
are generated and stored automatically — you never handle them.

| Parameter | Required | What it is |
|---|---|---|
| `IssuerWebhookSecret` | ✅ | HMAC secret for `/webhooks/issuer`. |
| `StripeSecretKey` | — | `sk_live_…` / `sk_test_…` for USD subscription billing. Blank ⇒ unmetered. |
| `StripeWebhookSecret` | — | Stripe webhook signing secret from Developers → Webhooks. |
| `SlackApprovalsWebhookUrl` | — | Slack incoming webhook. Blank ⇒ no push. |
| `WorkOsApiKey` | — | `sk_...` from your WorkOS dashboard. Blank ⇒ no SSO (password + TOTP MFA login is unaffected either way). |
| `WorkOsClientId` | — | `client_...` from the same dashboard page. Must be set alongside `WorkOsApiKey` or SSO stays off. |
| `PayFastMerchantId` / `PayFastMerchantKey` / `PayFastPassphrase` | — | From your PayFast dashboard's Integration settings. Blank ⇒ `/v1/wallet/fund` keeps its instant sandbox credit. Set all three ⇒ real ZAR wallet funding via PayFast checkout + ITN, and instant funding is disabled. |
| `PayFastSandbox` | — | `"true"` to use `sandbox.payfast.co.za` instead of the live host. Defaults to `"false"`. |

A real card issuer (Sudo Africa or similar) is **not yet a deployable
parameter** — see §6 below. It exists in code (`Card.issuerCardId`, the
webhook's dual-lookup path) but the exact request/response wire format is
unverified against Sudo's actual API, so it isn't wired into this stack the
way Stripe/PayFast/WorkOS are. Wiring it is a small, contained change once you
have their sandbox docs, not a rebuild.

---

## 3. Deploy

### 3a. Plain HTTP (developer sandbox / first look)

```bash
cd infra/cdk
npx cdk deploy --parameters IssuerWebhookSecret="$(openssl rand -hex 32)"
```

### 3b. With TLS + a custom domain (recommended for anything public)

Provide your domain and its hosted zone via `-c` context (all three required):

```bash
npx cdk deploy \
  --parameters IssuerWebhookSecret="<the-secret-you-saved>" \
  --parameters StripeSecretKey="sk_live_..." \
  --parameters StripeWebhookSecret="whsec_..." \
  --parameters SlackApprovalsWebhookUrl="https://hooks.slack.com/services/..." \
  -c domain=app.example.com \
  -c hostedZoneId=Z0123456789ABCDEFGHIJ \
  -c hostedZoneName=example.com
```

This provisions an ACM certificate (DNS-validated against the zone), an
HTTPS:443 listener, an HTTP:80→HTTPS redirect, a Route 53 alias record, and
sets `NODE_ENV=production` (which makes session cookies `Secure`).

First deploy takes **10–15 minutes** (mostly RDS). Later code deploys are a few
minutes — CDK only rebuilds the images that changed.

Preview any change first with `npx cdk diff`.

---

## 4. What you get (stack outputs)

At the end of deploy, CDK prints:

- **DashboardUrl** — open it, register or paste an API key, you're in.
- **ApiUrl** — same origin, routed by path (`/v1/*`, `/webhooks/*`).
- **McpUrl** — `<ApiUrl>/mcp`; add as a remote MCP server with
  `Authorization: Bearer <api key>`.
- **PublicOrigin** — the canonical `https://<domain>` (or the ALB URL without
  a domain).

---

## 5. Post-deploy smoke test

Replace `$ORIGIN` with the `PublicOrigin` output.

```bash
ORIGIN=https://app.example.com

# 1. Register the first owner (also creates the org + wallet + a session)
TOKEN=$(curl -s -X POST $ORIGIN/v1/auth/register -H 'content-type: application/json' \
  -d '{"email":"you@example.com","name":"You","password":"a-strong-password"}' \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['session_token'])")

# 2. Fund the wallet (R1000.00 = 100000 cents), create a card
curl -s -X POST $ORIGIN/v1/wallet/fund -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"amount":100000}'
CARD=$(curl -s -X POST $ORIGIN/v1/cards -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"single_use":true}' \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['card']['id'])")

# 3. Simulate a purchase through the real authorization path
curl -s -X POST $ORIGIN/v1/simulate/purchase -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d "{\"card_id\":\"$CARD\",\"amount\":25000,\"currency\":\"ZAR\",\"merchant\":{\"name\":\"Checkers Sixty60\",\"category\":\"5411\"}}"
```

Expect `approved: true` and a wallet `posted` of `75000`. Confirm health at
`$ORIGIN/health`.

---

## 6. Connecting integrations

### Stripe (USD subscription billing)
Dashboard → Developers → Webhooks → Add endpoint. Set the endpoint URL to
`$ORIGIN/webhooks/stripe`, listening for `checkout.session.completed`. The
signing secret it gives you goes in the `StripeWebhookSecret` parameter, and
your secret key in `StripeSecretKey` (redeploy to apply). Pricing itself
(`free`/`basic`/`pro`/`enterprise` — $0/$8/$28/$2,800 per month) lives in
`packages/core/src/billing.ts`, independent of what currency an account's
wallets are actually denominated in.

### Slack (approval notifications)
Create an Incoming Webhook in your Slack workspace; put the URL in
`SlackApprovalsWebhookUrl` (redeploy).

### WorkOS (enterprise SSO)
Additive to password + TOTP MFA login — never a replacement. In your WorkOS
dashboard, grab the API key and Client ID, set the redirect URI to
`$ORIGIN/v1/auth/sso/callback` (kept under `/v1/` deliberately — see
`apps/api/src/app.ts` — so the ALB's existing `/v1/*` rule routes it to the
API service; a bare `/auth/...` path would silently miss it). Set
`WorkOsApiKey` / `WorkOsClientId` and redeploy. An org owner then calls
`POST /v1/sso/setup` from the dashboard's Team tab to get a self-serve WorkOS
Admin Portal link for their own IT team — no code or A-CARD login on their end.

### PayFast (real ZAR wallet funding)
Dashboard → Settings → Integration. Set the notify (ITN) URL to
`$ORIGIN/webhooks/payfast`. Set `PayFastMerchantId`, `PayFastMerchantKey`,
and `PayFastPassphrase` (redeploy to apply) — once all three are set,
`POST /v1/wallet/fund` (the instant sandbox credit) returns `409` and
`POST /v1/wallet/fund/checkout` takes over: it returns a signed field set
for the dashboard to submit as a form POST to PayFast, and the wallet is
only credited when PayFast's ITN passes signature + source-host +
server-confirm validation (all three, not just the signature — see
`apps/api/src/payfast.ts`). Test against `PayFastSandbox=true` before
flipping it off.

### A real card issuer (Phase 3)
The webhook contract is issuer-agnostic (`POST /webhooks/issuer`, HMAC
signed) and a card can already be resolved by either our internal id or the
issuer's own reference (`Card.issuerCardId`) — see `apps/api/src/sudo.ts` for
the current, **unverified** client shape. Point the issuer's authorization
webhook at `$ORIGIN/webhooks/issuer`, set `IssuerWebhookSecret` to the shared
secret they give you, and confirm their exact request/response field names
against their sandbox docs before wiring `AppConfig.sudo` into
`apps/api/src/index.ts` (it deliberately isn't wired yet).

### MCP (remote)
```json
{
  "mcpServers": {
    "acard": {
      "url": "https://app.example.com/mcp",
      "headers": { "Authorization": "Bearer ak_live_..." }
    }
  }
}
```

---

## 7. Operations

### Updating
Change code, `npx cdk deploy` again. It diffs and touches only what changed.

### Logs
CloudWatch Logs groups per service (`api`, `mcp`, `dashboard`), 2-week
retention. Container Insights is on for the ECS cluster.

### Scaling
The API is safe to scale horizontally (per-wallet row locks). Raise
`desiredCount` on `ApiService`, or add autoscaling, in
`infra/cdk/lib/acard-stack.ts`.

### Database
Private, isolated subnets. `storageEncrypted`, 7-day automated backups,
deletion protection, `SNAPSHOT` on removal. To connect for debugging, use a
bastion or SSM port-forward into the VPC (RDS is not publicly reachable).

### Persistence modes
Default is the multi-writer Postgres store. Set `ACARD_PERSISTENCE=snapshot`
(env on the API task) to fall back to the single-writer JSONB snapshot model —
only for a single instance.

---

## 8. Cost estimate (hardened baseline, af-south-1, monthly)

Rough order of magnitude — verify with the AWS pricing calculator. This is
the **hardened** baseline (§ below) — Multi-AZ RDS, two NAT Gateways,
autoscaling, CloudTrail, GuardDuty, and durable WAF/ALB logging are all on by
default in this stack, not an opt-in add-on.

| Item | Approx. USD/mo |
|---|---|
| 3–12 × Fargate (0.25 vCPU / 0.5 GB) at rest, scaling out under load | ~$45–90+ |
| RDS `db.t4g.micro`, Multi-AZ, 20 GB, 7-day backups | ~$36–50 |
| Application Load Balancer | ~$18–22 |
| NAT Gateways (2, one per AZ) + data processing | ~$66+ |
| WAF (WebACL + 4 rules + requests) | ~$8–15 |
| WAF/ALB access log pipeline (S3 + Kinesis Firehose) | ~$5–15 |
| CloudTrail (S3 storage for management events) | ~$1–3 |
| GuardDuty (usage-based, scales with log volume) | ~$10–30 |
| Secrets Manager, CloudWatch, Route 53 | ~$5–10 |
| **Total** | **~$195–330+/mo at rest, more under real load** |

To trim pre-revenue and accept the MVP tradeoffs instead: drop `natGateways`
back to `1`, remove `multiAz: true`, and pull the `autoScaleTaskCount(...)`
calls back to fixed `desiredCount`s in `infra/cdk/lib/acard-stack.ts` — that
reverts to the ~$130–200/mo MVP baseline this stack shipped with before this
hardening pass. Do not cut WAF or TLS for anything handling real money.

---

## 9. Tearing down

```bash
cd infra/cdk
# RDS has deletion protection; disable it first:
aws rds modify-db-instance --db-instance-identifier <id> --no-deletion-protection --apply-immediately
npx cdk destroy
```

RDS leaves a final snapshot behind (deliberate — the one resource you don't
want deleted by accident). The `AccessLogsBucket` (ALB + WAF logs) is set to
`RemovalPolicy.RETAIN` for the same reason — `cdk destroy` leaves it in place;
delete it by hand once you've confirmed you don't need those logs.

**GuardDuty note:** only one detector is allowed per AWS account per region.
If this stack's `cdk deploy` fails on `GuardDutyDetector` because one already
exists (enabled another way — Organizations, the console, another stack),
either remove the `guardduty.CfnDetector` block from
`infra/cdk/lib/acard-stack.ts` and rely on the existing detector, or import it
into this stack (`cdk import`) instead of letting CDK try to create a second one.

---

## 10. Security notes

- Secrets are in AWS Secrets Manager and injected as container secrets — never
  baked into images or logged.
- RDS is unreachable from the internet; only the tasks' security group can
  reach Postgres.
- WAF fronts the ALB: AWS managed CommonRuleSet + KnownBadInputs, a per-IP
  flood limit (2000/5min across the whole ALB), and a **tighter, separately
  evaluated** rule scoped to `/v1/auth/login` (20/5min per IP) — see
  `LoginRateLimit` in `infra/cdk/lib/acard-stack.ts`.
- A login also has a **per-account** lockout (5 failed attempts / 15 min,
  shared across every API instance via a Postgres table) — this is what
  catches an attacker rotating IPs, which the WAF's IP-keyed rule can't.
- Passwords are scrypt-hashed; session tokens, API key secrets, and MFA
  recovery codes are all stored only as SHA-256 hashes; the issuer and Stripe
  webhooks are HMAC-verified with replay protection (Stripe's is additionally
  timestamp-bound, a 5-minute tolerance against a replayed payload); PayFast's
  ITN goes further still — signature, source-host resolution, and a
  server-to-server confirm-back to PayFast itself, all three required.
- Human login supports TOTP MFA (enrolled per-user from the dashboard) and,
  optionally, WorkOS SSO — both additive to the base password flow, never a
  replacement for it.
- API keys are scoped: `read_only` maps onto the `viewer` role (refused by
  the same `requireRole` gate every write route already has), and a key can
  carry a cumulative spend cap on the card budget it's allowed to provision.
- CloudTrail records every AWS API call against this account (multi-region,
  all management events, log-file integrity validation); GuardDuty analyzes
  account activity for known threat patterns. Both are account/region-level
  AWS services, not application code — see §11.
- Full WAF request logs and ALB access logs both land in the `AccessLogsBucket`
  (encrypted, TLS-only bucket policy, 180-day lifecycle) — WAF via a Kinesis
  Data Firehose delivery stream (`aws-waf-logs-acard`; WAF cannot write to S3
  directly), ALB directly. Previously only sampled requests reached CloudWatch
  metrics; nothing captured the full stream anywhere durable.
- RDS runs Multi-AZ — a synchronously replicated standby RDS fails over to
  automatically on an AZ outage, without a manual restore.
- Two NAT Gateways (one per AZ) — a single NAT going down no longer takes
  outbound connectivity with it for every task scheduled in that AZ.
- **Still worth doing before real cardholder money at meaningful scale:** a
  process to actually review CloudTrail/GuardDuty findings (turning them on
  is not the same as someone watching them), and a published security contact.

---

## 11. What changed in the hardening pass

Everything in this section used to be the documented "not yet" list. It now
ships by default in `infra/cdk/lib/acard-stack.ts`:

| Item | What it does | Where |
|---|---|---|
| **CloudTrail** | Records every AWS API call against the account | `new cloudtrail.Trail(this, "Trail")` |
| **GuardDuty** | Automated threat detection over VPC/DNS/CloudTrail activity | `new guardduty.CfnDetector(...)` — one per account/region, see §9's note |
| **Second NAT Gateway** | Removes the single-AZ outbound-connectivity failure point | `natGateways: 2` on the VPC |
| **Autoscaling** | API/MCP/dashboard scale out on CPU utilization instead of a fixed task count | `service.autoScaleTaskCount(...).scaleOnCpuUtilization(...)` on all three services |
| **Durable WAF/ALB logs** | Full request logs (not just sampled metrics) land in S3 | `AccessLogsBucket` + `alb.logAccessLogs(...)` + a Firehose delivery stream + `wafv2.CfnLoggingConfiguration` |
| **Multi-AZ RDS** | Automatic failover to a synchronous standby on an AZ outage | `multiAz: true` on the `DatabaseInstance` |

**Time to apply:** about 1–1.5 days of engineering (this pass), most of it on
the WAF/ALB logging pipeline — Kinesis Firehose is the fiddliest part, and its
delivery stream name is required by AWS to start with `aws-waf-logs-` or WAF
refuses it as a logging destination. The other five are each under an hour of
code, plus normal `cdk deploy` time (RDS's Multi-AZ conversion and NAT
Gateway creation can each take 15–30+ minutes on top of the usual deploy).

**Incremental cost:** roughly +$70–115/mo over the previous MVP baseline — see
the updated §8 cost table.
