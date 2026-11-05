import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serve } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createHttpApp } from "../src/httpApp.js";
import { WalletHost } from "../src/walletHost.js";

/** The hosted server, over real HTTP, with and without the opt-in sandbox wallet. */

const OPERATOR = "operator-secret-0123456789abcdef";
let withWallet: ReturnType<typeof serve>;
let without: ReturnType<typeof serve>;
let walletUrl: string;
let plainUrl: string;

const listen = (app: ReturnType<typeof createHttpApp>) =>
  new Promise<{ server: ReturnType<typeof serve>; url: string }>((resolve) => {
    const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info) => resolve({ server, url: `http://127.0.0.1:${info.port}` }));
  });

beforeAll(async () => {
  const a = await listen(createHttpApp({ walletHost: new WalletHost({ operatorToken: OPERATOR, sink: () => {} }) }));
  withWallet = a.server;
  walletUrl = a.url;
  const b = await listen(createHttpApp());
  without = b.server;
  plainUrl = b.url;
});
afterAll(() => {
  withWallet.close();
  without.close();
});

async function connect(url: string, key: string) {
  const client = new Client({ name: "http-wallet-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { authorization: `Bearer ${key}` } } }));
  return client;
}
const call = async (client: Client, name: string, args: Record<string, unknown> = {}) => {
  const res = (await client.callTool({ name, arguments: args })) as { content: Array<{ text?: string }>; isError?: boolean };
  const text = res.content.map((c) => c.text ?? "").join("");
  return { isError: res.isError === true, text, json: () => JSON.parse(text) };
};
const operator = (path: string, init: RequestInit = {}, token = OPERATOR) =>
  fetch(`${walletUrl}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) } });

describe("hosted MCP server and the sandbox wallet", () => {
  it("offers cards only unless the wallet is switched on", async () => {
    const client = await connect(plainUrl, "ak_plain");
    try {
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).toHaveLength(10);
      expect(names).not.toContain("send_preview");
    } finally {
      await client.close();
    }
  });

  it("keeps a wallet per API key across requests, and the keys don't share funds", async () => {
    const alice = await connect(walletUrl, "ak_alice");
    const bob = await connect(walletUrl, "ak_bob");
    try {
      expect((await alice.listTools()).tools).toHaveLength(21);
      const transfer = { wallet_id: "default", chain: "mock", asset: "USDC", to: "merchant-1" };
      const preview = (await call(alice, "send_preview", { ...transfer, amount: "5000000" })).json();
      expect(preview.decision).toBe("allow");
      // A second connection with the same key (a different HTTP request) sees the same wallet and can use the preview.
      const alice2 = await connect(walletUrl, "ak_alice");
      try {
        expect((await call(alice2, "send_execute", { preview_id: preview.preview_id })).isError).toBe(false);
        expect((await call(alice2, "get_balances", { chain: "mock" })).json().balances.USDC).toBe("495000000");
      } finally {
        await alice2.close();
      }
      expect((await call(bob, "get_balances", { chain: "mock" })).json().balances.USDC).toBe("500000000");
      // Bob can't execute Alice's preview.
      expect((await call(bob, "send_execute", { preview_id: preview.preview_id })).isError).toBe(true);
    } finally {
      await alice.close();
      await bob.close();
    }
  });

  it("holds a transfer for approval until the operator decides over HTTP", async () => {
    const client = await connect(walletUrl, "ak_carol");
    try {
      const preview = (await call(client, "send_preview", { wallet_id: "default", chain: "mock", asset: "USDC", to: "merchant-1", amount: "20000000" })).json();
      expect(preview.decision).toBe("require_approval");
      expect((await call(client, "send_execute", { preview_id: preview.preview_id })).text).toContain("approval_required");

      // The agent's A-CARD key is not an operator credential.
      expect((await operator("/wallet/approvals", {}, "ak_carol")).status).toBe(401);
      expect((await operator(`/wallet/approvals/${preview.approval_id}/approve`, { method: "POST" }, "ak_carol")).status).toBe(401);
      expect((await fetch(`${walletUrl}/wallet/approvals`)).status).toBe(401);

      expect(((await (await operator("/wallet/approvals")).json()) as { pending: string[] }).pending).toContain(preview.approval_id);
      const decided = await operator(`/wallet/approvals/${preview.approval_id}/approve`, { method: "POST" });
      expect(await decided.json()).toMatchObject({ status: "approved" });
      expect((await operator(`/wallet/approvals/${preview.approval_id}/approve`, { method: "POST" })).status).toBe(404); // already decided

      expect((await call(client, "send_execute", { preview_id: preview.preview_id })).isError).toBe(false);
      expect(((await (await operator("/wallet/approvals")).json()) as { pending: string[] }).pending).not.toContain(preview.approval_id);
    } finally {
      await client.close();
    }
  });

  it("has no wallet or operator routes when the wallet is off", async () => {
    expect((await fetch(`${plainUrl}/wallet/approvals`)).status).toBe(404);
  });

  it("refuses a weak operator token", () => {
    expect(() => new WalletHost({ operatorToken: "short" })).toThrow(/at least 24/);
  });
});
