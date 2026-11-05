#!/usr/bin/env node
import { serve } from "@hono/node-server";
import { createHttpApp } from "./httpApp.js";
import { WalletHost } from "./walletHost.js";

const port = Number(process.env.MCP_HTTP_PORT ?? 8788);

// The sandbox wallet is opt-in, and needs an operator secret for approvals (see walletHost.ts).
let walletHost: WalletHost | undefined;
if (process.env.ACARD_MCP_HTTP_WALLET === "true") {
  const operatorToken = process.env.ACARD_WALLET_OPERATOR_TOKEN;
  if (!operatorToken) {
    console.error("ACARD_MCP_HTTP_WALLET=true needs ACARD_WALLET_OPERATOR_TOKEN (at least 24 characters): approvals are decided with it, never by the agent.");
    process.exit(1);
  }
  walletHost = new WalletHost({ operatorToken, x402AllowPrivateNetworks: process.env.ACARD_WALLET_X402_ALLOW_PRIVATE_NETWORKS === "true" });
}

serve({ fetch: createHttpApp({ walletHost }).fetch, port }, (info) => {
  console.log(`A-CARD MCP server (remote/HTTP) listening on http://localhost:${info.port}/mcp${walletHost ? " · sandbox wallet on (single instance only)" : ""}`);
});
