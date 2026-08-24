import { serve } from "@hono/node-server";
import { Platform } from "@acard/core";
import { createApp } from "./app.js";
import { PostgresPersistence } from "./persistence.js";
import { InMemoryPlatformService, PostgresPlatformService, type PlatformService } from "./service/index.js";
import { attachSlackNotifications } from "./notifications.js";

const port = Number(process.env.PORT ?? 8787);
const issuerWebhookSecret = process.env.ISSUER_WEBHOOK_SECRET ?? "whsec_sandbox_secret";
const databaseUrl = process.env.DATABASE_URL;
const dashboardUrl = process.env.DASHBOARD_URL;
const paystackSecretKey = process.env.PAYSTACK_SECRET_KEY;
const paystackWebhookSecret = process.env.PAYSTACK_WEBHOOK_SECRET;
const payfastMerchantId = process.env.PAYFAST_MERCHANT_ID;
const payfastMerchantKey = process.env.PAYFAST_MERCHANT_KEY;
const payfastPassphrase = process.env.PAYFAST_PASSPHRASE;
const payfastSandbox = process.env.PAYFAST_SANDBOX === "true";
const slackWebhookUrl = process.env.SLACK_APPROVALS_WEBHOOK_URL;
const workosApiKey = process.env.WORKOS_API_KEY;
const workosClientId = process.env.WORKOS_CLIENT_ID;

/**
 * Persistence modes:
 *   - no DATABASE_URL            → in-memory (ephemeral; sandbox/local dev)
 *   - DATABASE_URL (default)     → Postgres multi-writer store (row-level ledger,
 *                                  per-wallet row locks) — safe to run several API
 *                                  tasks against one database
 *   - DATABASE_URL + ACARD_PERSISTENCE=snapshot
 *                                → in-memory + single-writer JSONB snapshot
 *                                  (the earlier model; correct only at one instance)
 */
let platform: PlatformService;
let onMutation: (() => void) | undefined;
let onClose: (() => Promise<void>) | undefined;

if (!databaseUrl) {
  platform = new InMemoryPlatformService(new Platform());
  console.log("A-CARD API: no DATABASE_URL set — state is in-memory only and will not survive a restart");
} else if (process.env.ACARD_PERSISTENCE === "snapshot") {
  const persistence = new PostgresPersistence(databaseUrl);
  await persistence.migrate();
  const loaded = await persistence.load();
  platform = new InMemoryPlatformService(loaded);
  onMutation = () => persistence.save(loaded);
  onClose = () => persistence.close();
  console.log("A-CARD API: single-writer snapshot persistence (ACARD_PERSISTENCE=snapshot)");
} else {
  const pg = new PostgresPlatformService(databaseUrl);
  await pg.migrate();
  platform = pg;
  onClose = () => pg.close();
  console.log("A-CARD API: Postgres multi-writer store (row-level ledger with per-wallet locks)");
}

if (slackWebhookUrl) attachSlackNotifications(platform, slackWebhookUrl, dashboardUrl);

const app = createApp({
  platform,
  issuerWebhookSecret,
  dashboardUrl,
  onMutation,
  paystack:
    paystackSecretKey && paystackWebhookSecret
      ? { secretKey: paystackSecretKey, webhookSecret: paystackWebhookSecret }
      : undefined,
  // Real ZAR wallet funding. Omit to keep /v1/wallet/fund's instant sandbox
  // credit; set to switch to PayFast checkout + ITN-confirmed settlement.
  payfast:
    payfastMerchantId && payfastMerchantKey && payfastPassphrase
      ? { merchantId: payfastMerchantId, merchantKey: payfastMerchantKey, passphrase: payfastPassphrase, sandbox: payfastSandbox }
      : undefined,
  // SSO is purely additive to password + MFA login — omit these three and the
  // deployment runs exactly as before, no code path changes. The callback
  // lives on this API service (see infra/cdk: the ALB only routes /v1/* here),
  // so the redirect URI is this same public origin, not the dashboard app.
  workos:
    workosApiKey && workosClientId && dashboardUrl
      ? { apiKey: workosApiKey, clientId: workosClientId, redirectUri: `${dashboardUrl.replace(/\/$/, "")}/v1/auth/sso/callback` }
      : undefined,
});

const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`A-CARD API listening on http://localhost:${info.port}`);
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, async () => {
    console.log(`A-CARD API: received ${signal}, flushing state and shutting down`);
    await onClose?.();
    server.close(() => process.exit(0));
  });
}
