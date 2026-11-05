#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { WalletService } from "./wallet.js";
import { devWallet } from "./dev.js";
import { registerWalletTools } from "./tools/wallet.js";

export function buildServer(wallet: WalletService): McpServer {
  const server = new McpServer({ name: "forge-agent-wallet", version: "0.1.0" });
  registerWalletTools(server, wallet);
  return server;
}

const isMain = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("server.ts");
if (isMain) {
  const server = buildServer(await devWallet());
  await server.connect(new StdioServerTransport());
}
