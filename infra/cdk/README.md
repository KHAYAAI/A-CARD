# A-CARD on AWS

One VPC, one Postgres instance, one Application Load Balancer, three Fargate services (`api`, `mcp`, `dashboard`) sharing it by path. Hardened for a real (if small) deployment: the ALB sits in public subnets, the Fargate tasks in private-with-egress subnets, and RDS in isolated subnets — a single NAT Gateway gives the tasks outbound access without exposing them. A WAFv2 WebACL (AWS managed rule sets + a rate limit) fronts the ALB, and TLS with a custom domain is one flag away. The API runs the Postgres multi-writer store, so it's deployed at `desiredCount: 2`.

## Prerequisites

- AWS account + credentials configured (`aws configure` or `AWS_PROFILE`)
- Docker running locally (CDK builds and pushes the three images during deploy)
- Node 20+
- `cdk bootstrap` run once per account/region (see below)

## First-time setup

```bash
cd infra/cdk
npm install
npx cdk bootstrap aws://<ACCOUNT_ID>/<REGION>   # e.g. af-south-1 for Cape Town
```

## Deploy

```bash
npx cdk deploy \
  --parameters IssuerWebhookSecret="$(openssl rand -hex 32)" \
  --parameters StripeSecretKey="sk_live_..." \
  --parameters StripeWebhookSecret="whsec_..." \
  --parameters SlackApprovalsWebhookUrl="https://hooks.slack.com/services/..."
```

Only `IssuerWebhookSecret` is required — the Stripe, PayFast, WorkOS, and Slack parameters all default to empty, which just runs the platform unmetered/without real wallet funding/without SSO/without approval push notifications. Save whatever you pass for `IssuerWebhookSecret`; it's also what the sandbox purchase simulator and any real issuer integration need to sign webhooks with.

Deploy takes 10–15 minutes the first time (mostly RDS). Subsequent deploys of code changes are a few minutes — CDK only rebuilds/pushes the Docker images that changed.

### With TLS and a custom domain

Pass your domain and its Route53 hosted zone via `-c` context; all three are required to turn TLS on:

```bash
npx cdk deploy \
  --parameters IssuerWebhookSecret="$(openssl rand -hex 32)" \
  -c domain=app.acard.co.za \
  -c hostedZoneId=Z0123456789ABCDEFGHIJ \
  -c hostedZoneName=acard.co.za
```

This provisions an ACM certificate (DNS-validated against the zone), an HTTPS:443 listener, an HTTP:80 → HTTPS redirect, and a Route53 alias record pointing at the ALB. `NODE_ENV=production` also flips session cookies to `Secure`. Leave the context flags off and the stack serves plain HTTP on `:80` — fine for a first look, not for real cardholder money.

## What you get

The `CfnOutput`s at the end of deploy give you:

- **DashboardUrl** — open this, paste an API key (get one via `POST /v1/signup`), you're in
- **ApiUrl** — same host, routed by path (`/v1/*`, `/webhooks/*`)
- **McpUrl** — `<ApiUrl>/mcp`, add this as a remote MCP server with `Authorization: Bearer <api key>`

All three share one ALB DNS name — the dashboard's frontend calls are same-origin, so nothing needs to know the ALB's address ahead of time.

## Region

Defaults to `af-south-1` (Cape Town) — the natural home region given the ZAR-first target market, and it keeps latency to South African issuers/cardholders low. Override with `CDK_DEFAULT_REGION`.

## Updating

Change code, `npx cdk deploy` again — it diffs against the deployed stack and only touches what changed. Use `npx cdk diff` first if you want to preview.

## Tearing down

```bash
npx cdk destroy
```

The database has `deletionProtection: true` and a `SNAPSHOT` removal policy — you'll need to disable deletion protection on the RDS instance in the console (or via `aws rds modify-db-instance --no-deletion-protection`) before `destroy` can remove it, and it leaves a final snapshot behind either way. This is deliberate: it's the one resource in this stack you really don't want deleted by accident.

## What's hardened here

- **Network isolation** — ALB in public subnets, Fargate tasks in private-with-egress subnets, RDS in isolated subnets; only the ALB is reachable from the internet, and only the tasks' security group can reach Postgres.
- **TLS** — ACM certificate + HTTPS listener + HTTP→HTTPS redirect when a domain is configured (see above).
- **WAF** — `AWSManagedRulesCommonRuleSet` + `AWSManagedRulesKnownBadInputsRuleSet` + a 2000-req/5-min per-IP rate limit, associated with the ALB.
- **Multi-writer data** — the API uses the Postgres row-level ledger with per-wallet locks, so it runs at `desiredCount: 2` (no single-writer bottleneck).
- **RDS** — private, `storageEncrypted`, 7-day backups, deletion protection, `SNAPSHOT` on removal.

## Still worth doing before real cardholder money

- Turn on **CloudTrail** and **GuardDuty** for the account, and ship the WAF/ALB logs somewhere queryable.
- Add a second NAT Gateway (one per AZ) if you need NAT to survive an AZ outage — the default single NAT trades that for cost.
- Rotate the RDS credential secret on a schedule, and consider RDS Multi-AZ once uptime matters.
- Get the issuing/compliance (KYC/FICA) relationship in place — that's the actual gate to processing real payments, not infrastructure.
