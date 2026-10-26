import { spawn, type ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, platform as osPlatform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { serve } from "@hono/node-server";
import { Platform } from "@acard/core";
import { createApp } from "../../apps/api/src/app.js";
import { InMemoryMerchantAuth, InMemoryMerchantDirectory } from "../../apps/api/src/merchant/index.js";
import { seedDemoWorld } from "../../examples/seed-demo-world.js";

/**
 * Recording kit: everything a Claude Desktop screen recording needs, on one
 * machine, with one command.
 *
 *   npm run recording-kit -- --org "Acme Freight" --email ops@acme.example
 *
 * Starts the real A-CARD API (in-memory sandbox) on :8787, registers the
 * customer's org, seeds wallets, departments, policy and the A-MERCHANT supply
 * market, issues an agent key for Claude Desktop, and starts the dashboard on
 * :3000. With --install-claude it adds the `acard` MCP server to Claude
 * Desktop's config (backing up the old file first). With --stores it also
 * starts the demo stores on :4400 for the optional Claude in Chrome scene.
 *
 * State lives in memory: stopping the kit wipes the world, and the next start
 * is a clean take. Claude Desktop's MCP entry points at mcp-launcher.ts, which
 * reads the current key from .kit/state.json, so the config never changes
 * between takes; restart Claude Desktop after restarting the kit.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const STATE_DIR = join(HERE, ".kit");
const STATE_FILE = join(STATE_DIR, "state.json");

const { values: opts } = parseArgs({
  options: {
    org: { type: "string", default: "Khaya Logistics" },
    email: { type: "string", default: "ops@customer.example" },
    password: { type: "string", default: "sandbox-demo-2026" },
    currency: { type: "string", default: "ZAR" },
    "api-port": { type: "string", default: "8787" },
    "dashboard-port": { type: "string", default: "3000" },
    "no-dashboard": { type: "boolean", default: false },
    stores: { type: "boolean", default: false },
    "install-claude": { type: "boolean", default: false },
    "print-claude-config": { type: "boolean", default: false },
  },
});

const API_PORT = Number(opts["api-port"]);
const API = `http://localhost:${API_PORT}`;
const DASHBOARD = `http://localhost:${opts["dashboard-port"]}`;
const children: ChildProcess[] = [];
let shuttingDown = false;

/** How Claude Desktop launches the MCP server: absolute paths only, since it starts with a bare PATH. */
function claudeServerEntry() {
  return {
    command: process.execPath,
    args: [createRequire(join(REPO, "package.json")).resolve("tsx/cli"), join(HERE, "mcp-launcher.ts")],
  };
}

function claudeConfigPath(): string {
  if (osPlatform() === "darwin") return join(homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
  if (osPlatform() === "win32") return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
  return join(homedir(), ".config", "Claude", "claude_desktop_config.json");
}

/** Add (or update) the `acard` entry, keeping every other server. Backs the old file up first. */
function installClaudeConfig(): string {
  const path = claudeConfigPath();
  mkdirSync(dirname(path), { recursive: true });
  let config: { mcpServers?: Record<string, unknown> } = {};
  if (existsSync(path)) {
    copyFileSync(path, `${path}.bak-${Date.now()}`);
    config = JSON.parse(readFileSync(path, "utf8") || "{}");
  }
  config.mcpServers = { ...(config.mcpServers ?? {}), acard: claudeServerEntry() };
  writeFileSync(path, JSON.stringify(config, null, 2));
  return path;
}

if (opts["print-claude-config"]) {
  console.log(JSON.stringify({ mcpServers: { acard: claudeServerEntry() } }, null, 2));
  process.exit(0);
}

// ---- A-CARD API ------------------------------------------------------------------
const platform = new Platform();
const app = createApp({
  platform,
  issuerWebhookSecret: "whsec_recording_kit",
  merchants: new InMemoryMerchantDirectory(platform.merchants),
  merchantAuth: new InMemoryMerchantAuth(platform.merchantAuth),
  dashboardUrl: DASHBOARD,
});
await new Promise<void>((resolve, reject) => {
  const server = serve({ fetch: app.fetch, port: API_PORT }, () => resolve());
  server.on("error", reject);
}).catch((error: NodeJS.ErrnoException) => {
  console.error(error.code === "EADDRINUSE" ? `Port ${API_PORT} is busy. Stop whatever is using it, or pass --api-port.` : error);
  process.exit(1);
});

const register = await fetch(`${API}/v1/auth/register`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: opts.email, name: opts.org, password: opts.password, currency: opts.currency, account_type: "enterprise" }),
});
const registered = (await register.json()) as { session_token: string };
if (!register.ok) throw new Error(`register failed: ${JSON.stringify(registered)}`);
const session = registered.session_token;

const world = await seedDemoWorld({ baseUrl: API, apiKey: session, log: () => {} });

// An enterprise customer on the enterprise plan, as a settled subscription
// would leave it; the free tier's 5 cards a month would cut a take short.
const { cards } = (await (await fetch(`${API}/v1/cards`, { headers: { authorization: `Bearer ${session}` } })).json()) as {
  cards: { accountHolderId: string }[];
};
platform.setSubscriptionTier(cards[0].accountHolderId, "enterprise");

// Claude Desktop gets its own key, like any agent. A human's session never goes to an agent.
const keyRes = await fetch(`${API}/v1/keys`, {
  method: "POST",
  headers: { authorization: `Bearer ${session}`, "content-type": "application/json" },
  body: JSON.stringify({ name: "Claude Desktop" }),
});
const issued = (await keyRes.json()) as { api_key?: string; secret?: string; key?: { secret?: string } };
const agentKey = issued.api_key ?? issued.secret ?? issued.key?.secret;
if (!agentKey) throw new Error(`could not issue an agent key: ${JSON.stringify(issued)}`);

mkdirSync(STATE_DIR, { recursive: true });
writeFileSync(
  STATE_FILE,
  JSON.stringify({ apiUrl: API, dashboardUrl: DASHBOARD, org: opts.org, email: opts.email, password: opts.password, session, agentKey, world }, null, 2),
);

// ---- dashboard and stores ----------------------------------------------------------
function start(name: string, cmd: string, args: string[], cwd: string, env: Record<string, string>) {
  const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  const log: string[] = [];
  child.stdout?.on("data", (d) => log.push(String(d)));
  child.stderr?.on("data", (d) => log.push(String(d)));
  child.on("exit", (code) => {
    if (code && !shuttingDown) console.error(`\n${name} exited (${code}):\n${log.join("").slice(-2000)}`);
  });
  children.push(child);
}

if (!opts["no-dashboard"]) {
  const dashboardDir = join(REPO, "apps", "dashboard");
  const nextBin = createRequire(join(dashboardDir, "package.json")).resolve("next/dist/bin/next");
  start("dashboard", process.execPath, [nextBin, "dev", "-p", String(opts["dashboard-port"])], dashboardDir, {
    NEXT_PUBLIC_ACARD_API_URL: API,
  });
}
if (opts.stores) {
  start("stores", process.execPath, [join(REPO, "marketing", "videos", "production", "web", "server.mjs")], REPO, {
    ACARD_API_URL: API,
    ISSUER_WEBHOOK_SECRET: "whsec_recording_kit",
    ACARD_LOOKUP_KEY: session,
  });
}

let installedAt: string | undefined;
if (opts["install-claude"]) installedAt = installClaudeConfig();

const stop = () => {
  shuttingDown = true;
  for (const c of children) c.kill("SIGTERM");
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

console.log(`
A-CARD recording kit is running (sandbox, in memory)

  Org         ${opts.org}
  Dashboard   ${opts["no-dashboard"] ? "(not started)" : DASHBOARD}   sign in: ${opts.email} / ${opts.password}
  API         ${API}
  Wallet      R500 000.00 · $10 000.00   Policy: MCC 7995 blocked, org approval from R25 000
  A-MERCHANT  4 verified suppliers around Johannesburg (cement, sand, diesel, truck tyres)${opts.stores ? "\n  Stores      http://localhost:4400/seek  (fictional; for the Claude in Chrome scene)" : ""}

  Claude Desktop  ${installedAt ? `config updated: ${installedAt}` : "run with --install-claude, or add the entry from --print-claude-config"}
                  Restart Claude Desktop now, so it picks up this take's key.

Ctrl+C stops everything and wipes the world. Start again for a clean take.
`);
