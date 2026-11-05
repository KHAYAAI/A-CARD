import { Hono } from "hono";
import { handleMcpRequest } from "./http.js";
import { WalletHost } from "./walletHost.js";

/** The hosted server's routes. `walletHost` is optional: without it the HTTP server offers cards only. */
export function createHttpApp(options: { walletHost?: WalletHost } = {}) {
  const app = new Hono();
  app.get("/health", (c) => c.json({ ok: true, service: "acard-mcp" }));
  app.all("/mcp", (c) => handleMcpRequest(c.req.raw, { wallets: options.walletHost }));
  if (options.walletHost) {
    const host = options.walletHost;
    app.all("/wallet/approvals/*", async (c) => (await host.handleOperator(c.req.raw)) ?? c.notFound());
    app.all("/wallet/approvals", async (c) => (await host.handleOperator(c.req.raw)) ?? c.notFound());
  }
  return app;
}
