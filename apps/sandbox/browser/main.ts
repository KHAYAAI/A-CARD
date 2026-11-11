import { createSandbox } from "../src/app.js";
import { mockModel } from "../src/mock.js";
import { anthropicModel } from "../src/model.js";

/**
 * The whole sandbox, running in the page: the A-CARD platform, the demo
 * agent, the MCP tools, the wallet. No server. fetch() calls to the sandbox's
 * own origin are answered in-process; everything else (only Anthropic, and
 * only when a visitor adds their own key) goes out normally.
 */
const BASE = "https://sandbox.a-card.local";
const realFetch = globalThis.fetch.bind(globalThis);
let handler: (req: Request) => Response | Promise<Response>;
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const req = new Request(input as any, init);
  return req.url.startsWith(BASE) ? handler(req) : realFetch(req);
}) as typeof fetch;

(window as any).__ACARD_API__ = BASE;
(window as any).__sandboxReady = (async () => {
  const sb = await createSandbox({
    baseUrl: BASE,
    mockModel,
    liveModel: (apiKey) => anthropicModel({ apiKey, model: "claude-sonnet-5-5", browserDirect: true }),
    maxTurnsPerSession: 200,
    maxSessionsPerIpPerHour: 1_000_000,
  });
  handler = (req) => sb.app.fetch(req);
  await sb.init();
})();
