import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serve } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { AfpLedger, Platform } from "@acard/core";
import { createApp } from "../src/app.js";
import { InMemoryAfpLedger } from "../src/afp/index.js";
import { InMemoryPlatformService } from "../src/service/index.js";
import { createX402Payer, SANDBOX_SIGNER, USDC_BY_NETWORK } from "../src/x402/index.js";
// @ts-expect-error — plain .mjs build script, no types
import { bundle } from "../../mcp/scripts/bundle.mjs";

/**
 * The agent-app plugins in plugins/acard ship a bundled MCP server. These
 * tests launch the committed bundle exactly as each host would and drive it
 * against a live API and a live x402 server:
 *
 *   Claude Code: `node ${CLAUDE_PLUGIN_ROOT}/server/acard-mcp.mjs`, credentials via plugin options in env
 *   Codex:       `node ./server/acard-mcp.mjs` with cwd at the plugin root, credentials from ~/.acard/config.json
 */

const ROOT = join(__dirname, "..", "..", "..");
const PLUGIN = join(ROOT, "plugins", "acard");
const BUNDLE = join(PLUGIN, "server", "acard-mcp.mjs");
const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8"));

let api: ReturnType<typeof serve>;
let apiUrl: string;
let apiKey: string;
let x402Server: Server;
let resourceUrl: string;
let paidRequests = 0;

beforeAll(async () => {
  const platform = new Platform();
  const service = new InMemoryPlatformService(platform);
  const ledger = new InMemoryAfpLedger(new AfpLedger());
  const x402 = createX402Payer(service, ledger, {
    signer: SANDBOX_SIGNER,
    payerAddress: "0x2222222222222222222222222222222222222222",
    networks: ["eip155:84532"],
    allowPrivateNetworks: true,
  });
  const app = createApp({ platform: service, issuerWebhookSecret: "whsec_plugins", afp: { ledger, rails: [], x402 } });
  apiUrl = await new Promise<string>((resolve) => {
    api = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info) => resolve(`http://127.0.0.1:${info.port}`));
  });
  const signup = await (
    await fetch(`${apiUrl}/v1/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "plugins@acard.example", name: "Plugins", currency: "USD" }),
    })
  ).json() as { api_key: string };
  apiKey = signup.api_key;
  await fetch(`${apiUrl}/v1/wallet/fund`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ amount: 1_000, currency: "USD" }),
  });

  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64");
  const requirement = {
    scheme: "exact",
    network: "eip155:84532",
    amount: "3000",
    asset: USDC_BY_NETWORK["eip155:84532"]!.address,
    payTo: "0x1111111111111111111111111111111111111111",
    maxTimeoutSeconds: 60,
  };
  x402Server = createServer((req, res) => {
    if (!req.headers["payment-signature"]) {
      res.writeHead(402, { "payment-required": b64({ x402Version: 2, accepts: [requirement] }) });
      return res.end("{}");
    }
    paidRequests++;
    res.writeHead(200, { "content-type": "text/plain", "payment-response": b64({ success: true, transaction: "0xbeef", network: requirement.network }) });
    res.end("weather: 24C, clear");
  });
  await new Promise<void>((r) => x402Server.listen(0, "127.0.0.1", r));
  resourceUrl = `http://127.0.0.1:${(x402Server.address() as { port: number }).port}/weather`;
});

afterAll(() => {
  api?.close();
  x402Server?.close();
});

async function connect(options: { cwd: string; args: string[]; env: Record<string, string> }) {
  const client = new Client({ name: "plugin-test", version: "1.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: options.args, cwd: options.cwd, env: options.env, stderr: "ignore" }));
  return client;
}
const call = async (client: Client, name: string, args: Record<string, unknown>) => {
  const res = (await client.callTool({ name, arguments: args })) as { content: Array<{ text?: string }> };
  return JSON.parse(res.content.map((c) => c.text ?? "").join(""));
};

describe("plugins/acard", () => {
  it("ships the bundle the build script produces from apps/mcp (run `npm run plugins:build` if this fails)", async () => {
    const fresh: string = await bundle({ write: false });
    expect(readFileSync(BUNDLE, "utf8") === fresh).toBe(true);
  });

  it("keeps the Claude Code, Codex and OpenClaw manifests consistent", () => {
    const claude = readJson(join(PLUGIN, ".claude-plugin", "plugin.json"));
    const codex = readJson(join(PLUGIN, ".codex-plugin", "plugin.json"));
    const openclaw = readJson(join(PLUGIN, "openclaw.plugin.json"));
    expect(new Set([claude.name, codex.name, openclaw.id])).toEqual(new Set(["acard"]));
    expect(new Set([claude.version, codex.version, openclaw.version]).size).toBe(1);

    expect(readJson(join(PLUGIN, ".mcp.json")).mcpServers.acard.args).toEqual(["${CLAUDE_PLUGIN_ROOT}/server/acard-mcp.mjs"]);
    const codexMcp = readJson(join(PLUGIN, codex.mcpServers));
    expect(codexMcp.mcpServers.acard).toMatchObject({ command: "node", args: ["./server/acard-mcp.mjs"], cwd: "." });
    expect(existsSync(join(PLUGIN, codex.skills, "acard", "SKILL.md"))).toBe(true);
    for (const skill of openclaw.skills) expect(existsSync(join(PLUGIN, skill, "SKILL.md"))).toBe(true);

    const claudeMarket = readJson(join(ROOT, ".claude-plugin", "marketplace.json"));
    const codexMarket = readJson(join(ROOT, ".agents", "plugins", "marketplace.json"));
    expect(claudeMarket.plugins[0]).toMatchObject({ name: "acard", source: "./plugins/acard" });
    expect(codexMarket.plugins[0]).toMatchObject({ name: "acard", source: { source: "local", path: "./plugins/acard" } });
  });

  it("runs as Claude Code launches it, and pays an x402 API through a scoped card", async () => {
    const home = mkdtempSync(join(tmpdir(), "acard-claude-"));
    const client = await connect({
      cwd: home,
      args: [BUNDLE], // ${CLAUDE_PLUGIN_ROOT} expanded
      env: { PATH: process.env.PATH ?? "", HOME: home, ACARD_API_KEY: apiKey, ACARD_API_URL: apiUrl },
    });
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(
        ["close_card", "create_card", "find_offers", "get_card", "get_merchant", "get_wallet", "list_cards", "list_transactions", "pay_checkout", "pay_x402"].sort(),
      );
      const card = await call(client, "create_card", { label: "weather API", currency: "USD", single_use: false, allowed_merchant_categories: ["x402"], x402_allowed_hosts: ["127.0.0.1"] });
      expect(card.x402AllowedHosts).toEqual(["127.0.0.1"]);
      const paid = await call(client, "pay_x402", { card_id: card.id, url: resourceUrl, max_usd: "0.01" });
      expect(paid).toMatchObject({ status: "paid", charged_cents: 1, price: { usd: "0.003000" }, resource: { body: "weather: 24C, clear" } });
      expect(paidRequests).toBe(1);
    } finally {
      await client.close();
    }
  });

  it("runs as Codex launches it — cwd at the plugin root, credentials from ~/.acard/config.json, unexpanded options ignored", async () => {
    const home = mkdtempSync(join(tmpdir(), "acard-codex-"));
    mkdirSync(join(home, ".acard"));
    writeFileSync(join(home, ".acard", "config.json"), JSON.stringify({ apiKey, apiUrl }));
    const client = await connect({
      cwd: PLUGIN,
      args: ["./server/acard-mcp.mjs"],
      env: { PATH: process.env.PATH ?? "", HOME: home, ACARD_API_KEY: "${user_config.api_key}", ACARD_API_URL: "" },
    });
    try {
      const wallets = await call(client, "get_wallet", {});
      expect(wallets.find((w: { currency: string }) => w.currency === "USD").available).toBeGreaterThan(0);
    } finally {
      await client.close();
    }
  });
});
