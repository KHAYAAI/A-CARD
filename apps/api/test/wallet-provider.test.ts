import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serve, type ServerType } from "@hono/node-server";
import { AfpLedger } from "@acard/core";
import { createProviderApp } from "@acard/wallet-provider/app";
import { loadNetworks, TESTNETS } from "../../wallet-provider/src/chains.js";
import { parseMasterKey } from "../../wallet-provider/src/crypto.js";
import { ProviderService, usdc } from "../../wallet-provider/src/service.js";
import { MemoryKeyStore } from "../../wallet-provider/src/store.js";
import { startFakeEvmNode } from "@acard/wallet-provider/testing";
import { InMemoryAfpLedger } from "../src/afp/index.js";
import { createApp } from "../src/app.js";
import { InMemoryPlatformService } from "../src/service/index.js";
import { Platform } from "@acard/core";
import { createCardRail, createProviderStablecoinRail } from "../src/rails/index.js";
import type { AddressInfo } from "node:net";

const PROVIDER_KEY = "provider-key-0123456789abcdef";
const DEST = "0x000000000000000000000000000000000000dEaD";

describe("platform + self-hosted wallet provider + fake chain, end to end", () => {
  let node: Awaited<ReturnType<typeof startFakeEvmNode>>;
  let server: ServerType;
  let app: ReturnType<typeof createApp>;
  let apiKey: string;
  let address: string;
  let providerUrl: string;
  const authed = (path: string, init: RequestInit = {}) =>
    app.request(path, { ...init, headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json", ...(init.headers ?? {}) } });

  beforeAll(async () => {
    node = await startFakeEvmNode({ chainId: TESTNETS.ethereum.chainId!, usdc: TESTNETS.ethereum.usdc });
    const svc = new ProviderService({
      masterKey: parseMasterKey("a1".repeat(16) + "b2".repeat(16)),
      store: new MemoryKeyStore(),
      networks: loadNetworks({ PROVIDER_RPC_ETHEREUM: node.url }),
      maxTransfer: usdc(100),
      maxDaily: usdc(250),
      confirmTimeoutMs: 2000,
      log: () => {},
    });
    await new Promise<void>((resolve) => {
      server = serve({ fetch: createProviderApp(svc, { apiKey: PROVIDER_KEY }).fetch, port: 0, hostname: "127.0.0.1" }, (info: AddressInfo) => {
        providerUrl = `http://127.0.0.1:${info.port}`;
        resolve();
      });
    });

    const service = new InMemoryPlatformService(new Platform());
    const rail = await createProviderStablecoinRail({ baseUrl: providerUrl, apiKey: PROVIDER_KEY, listLinkedWallets: (id) => service.listLinkedWallets(id) });
    expect(rail.carriesRealValue).toBe(false); // testnet provider: no real value
    app = createApp({
      platform: service,
      issuerWebhookSecret: "whsec_test",
      afp: { ledger: new InMemoryAfpLedger(new AfpLedger()), rails: [createCardRail(service, "whsec_test"), rail] },
      embeddedWallet: { baseUrl: providerUrl, apiKey: PROVIDER_KEY, defaultChain: "ethereum" },
    });
    const res = await app.request("/v1/signup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "dev@example.co.za", name: "Dev", currency: "ZAR" }) });
    apiKey = ((await res.json()) as any).api_key;
  });
  afterAll(async () => {
    server.close();
    await node.close();
  });

  const intent = async (amount: number) => ((await (await authed("/v1/afp/intents", { method: "POST", body: JSON.stringify({ amount, currency: "USD", purpose: "test payment", counterparty: DEST, allowed_rails: ["stablecoin"] }) })).json()) as any);
  const execute = (id: string, key: string) => authed(`/v1/afp/intents/${id}/execute`, { method: "POST", headers: { "idempotency-key": key }, body: "{}" });

  it("signup provisions a real wallet whose address derives from a generated key", async () => {
    const wallets = ((await (await authed("/v1/wallets/crypto")).json()) as any).wallets;
    expect(wallets).toHaveLength(1);
    expect(wallets[0]).toMatchObject({ kind: "embedded", chain: "ethereum", isDefault: true });
    address = wallets[0].address;
    expect(address).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it("the stablecoin rail is not offered while the wallet is empty", async () => {
    const created = await intent(2_000);
    expect(JSON.stringify(created)).toMatch(/holds 0 USDC/);
    const res = await execute(created.intent.id, "ek-0");
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(node.transfers).toHaveLength(0);
  });

  it("executes a USD intent as a signed testnet USDC transfer the chain independently verifies", async () => {
    node.fund(address, usdc(100));
    const created = await intent(2_500); // $25.00
    const res = await execute(created.intent.id, "ek-1");
    expect(res.status).toBe(201);
    const { transaction } = (await res.json()) as any;
    expect(transaction).toMatchObject({ rail: "stablecoin", status: "settled" });
    expect(transaction.railReference).toMatch(/^0x[0-9a-f]{64}$/);

    const seen = node.transfers.find((t) => t.txHash === transaction.railReference)!;
    expect(seen).toBeTruthy();
    expect(seen.from.toLowerCase()).toBe(address.toLowerCase()); // signed by the user's own generated key
    expect(seen.to.toLowerCase()).toBe(DEST.toLowerCase());
    expect(seen.amount).toBe(usdc(25));
    expect(node.balanceOf(address)).toBe(usdc(75));
  });

  it("a retried execute with the same idempotency key does not pay twice", async () => {
    node.fund(address, usdc(50));
    const created = await intent(1_000);
    const first = (await (await execute(created.intent.id, "ek-2")).json()) as any;
    const n = node.transfers.length;
    const again = await execute(created.intent.id, "ek-2");
    expect(again.status).toBeLessThan(300);
    expect(node.transfers.length).toBe(n);
    expect(((await again.json()) as any).transaction.railReference).toBe(first.transaction.railReference);
  });

  it("a non-address counterparty is refused cleanly and nothing is sent", async () => {
    const created = ((await (await authed("/v1/afp/intents", { method: "POST", body: JSON.stringify({ amount: 500, currency: "USD", purpose: "x", counterparty: "merchant-123", allowed_rails: ["stablecoin"] }) })).json()) as any);
    const n = node.transfers.length;
    const res = await execute(created.intent.id, "ek-3");
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(node.transfers.length).toBe(n);
  });

  it("an unreachable provider at startup fails closed", async () => {
    await expect(createProviderStablecoinRail({ baseUrl: "http://127.0.0.1:1", apiKey: PROVIDER_KEY, listLinkedWallets: async () => [] })).rejects.toThrow();
  });
});
