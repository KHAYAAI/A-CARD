import { readFileSync } from "node:fs";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { createSandbox } from "./app.js";
import { anthropicModel } from "./model.js";

const PORT = Number(process.env.PORT ?? 8080);
// The model key comes from the environment, or from a file only the host's owner can write
// (ACARD_SANDBOX_KEY_FILE, default ~/.acard-sandbox-key). Never from code or a request.
const keyFile = process.env.ACARD_SANDBOX_KEY_FILE ?? `${process.env.HOME ?? "."}/.acard-sandbox-key`;
const readKey = () => {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  try { return readFileSync(keyFile, "utf8").trim() || undefined; } catch { return undefined; }
};
const modelName = process.env.SANDBOX_MODEL ?? "claude-sonnet-5-5";

const sandbox = await createSandbox({
  baseUrl: `http://127.0.0.1:${PORT}`,
  // Read the key per call, so it can be added or rotated without a restart.
  model: (req) => {
    const apiKey = readKey();
    if (!apiKey) throw new Error("The sandbox agent is offline: no model key is configured on this server yet.");
    return anthropicModel({ apiKey, model: modelName })(req);
  },
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
