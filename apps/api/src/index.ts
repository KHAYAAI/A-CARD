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
const slackWebhookUrl = process.env.SLACK_APPROVALS_WEBHOOK_URL;

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
