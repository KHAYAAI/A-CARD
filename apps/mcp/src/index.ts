#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { AcardClient } from "./client.js";
import { createMcpServer } from "./server.js";

const baseUrl = process.env.ACARD_API_URL ?? "http://localhost:8787";
const apiKey = process.env.ACARD_API_KEY;

if (!apiKey) {
  console.error("ACARD_API_KEY is required (get one with `npx acard signup`)");
  process.exit(1);
}

const server = createMcpServer(new AcardClient({ baseUrl, apiKey }));
await server.connect(new StdioServerTransport());
console.error(`acard MCP server connected (API: ${baseUrl})`);
