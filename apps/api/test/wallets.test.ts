import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Platform } from "@acard/core";
import { createApp } from "../src/app.js";

const SECRET = "whsec_test";

let app: ReturnType<typeof createApp>;
let apiKey: string;

async function json(res: Response) {
  return (await res.json()) as any;
}

function authed(path: string, init: RequestInit = {}) {
  return app.request(path, {
    ...init,
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

describe("crypto wallets: no embedded provider configured", () => {
  beforeEach(async () => {
    app = createApp({ platform: new Platform(), issuerWebhookSecret: SECRET });
    const res = await app.request("/v1/signup", {
      method: "POST",
      body: JSON.stringify({ email: "dev@example.co.za", name: "Dev", currency: "ZAR" }),
      headers: { "content-type": "application/json" },
    });
    apiKey = (await json(res)).api_key;
  });

  it("signup succeeds with no wallets when embedded wallet provider isn't configured", async () => {
    const res = await authed("/v1/wallets/crypto");
    expect(res.status).toBe(200);
    expect((await json(res)).wallets).toEqual([]);
  });

  it("still allows linking an external wallet", async () => {
    const res = await authed("/v1/wallets/crypto/link", {
      method: "POST",
      body: JSON.stringify({ chain: "ethereum", address: "0x1111111111111111111111111111111111111111", connector: "metamask" }),
    });
    expect(res.status).toBe(201);
    const body = await json(res);
    expect(body.wallet.kind).toBe("external");
    expect(body.wallet.isDefault).toBe(true);
  });
});

describe("crypto wallets: embedded provider configured", () => {
  const fetchMock = vi.fn(async (url: string) => {
    if (url.endsWith("/wallets")) {
      return new Response(JSON.stringify({ address: "0xabcabcabcabcabcabcabcabcabcabcabcabcabc", chain: "ethereum" }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  });

  beforeEach(async () => {
    vi.stubGlobal("fetch", fetchMock);
    app = createApp({
      platform: new Platform(),
      issuerWebhookSecret: SECRET,
      embeddedWallet: { baseUrl: "https://wallets.internal", apiKey: "wk_test" },
    });
    const res = await app.request("/v1/signup", {
      method: "POST",
      body: JSON.stringify({ email: "dev@example.co.za", name: "Dev", currency: "ZAR" }),
      headers: { "content-type": "application/json" },
    });
    apiKey = (await json(res)).api_key;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockClear();
  });

  it("auto-provisions an embedded wallet at signup — no user action required", async () => {
    expect(fetchMock).toHaveBeenCalled();
    const res = await authed("/v1/wallets/crypto");
    const wallets = (await json(res)).wallets;
    expect(wallets).toHaveLength(1);
    expect(wallets[0].kind).toBe("embedded");
    expect(wallets[0].address).toBe("0xabcabcabcabcabcabcabcabcabcabcabcabcabc");
    expect(wallets[0].isDefault).toBe(true);
  });

  it("lets a user additionally link a third-party wallet and switch the default", async () => {
    const linkRes = await authed("/v1/wallets/crypto/link", {
      method: "POST",
      body: JSON.stringify({ chain: "ethereum", address: "0x1111111111111111111111111111111111111111", connector: "metamask" }),
    });
    expect(linkRes.status).toBe(201);
    const linked = (await json(linkRes)).wallet;
    expect(linked.isDefault).toBe(false); // embedded wallet from signup is still default

    const setDefaultRes = await authed(`/v1/wallets/crypto/${linked.id}/default`, { method: "POST" });
    expect(setDefaultRes.status).toBe(200);
    expect((await json(setDefaultRes)).wallet.isDefault).toBe(true);

    const list = (await json(await authed("/v1/wallets/crypto"))).wallets;
    expect(list).toHaveLength(2);
  });

  it("cannot unlink the embedded wallet but can unlink an external one", async () => {
    const wallets = (await json(await authed("/v1/wallets/crypto"))).wallets;
    const embeddedId = wallets[0].id;

    const denied = await authed(`/v1/wallets/crypto/${embeddedId}`, { method: "DELETE" });
    expect(denied.status).toBe(409);

    const linkRes = await authed("/v1/wallets/crypto/link", {
      method: "POST",
      body: JSON.stringify({ chain: "ethereum", address: "0x2222222222222222222222222222222222222222", connector: "walletconnect" }),
    });
    const linked = (await json(linkRes)).wallet;
    const removed = await authed(`/v1/wallets/crypto/${linked.id}`, { method: "DELETE" });
    expect(removed.status).toBe(200);
  });
});
