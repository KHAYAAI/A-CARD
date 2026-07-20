# A-CARD — AWS Deployment Runbook

_Last updated: 2026-07-20_

Step-by-step guide to deploying A-CARD to AWS. Pairs with
[`LAUNCH_PLAN.md`](./LAUNCH_PLAN.md) (strategy) and
[`../infra/cdk/README.md`](../infra/cdk/README.md) (stack reference).

The stack: one VPC (public + private + isolated subnets, one NAT Gateway),
one RDS Postgres, one Application Load Balancer with a WAF, and three Fargate
services (`api`, `mcp`, `dashboard`) sharing the ALB by path. The API runs the
multi-writer Postgres store at `desiredCount: 2`.

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
| `PaystackSecretKey` | — | `sk_live_…` / `sk_test_…`. Blank ⇒ unmetered. |
| `PaystackWebhookSecret` | — | Paystack webhook signing secret. |
| `SlackApprovalsWebhookUrl` | — | Slack incoming webhook. Blank ⇒ no push. |

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
  --parameters PaystackSecretKey="sk_live_..." \
  --parameters PaystackWebhookSecret="whsec_..." \
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

### Paystack (billing)
Dashboard → Settings → API Keys & Webhooks. Set the webhook URL to
`$ORIGIN/webhooks/paystack`. The signing secret goes in the
`PaystackWebhookSecret` parameter (redeploy to apply).

### Slack (approval notifications)
Create an Incoming Webhook in your Slack workspace; put the URL in
`SlackApprovalsWebhookUrl` (redeploy).

### A real card issuer (Phase 3)
Point the issuer's authorization webhook at `$ORIGIN/webhooks/issuer` and set
`IssuerWebhookSecret` to the shared secret they give you (or that you give
them). The webhook contract is issuer-agnostic; only the timestamp/signature
scheme and field mapping may need a small adapter.

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

## 8. Cost estimate (MVP, af-south-1, monthly)

Rough order of magnitude — verify with the AWS pricing calculator.

| Item | Approx. USD/mo |
|---|---|
| 3 × Fargate (0.25 vCPU / 0.5 GB), API×2 + mcp + dashboard | ~$45–70 |
| RDS `db.t4g.micro`, 20 GB, 7-day backups | ~$18–25 |
| Application Load Balancer | ~$18–22 |
| NAT Gateway (1) + data processing | ~$33+ |
| WAF (WebACL + 3 rules + requests) | ~$8–15 |
| Secrets Manager, CloudWatch, Route 53 | ~$5–10 |
| **Total** | **~$130–200/mo** |

To trim pre-revenue: drop API to `desiredCount: 1`, or (only for a throwaway
sandbox) run without NAT. Do not cut NAT/WAF/TLS for anything handling real
money.

---

## 9. Tearing down

```bash
cd infra/cdk
# RDS has deletion protection; disable it first:
aws rds modify-db-instance --db-instance-identifier <id> --no-deletion-protection --apply-immediately
npx cdk destroy
```

RDS leaves a final snapshot behind (deliberate — the one resource you don't
want deleted by accident).

---

## 10. Security notes

- Secrets are in AWS Secrets Manager and injected as container secrets — never
  baked into images or logged.
- RDS is unreachable from the internet; only the tasks' security group can
  reach Postgres.
- WAF fronts the ALB (AWS managed CommonRuleSet + KnownBadInputs + a per-IP
  rate limit).
- Passwords are scrypt-hashed; session tokens are stored only as SHA-256
  hashes; the issuer and Paystack webhooks are HMAC-verified with replay
  protection.
- Before real cardholder money: enable CloudTrail + GuardDuty, ship WAF/ALB
  logs somewhere queryable, and publish a security contact.
