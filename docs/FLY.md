# Deploying the full platform to Fly

Three apps plus a database: `acard-api`, `acard-app` (dashboard), `acard-sandbox` (optional), and Fly Postgres. Run everything from the repo root, on branch `claude/forge-agent-wallet`. Names below are examples: if one is taken, pick another and use it everywhere.

## 1. Database
```bash
fly postgres create --name acard-db --region jnb
fly apps create acard-api
fly postgres attach acard-db --app acard-api      # sets DATABASE_URL on the API
```

## 2. API secrets (never commit these)
```bash
fly secrets set --app acard-api \
  ISSUER_WEBHOOK_SECRET=$(openssl rand -hex 32) \
  ACARD_ENCRYPTION_KEY=$(openssl rand -hex 32) \
  DASHBOARD_URL=https://acard-app.fly.dev \
  ACARD_ATTACHED_CARDS_PROVIDER=test \
  ACARD_ENABLE_AFP=true \
  ACARD_SELF_SERVE_STORES=true
```
- Keep `ACARD_ENCRYPTION_KEY` safe and never change it: stored vault references can't be read without it.
- Passkeys use the dashboard's host automatically (`acard-app.fly.dev`). On a custom domain, also set `ACARD_PASSKEY_RP_ID` and `ACARD_PASSKEY_ORIGINS`.
- `ACARD_ATTACHED_CARDS_PROVIDER=test` is refused when `NODE_ENV=production` (the Docker image sets it). Leave it out until a real vault adapter exists, or the API won't start. Without it, "Your cards" and passkeys show as not enabled.
- Optional: `PAYFAST_*` (billing and funding), `WORKOS_*` (merchant portal, SSO), `ACARD_ENABLE_COMPLIANCE=true` + `DIDIT_*` (verification).

## 3. Deploy the API
```bash
fly deploy --config apps/api/fly.toml --dockerfile apps/api/Dockerfile .
curl https://acard-api.fly.dev/health          # {"ok":true,...}
```

## 4. Deploy the dashboard
```bash
fly apps create acard-app
fly deploy --config apps/dashboard/fly.toml --dockerfile apps/dashboard/Dockerfile \
  --build-arg NEXT_PUBLIC_ACARD_API_URL=https://acard-api.fly.dev .
```
Open https://acard-app.fly.dev, create an account, and check Home, Wallet, Agents & keys, Orders.

## 5. Sandbox (optional)
```bash
fly deploy --config apps/sandbox/fly.toml --dockerfile apps/sandbox/Dockerfile .
```

## Checks and fixes
- Logs: `fly logs --app acard-api`. On startup the API prints which features are on and whether data is on Postgres.
- "app not found": run `fly apps create <name>` first.
- Dashboard can't reach the API: the build-arg URL is wrong; redeploy the dashboard with the right one.
- Keep one API machine until you've load-tested; Postgres makes more safe, but start simple.

This is a sandbox deployment: test money only. Nothing here moves real money (see `docs/LAUNCH_PLAN.md` §8).
