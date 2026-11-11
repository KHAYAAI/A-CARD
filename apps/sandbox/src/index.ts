import { readFileSync } from "node:fs";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { createSandbox } from "./app.js";
import { anthropicModel } from "./model.js";
import { mockModel } from "./mock.js";

const PORT = Number(process.env.PORT ?? 8080);
// Demo mode (scripted, no key) is the default. A visitor can add their own Anthropic key in the
// page for a live agent: it travels with their request, is used for that call, and is never stored
// or logged. This server holds no model key.
const modelName = process.env.SANDBOX_MODEL ?? "claude-sonnet-5-5";

const sandbox = await createSandbox({
  baseUrl: `http://127.0.0.1:${PORT}`,
  mockModel,
  liveModel: (apiKey) => anthropicModel({ apiKey, model: modelName }),
  maxTurnsPerSession: Number(process.env.SANDBOX_MAX_TURNS ?? 40),
});

const page = readFileSync(process.env.ACARD_SANDBOX_PAGE ?? new URL("../public/index.html", import.meta.url), "utf8");
const root = new Hono();
root.get("/", (c) => c.html(page));
root.route("/", sandbox.app);

serve({ fetch: root.fetch, port: PORT, hostname: "0.0.0.0" }, async () => {
  await sandbox.init();
  console.log(`A-CARD sandbox on :${PORT}`);
});
