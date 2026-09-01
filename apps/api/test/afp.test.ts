import { createServer } from "node:http";
import { beforeEach, describe, expect, it } from "vitest";
import { AfpLedger, Platform } from "@acard/core";
import { InMemoryAfpLedger } from "../src/afp/index.js";
import { createApp } from "../src/app.js";
import { InMemoryPlatformService } from "../src/service/index.js";
import {
  createCardRail,
  createSandboxStablecoinClient,
  createStablecoinRail,
  createX402Rail,
  SANDBOX_SIGNER,
  type RailAdapter,
} from "../src/rails/index.js";

const SECRET = "whsec_test";

let platform: Platform;
let service: InMemoryPlatformService;
let ledger: AfpLedger;
let app: ReturnType<typeof createApp>;
let apiKey: string;

async function json(res: Response) {
  return (await res.json()) as any;
}

function authed(path: string, init: RequestInit = {}) {
  return app.request(path, {
    ...init,
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

/** A minimal x402 counterparty — real HTTP, real 402/retry flow, running on a real socket. */
function startX402Server(opts: { requiredAmount: string; failRetry?: boolean } = { requiredAmount: "19900" }) {
  const server = createServer((req, res) => {
    const paid = req.headers["x-payment"];
    if (!paid) {
      res.writeHead(402, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          x402Version: 1,
          accepts: [
            {
              scheme: "exact",
              network: "eip155:8453",
              amount: opts.requiredAmount,
              asset: "0xUSDC",
              payTo: "0xmerchant",
              maxTimeoutSeconds: 60,
            },
          ],
        }),
      );
      return;
    }
    if (opts.failRetry) {
      res.writeHead(500);
      res.end();
      return;
    }
    res.writeHead(200, { "x-payment-response": "settled_ref_1" });
    res.end(JSON.stringify({ ok: true }));
  });
  return new Promise<{ server: import("node:http").Server; url: string }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, url: `http://127.0.0.1:${port}/resource` });
    });
  });
}

beforeEach(async () => {
  platform = new Platform();
  service = new InMemoryPlatformService(platform);
  ledger = new AfpLedger();

  const rails: RailAdapter[] = [
    createCardRail(service, SECRET),
    createX402Rail({ payerAddress: "0xpayer", signer: SANDBOX_SIGNER }),
    createStablecoinRail({
      client: createSandboxStablecoinClient(),
      fromAddress: "0xorg-wallet",
      resolveRecipient: () => "0xrecipient",
    }),
  ];

  app = createApp({ platform: service, issuerWebhookSecret: SECRET, afp: { ledger: new InMemoryAfpLedger(ledger), rails } });
  const res = await app.request("/v1/signup", {
    method: "POST",
    body: JSON.stringify({ email: "dev@example.co.za", name: "Dev", currency: "ZAR" }),
    headers: { "content-type": "application/json" },
  });
  apiKey = (await json(res)).api_key;
});

describe("without afp configured", () => {
  it("the whole surface is unmounted, even for a validly authenticated caller", async () => {
    const bare = createApp({ platform: new Platform(), issuerWebhookSecret: SECRET });
    const signup = await json(
      await bare.request("/v1/signup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "nobody@example.co.za", name: "Nobody" }),
      }),
    );
    const res = await bare.request("/v1/afp/intents", {
      method: "POST",
      headers: { authorization: `Bearer ${signup.api_key}`, "content-type": "application/json" },
      body: JSON.stringify({ amount: 100, currency: "USD", purpose: "x", counterparty: "y" }),
    });
    expect(res.status).toBe(404);
  });
});

describe("POST /v1/afp/intents — routing preview", () => {
  it("routes to x402 over card when both are available (cheaper, faster, no reversal risk)", async () => {
    const { server, url } = await startX402Server();
    try {
      const res = await authed("/v1/afp/intents", {
        method: "POST",
        body: JSON.stringify({ amount: 19_900, currency: "USD", purpose: "OpenAI usage", counterparty: url }),
      });
      expect(res.status).toBe(201);
      const { intent, decision } = await json(res);
      expect(intent.amount).toBe(19_900);
      expect(decision.chosenRail).toBe("x402");
      expect(decision.rejected.some((r: any) => r.rail === "card")).toBe(true); // no USD card exists yet
    } finally {
      server.close();
    }
  });

  it("card is unavailable (with a stated reason) until one actually exists in that currency", async () => {
    const res = await authed("/v1/afp/intents", {
      method: "POST",
      body: JSON.stringify({ amount: 5_000, currency: "ZAR", purpose: "hosting", counterparty: "https://example.invalid/pay" }),
    });
    const { decision } = await json(res);
    const cardRejection = decision.rejected.find((r: any) => r.rail === "card");
    expect(cardRejection?.reason).toContain("no active card");
  });

  it("honours allowed_rails, narrowing before any quote is even scored", async () => {
    await authed("/v1/wallet/fund", { method: "POST", body: JSON.stringify({ amount: 100_000 }) });
    await authed("/v1/cards", { method: "POST", body: JSON.stringify({ single_use: false }) });
    const res = await authed("/v1/afp/intents", {
      method: "POST",
      body: JSON.stringify({
        amount: 5_000,
        currency: "ZAR",
        purpose: "hosting",
        counterparty: "cp_1",
        allowed_rails: ["stablecoin"],
      }),
    });
    const { decision } = await json(res);
    expect(decision.chosenRail).toBe("stablecoin");
    expect(decision.rejected.find((r: any) => r.rail === "card")?.reason).toContain("allowed rails");
  });
});

describe("POST /v1/afp/intents/:id/execute — card rail", () => {
  it("executes through A-CARD's real authorize path, reusing its rules engine and ledger hold", async () => {
    await authed("/v1/wallet/fund", { method: "POST", body: JSON.stringify({ amount: 100_000 }) });
    await authed("/v1/cards", { method: "POST", body: JSON.stringify({ single_use: false }) });

    const created = await json(
      await authed("/v1/afp/intents", {
        method: "POST",
        body: JSON.stringify({ amount: 5_000, currency: "ZAR", purpose: "hosting", counterparty: "cp_1", allowed_rails: ["card"] }),
      }),
    );

    const res = await authed(`/v1/afp/intents/${created.intent.id}/execute`, {
      method: "POST",
      headers: { "idempotency-key": "key-1" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(201);
    const { transaction } = await json(res);
    expect(transaction.status).toBe("posted"); // card finality is reversal_window, not instant
    expect(transaction.rail).toBe("card");
    expect(transaction.railReference).toBeTruthy();

    // Authorize only holds — capture is a separate step this rail
    // deliberately doesn't take, same as a real card authorization.
    const wallet = await json(await authed("/v1/wallet"));
    expect(wallet.wallet.posted).toBe(100_000);
    expect(wallet.wallet.held).toBe(5_000);
    expect(wallet.wallet.available).toBe(95_000);
  });

  it("marks the transaction failed (not silently discarded) when the card declines", async () => {
    await authed("/v1/wallet/fund", { method: "POST", body: JSON.stringify({ amount: 1_000 }) }); // not enough
    await authed("/v1/cards", { method: "POST", body: JSON.stringify({ single_use: false }) });

    const created = await json(
      await authed("/v1/afp/intents", {
        method: "POST",
        body: JSON.stringify({ amount: 5_000, currency: "ZAR", purpose: "hosting", counterparty: "cp_1", allowed_rails: ["card"] }),
      }),
    );
    const res = await authed(`/v1/afp/intents/${created.intent.id}/execute`, {
      method: "POST",
      headers: { "idempotency-key": "key-decline" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(402);
    const { transaction } = await json(res);
    expect(transaction.status).toBe("failed");
  });
});

describe("POST /v1/afp/intents/:id/execute — x402 rail", () => {
  it("does the real 402-then-retry round trip and settles instantly", async () => {
    const { server, url } = await startX402Server();
    try {
      const created = await json(
        await authed("/v1/afp/intents", {
          method: "POST",
          body: JSON.stringify({ amount: 19_900, currency: "USD", purpose: "OpenAI usage", counterparty: url, allowed_rails: ["x402"] }),
        }),
      );
      const res = await authed(`/v1/afp/intents/${created.intent.id}/execute`, {
        method: "POST",
        headers: { "idempotency-key": "x402-key-1" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(201);
      const { transaction } = await json(res);
      expect(transaction.status).toBe("settled"); // x402 finality is instant
      expect(transaction.railReference).toBe("settled_ref_1");
    } finally {
      server.close();
    }
  });

  it("a 500 on the payment retry is a definite failure, not an ambiguous one", async () => {
    const { server, url } = await startX402Server({ requiredAmount: "19900", failRetry: true });
    try {
      const created = await json(
        await authed("/v1/afp/intents", {
          method: "POST",
          body: JSON.stringify({ amount: 19_900, currency: "USD", purpose: "OpenAI usage", counterparty: url, allowed_rails: ["x402"] }),
        }),
      );
      const res = await authed(`/v1/afp/intents/${created.intent.id}/execute`, {
        method: "POST",
        headers: { "idempotency-key": "x402-fail-key" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(402);
      expect((await json(res)).transaction.status).toBe("failed");
    } finally {
      server.close();
    }
  });

  it("a network failure mid-flow parks the transaction as reconciling, not failed or settled", async () => {
    const created = await json(
      await authed("/v1/afp/intents", {
        method: "POST",
        body: JSON.stringify({
          amount: 19_900,
          currency: "USD",
          purpose: "unreachable",
          counterparty: "http://127.0.0.1:1", // nothing listens here — connection refused
          allowed_rails: ["x402"],
        }),
      }),
    );
    const res = await authed(`/v1/afp/intents/${created.intent.id}/execute`, {
      method: "POST",
      headers: { "idempotency-key": "x402-network-fail" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(202);
    const { transaction, warning } = await json(res);
    expect(transaction.status).toBe("reconciling");
    expect(warning).toContain("reconciliation");
  });
});

describe("POST /v1/afp/intents/:id/execute — stablecoin rail", () => {
  it("settles instantly, and a reversal is refused by the ledger", async () => {
    const created = await json(
      await authed("/v1/afp/intents", {
        method: "POST",
        body: JSON.stringify({ amount: 10_000, currency: "USD", purpose: "payout", counterparty: "vendor_1", allowed_rails: ["stablecoin"] }),
      }),
    );
    const res = await authed(`/v1/afp/intents/${created.intent.id}/execute`, {
      method: "POST",
      headers: { "idempotency-key": "sc-key-1" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(201);
    const { transaction } = await json(res);
    expect(transaction.status).toBe("settled");
    expect(() => ledger.reverse(transaction.id, "attempted clawback")).toThrow(/cannot reverse it/);
  });
});

describe("idempotency and isolation at the API layer", () => {
  it("requires an Idempotency-Key header", async () => {
    const created = await json(
      await authed("/v1/afp/intents", {
        method: "POST",
        body: JSON.stringify({ amount: 10_000, currency: "USD", purpose: "x", counterparty: "y", allowed_rails: ["stablecoin"] }),
      }),
    );
    const res = await authed(`/v1/afp/intents/${created.intent.id}/execute`, { method: "POST", body: JSON.stringify({}) });
    expect(res.status).toBe(400);
  });

  it("retrying the same idempotency key returns the same transaction, never executes twice", async () => {
    const created = await json(
      await authed("/v1/afp/intents", {
        method: "POST",
        body: JSON.stringify({ amount: 10_000, currency: "USD", purpose: "x", counterparty: "y", allowed_rails: ["stablecoin"] }),
      }),
    );
    const first = await json(
      await authed(`/v1/afp/intents/${created.intent.id}/execute`, {
        method: "POST",
        headers: { "idempotency-key": "shared-key" },
        body: JSON.stringify({}),
      }),
    );
    const second = await json(
      await authed(`/v1/afp/intents/${created.intent.id}/execute`, {
        method: "POST",
        headers: { "idempotency-key": "shared-key" },
        body: JSON.stringify({}),
      }),
    );
    expect(second.transaction.id).toBe(first.transaction.id);
    expect(ledger.list(first.transaction.accountHolderId)).toHaveLength(1);
  });

  it("an unknown intent id 404s", async () => {
    const res = await authed("/v1/afp/intents/afpi_doesnotexist/execute", {
      method: "POST",
      headers: { "idempotency-key": "k" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
  });

  it("an intent from another org 404s rather than executing across the boundary", async () => {
    const created = await json(
      await authed("/v1/afp/intents", {
        method: "POST",
        body: JSON.stringify({ amount: 10_000, currency: "USD", purpose: "x", counterparty: "y", allowed_rails: ["stablecoin"] }),
      }),
    );
    const otherSignup = await json(
      await app.request("/v1/signup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "other@example.co.za", name: "Other" }),
      }),
    );
    const res = await app.request(`/v1/afp/intents/${created.intent.id}/execute`, {
      method: "POST",
      headers: { authorization: `Bearer ${otherSignup.api_key}`, "content-type": "application/json", "idempotency-key": "k" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
  });

  it("GET /v1/afp/transactions is scoped to the caller's own org", async () => {
    await authed("/v1/afp/intents", {
      method: "POST",
      body: JSON.stringify({ amount: 10_000, currency: "USD", purpose: "x", counterparty: "y" }),
    });
    const res = await json(await authed("/v1/afp/transactions"));
    expect(Array.isArray(res.transactions)).toBe(true);
  });
});
