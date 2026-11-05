#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { devWallet } from "@acard/agent-wallet";
import { AcardClient } from "./client.js";
import { createMcpServer } from "./server.js";
import { FileApprovalStore, WALLET_APPROVALS_FILE } from "./walletApprovals.js";

/**
 * Credentials come from ACARD_API_URL / ACARD_API_KEY, falling back to
 * ~/.acard/config.json — the same file the `acard` CLI writes, so one login
 * serves both. Agent apps that can't pass environment variables to an MCP
 * server (or shouldn't hold a key in their config) rely on the file.
 *
 *   acard-mcp setup --api-key ak_… [--api-url https://…]   writes that file
 */
const CONFIG_DIR = join(homedir(), ".acard");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");
const fileConfig: { apiUrl?: string; apiKey?: string } = existsSync(CONFIG_FILE) ? JSON.parse(readFileSync(CONFIG_FILE, "utf8")) : {};

if (process.argv[2] === "setup") {
  const flag = (name: string) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  const apiKey = flag("api-key");
  if (!apiKey?.startsWith("ak_")) {
    console.error("usage: acard-mcp setup --api-key ak_… [--api-url https://your-a-card-api]");
    process.exit(1);
  }
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify({ ...fileConfig, apiKey, apiUrl: flag("api-url") ?? fileConfig.apiUrl ?? "http://localhost:8787" }, null, 2), { mode: 0o600 });
  console.error(`Saved to ${CONFIG_FILE}. Restart your agent app to connect.`);
  process.exit(0);
}

// An unset plugin option can arrive as an empty string, or (in a host that
// doesn't expand it) as the literal "\${user_config.…}" placeholder: both mean "not set".
const env = (name: string) => {
  const value = process.env[name];
  return value && !value.startsWith("${") ? value : undefined;
};
// Operator commands for the sandbox wallet's approvals (see walletApprovals.ts).
// They run in a separate terminal from the agent and need no API key.
if (["wallet-approvals", "wallet-approve", "wallet-reject"].includes(process.argv[2] ?? "")) {
  const store = new FileApprovalStore();
  const [command, id] = [process.argv[2], process.argv[3]];
  if (command === "wallet-approvals") {
    const pending = store.pending();
    console.log(pending.length ? pending.join("\n") : `No pending approvals (${WALLET_APPROVALS_FILE}).`);
    process.exit(0);
  }
  if (!id) {
    console.error(`usage: acard-mcp ${command} <approval_id>`);
    process.exit(1);
  }
  try {
    store.decide(id, command === "wallet-approve");
    console.log(`${command === "wallet-approve" ? "Approved" : "Rejected"} ${id}.`);
    process.exit(0);
  } catch (error) {
    console.error(`${(error as Error).message}: ${id} is not a pending approval.`);
    process.exit(1);
  }
}

const baseUrl = env("ACARD_API_URL") ?? fileConfig.apiUrl ?? "http://localhost:8787";
const apiKey = env("ACARD_API_KEY") ?? fileConfig.apiKey;

if (!apiKey) {
  console.error(`No A-CARD API key: set ACARD_API_KEY, or run \`acard-mcp setup --api-key ak_…\` (writes ${CONFIG_FILE}).`);
  process.exit(1);
}

// The on-chain wallet is opt-in, and sandbox only: a mock chain and a dev
// signer that refuses real networks (packages/agent-wallet). Off by default, so
// a plugin install never presents invented balances to an agent.
const wallet = env("ACARD_ENABLE_WALLET") === "true" ? await devWallet({ approvals: new FileApprovalStore(), x402AllowPrivateNetworks: env("ACARD_WALLET_X402_ALLOW_PRIVATE_NETWORKS") === "true" }) : undefined;

const server = createMcpServer(new AcardClient({ baseUrl, apiKey }), { wallet });
await server.connect(new StdioServerTransport());
console.error(`acard MCP server connected (API: ${baseUrl})${wallet ? " · sandbox wallet on" : ""}`);
