import { serve } from "@hono/node-server";
import { Platform } from "@acard/core";
import { createApp } from "./app.js";

const port = Number(process.env.PORT ?? 8787);
const issuerWebhookSecret = process.env.ISSUER_WEBHOOK_SECRET ?? "whsec_sandbox_secret";

const platform = new Platform();
const app = createApp({ platform, issuerWebhookSecret });

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`A-CARD API (sandbox) listening on http://localhost:${info.port}`);
});
