import { serve } from "@hono/node-server";
import { Platform } from "@acard/core";
import { createApp } from "./app.js";
import { PostgresPersistence } from "./persistence.js";
import { attachSlackNotifications } from "./notifications.js";

const port = Number(process.env.PORT ?? 8787);
const issuerWebhookSecret = process.env.ISSUER_WEBHOOK_SECRET ?? "whsec_sandbox_secret";
const databaseUrl = process.env.DATABASE_URL;
const dashboardUrl = process.env.DASHBOARD_URL;
const paystackSecretKey = process.env.PAYSTACK_SECRET_KEY;
const paystackWebhookSecret = process.env.PAYSTACK_WEBHOOK_SECRET;
const slackWebhookUrl = process.env.SLACK_APPROVALS_WEBHOOK_URL;

let persistence: PostgresPersistence | undefined;
let platform: Platform;

if (databaseUrl) {
  persistence = new PostgresPersistence(databaseUrl);
  await persistence.migrate();
  platform = await persistence.load();
  console.log("A-CARD API: loaded platform state from Postgres");
} else {
  platform = new Platform();
  console.log("A-CARD API: no DATABASE_URL set — state is in-memory only and will not survive a restart");
}

if (slackWebhookUrl) attachSlackNotifications(platform, slackWebhookUrl, dashboardUrl);

const app = createApp({
  platform,
  issuerWebhookSecret,
  dashboardUrl,
  onMutation: persistence ? () => persistence!.save(platform) : undefined,
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
    await persistence?.close();
    server.close(() => process.exit(0));
  });
}
