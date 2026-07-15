#!/usr/bin/env node
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { handleMcpRequest } from "./http.js";

const port = Number(process.env.MCP_HTTP_PORT ?? 8788);
const app = new Hono();

app.get("/health", (c) => c.json({ ok: true, service: "acard-mcp" }));
app.all("/mcp", (c) => handleMcpRequest(c.req.raw));

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`A-CARD MCP server (remote/HTTP) listening on http://localhost:${info.port}/mcp`);
});
