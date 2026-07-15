import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { AcardClient } from "./client.js";
import { createMcpServer } from "./server.js";

/**
 * Remote (hosted) MCP transport, so `acard-mcp` can run as an AWS service
 * instead of only being spawned locally over stdio by a desktop client.
 *
 * Deliberately stateless: each request creates a fresh MCP server + transport
 * scoped to the caller's own A-CARD API key (from the `Authorization` header),
 * so any ECS task behind the load balancer can answer any request — no
 * sticky sessions, no in-memory session table to lose on a redeploy.
 */

const ACARD_API_URL = process.env.ACARD_API_URL ?? "http://localhost:8787";

export async function handleMcpRequest(request: Request): Promise<Response> {
  const auth = request.headers.get("authorization") ?? "";
  const apiKey = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!apiKey) {
    return new Response(
      JSON.stringify({ error: "missing Authorization: Bearer <acard api key>" }),
      { status: 401, headers: { "content-type": "application/json" } },
    );
  }

  const client = new AcardClient({ baseUrl: ACARD_API_URL, apiKey });
  const server = createMcpServer(client);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  return transport.handleRequest(request);
}
