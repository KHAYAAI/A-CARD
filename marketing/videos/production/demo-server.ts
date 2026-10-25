import { writeFileSync } from "node:fs";
import { serve } from "@hono/node-server";
import { Platform } from "@acard/core";
import { createApp } from "../../../apps/api/src/app.js";
import { InMemoryMerchantAuth, InMemoryMerchantDirectory } from "../../../apps/api/src/merchant/index.js";
import { attachSlackNotifications } from "../../../apps/api/src/notifications.js";
import { seedDemoWorld } from "../../../examples/seed-demo-world.js";

/**
 * Recording harness for the marketing videos. It runs the real A-CARD app
 * (createApp, the in-memory platform, A-MERCHANT, the Slack notifier) on
 * :8787 and seeds the Khaya Logistics demo world through the public API.
 *
 * It exists for one reason: minting a merchant API key normally needs a
 * signed-in WorkOS portal session, which a recording machine doesn't have.
 * The harness mints that one key directly on the in-memory platform, exactly
 * as the test suite does. Everything else goes over HTTP.
 *
 * Writes world.json (credentials and ids) for the capture and video scripts.
 */

const PORT = 8787;
const BASE = `http://localhost:${PORT}`;
const SLACK = process.env.SLACK_SINK ?? "http://127.0.0.1:9911/slack";

const platform = new Platform();
const app = createApp({
  platform,
  issuerWebhookSecret: "whsec_demo_recording",
  merchants: new InMemoryMerchantDirectory(platform.merchants),
  merchantAuth: new InMemoryMerchantAuth(platform.merchantAuth),
  dashboardUrl: "http://localhost:3000",
});
attachSlackNotifications(platform, SLACK, "http://localhost:3000");

await new Promise<void>((resolve) => serve({ fetch: app.fetch, port: PORT }, () => resolve()));

const email = "thandi@khaya.example";
const password = "khaya-demo-2026";
const register = await fetch(`${BASE}/v1/auth/register`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email, name: "Khaya Logistics", password, currency: "ZAR", account_type: "enterprise" }),
});
const registered = (await register.json()) as { session_token: string };
if (!register.ok) throw new Error(`register failed: ${JSON.stringify(registered)}`);

const world = await seedDemoWorld({ baseUrl: BASE, apiKey: registered.session_token, log: () => {} });

// A programmatic key for the agent scenes (an agent never uses a human's session).
const keyRes = await fetch(`${BASE}/v1/keys`, {
  method: "POST",
  headers: { authorization: `Bearer ${registered.session_token}`, "content-type": "application/json" },
  body: JSON.stringify({ name: "agents" }),
});
const issued = (await keyRes.json()) as { api_key?: string; secret?: string; key?: { secret?: string } };
const agentKey = issued.api_key ?? issued.secret ?? issued.key?.secret;
if (!agentKey) throw new Error(`could not issue an agent key: ${JSON.stringify(issued)}`);

const { secret: merchantKey } = platform.merchantAuth.createApiKey(world.merchants.randBuild, {
  name: "Till 1",
  scope: "read_write",
  createdBy: "owner@randbuild.example",
});

writeFileSync(
  new URL("./world.json", import.meta.url),
  JSON.stringify({ ...world, email, password, session: registered.session_token, agentKey, merchantKey }, null, 2),
);
console.log(`demo server on ${BASE} — world.json written`);
