# A-CARD on AWS

One VPC, one Postgres instance, one Application Load Balancer, three Fargate services (`api`, `mcp`, `dashboard`) sharing it by path. Cost-conscious by design (no NAT Gateway) — see the tradeoffs noted at the top of `lib/acard-stack.ts`.

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
  --parameters PaystackSecretKey="sk_live_..." \
  --parameters PaystackWebhookSecret="whsec_..." \
  --parameters SlackApprovalsWebhookUrl="https://hooks.slack.com/services/..."
```

Only `IssuerWebhookSecret` is required — the Paystack and Slack parameters default to empty, which just runs the platform unmetered/without approval push notifications. Save whatever you pass for `IssuerWebhookSecret`; it's also what the sandbox purchase simulator and any real issuer integration need to sign webhooks with.

Deploy takes 10–15 minutes the first time (mostly RDS). Subsequent deploys of code changes are a few minutes — CDK only rebuilds/pushes the Docker images that changed.

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

## Before this handles real cardholder money

This stack is sized and networked for an MVP, not a regulated production card platform. Before real money flows through it:

- Move RDS and the Fargate tasks into private subnets behind a NAT Gateway or VPC endpoints (currently public subnets + security-group-only isolation, to avoid ~$32+/mo in NAT costs during the pre-revenue phase)
- Point a real domain at the ALB and put ACM/TLS in front of it (currently plain HTTP)
- Split the single-writer Postgres snapshot persistence (`apps/api/src/persistence.ts`) into real ledger tables if you need more than one API task
- Add WAF rules on the ALB, and CloudTrail/GuardDuty for the account
