#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { AcardClient } from "./client.js";
import { createMcpServer } from "./server.js";

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
const baseUrl = env("ACARD_API_URL") ?? fileConfig.apiUrl ?? "http://localhost:8787";
const apiKey = env("ACARD_API_KEY") ?? fileConfig.apiKey;

if (!apiKey) {
  console.error(`No A-CARD API key: set ACARD_API_KEY, or run \`acard-mcp setup --api-key ak_…\` (writes ${CONFIG_FILE}).`);
  process.exit(1);
}

const server = createMcpServer(new AcardClient({ baseUrl, apiKey }));
await server.connect(new StdioServerTransport());
console.error(`acard MCP server connected (API: ${baseUrl})`);
