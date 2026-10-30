import { createServer, type IncomingMessage, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AfpLedger, Platform } from "@acard/core";
import { privateKeyToAccount } from "viem/accounts";
import { recoverTypedDataAddress } from "viem";
import { createApp } from "../src/app.js";
import { InMemoryAfpLedger } from "../src/afp/index.js";
import { InMemoryPlatformService } from "../src/service/index.js";
import { createCardRail, createX402Rail } from "../src/rails/index.js";
import {
  assertFetchableUrl,
  atomicToUsd,
  chooseRequirement,
  createEip3009Signer,
  createX402Payer,
  isPrivateAddress,
  paymentHeader,
  readPaymentRequired,
  readSettlement,
  SANDBOX_SIGNER,
  usdToAtomic,
  USDC_BY_NETWORK,
  type PaymentRequirement,
} from "../src/x402/index.js";

/**
 * x402 under A-CARD's controls. The counterparty is a real HTTP server on a
 * real socket that speaks x402 v2 (or v1) and checks the payment header it
 * receives, so every "paid" below means a structurally valid payment arrived.
 */

const SECRET = "whsec_x402_test";
const SEPOLIA = "eip155:84532";
const USDC = USDC_BY_NETWORK[SEPOLIA]!.address;
const PAY_TO = "0x1111111111111111111111111111111111111111";
const PAYER = "0x2222222222222222222222222222222222222222";
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64");
const unb64 = (v: string) => JSON.parse(Buffer.from(v, "base64").toString("utf8"));

interface ServerOptions {
  /** Atomic units per request, as the server quotes it. */
  price: string;
  version?: 1 | 2;
  /** What to do with a paid request. */
  onPaid?: "ok" | "reject" | "error";
  free?: boolean;
}

interface Counterparty {
  url: string;
  unpaid: number;
  paid: Array<Record<string, any>>;
  close: () => void;
}

async function startCounterparty(opts: ServerOptions): Promise<Counterparty> {
  const state = { unpaid: 0, paid: [] as Array<Record<string, any>> };
  const requirement = (host: string) =>
    opts.version === 1
      ? {
          scheme: "exact",
          network: "base-sepolia",
          maxAmountRequired: opts.price,
          resource: `http://${host}/report`,
          asset: USDC,
          payTo: PAY_TO,
          maxTimeoutSeconds: 60,
          extra: { name: "USDC", version: "2" },
        }
      : { scheme: "exact", network: SEPOLIA, amount: opts.price, asset: USDC, payTo: PAY_TO, maxTimeoutSeconds: 60, extra: { name: "USDC", version: "2" } };

  const server: Server = createServer((req: IncomingMessage, res) => {
    const host = req.headers.host!;
    if (opts.free) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ free: true }));
      return;
    }
    const header = (opts.version === 1 ? req.headers["x-payment"] : req.headers["payment-signature"]) as string | undefined;
    if (!header) {
      state.unpaid++;
      if (opts.version === 1) {
        res.writeHead(402, { "content-type": "application/json" });
        res.end(JSON.stringify({ x402Version: 1, error: "payment required", accepts: [requirement(host)] }));
      } else {
        res.writeHead(402, {
          "payment-required": b64({ x402Version: 2, resource: { url: `http://${host}/report` }, accepts: [requirement(host)] }),
        });
        res.end("{}");
      }
      return;
    }
    const payment = unb64(header);
    state.paid.push(payment);
    // What a facilitator's /verify would check structurally.
    const auth = payment.payload?.authorization;
    const accepted = opts.version === 1 ? requirement(host) : payment.accepted;
    const valid =
      auth &&
      auth.to === PAY_TO &&
      auth.value === opts.price &&
      /^0x[0-9a-f]{64}$/.test(auth.nonce) &&
      Number(auth.validBefore) > Date.now() / 1000 &&
      (opts.version === 1 ? payment.network === "base-sepolia" : JSON.stringify(accepted) === JSON.stringify(requirement(host)));
    if (!valid || opts.onPaid === "reject") {
      res.writeHead(402, { "payment-response": b64({ success: false, errorReason: "invalid_payload", transaction: "", network: SEPOLIA }) });
      res.end("{}");
      return;
    }
    if (opts.onPaid === "error") {
      res.writeHead(500);
      res.end();
      return;
    }
    const settlement = { success: true, transaction: `0x${"ab".repeat(32)}`, network: SEPOLIA, payer: auth.from };
    res.writeHead(200, {
      "content-type": "application/json",
      [opts.version === 1 ? "x-payment-response" : "payment-response"]: b64(settlement),
    });
    res.end(JSON.stringify({ report: "q3 freight rates", rows: 42 }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}/report`,
    get unpaid() {
      return state.unpaid;
    },
    get paid() {
      return state.paid;
    },
    close: () => server.close(),
  };
}

let app: ReturnType<typeof createApp>;
let session: string;
let counterparty: Counterparty | undefined;

const json = async (res: Response) => res.json() as Promise<any>;
const api = (path: string, init: RequestInit = {}) =>
  app.request(path, { ...init, headers: { authorization: `Bearer ${session}`, "content-type": "application/json", ...(init.headers ?? {}) } });
let keySeq = 0;
const pay = (body: Record<string, unknown>, key = `k${++keySeq}`) =>
  api("/v1/afp/x402/pay", { method: "POST", headers: { "idempotency-key": key }, body: JSON.stringify(body) });
const card = async (body: Record<string, unknown>) =>
  (await json(await api("/v1/cards", { method: "POST", body: JSON.stringify({ currency: "USD", single_use: false, ...body }) }))).card;
const usdWallet = async () => (await json(await api("/v1/wallet?currency=USD"))).wallet;

function build(opts: { allowPrivateNetworks?: boolean } = { allowPrivateNetworks: true }) {
  const platform = new Platform();
  const service = new InMemoryPlatformService(platform);
  const ledger = new InMemoryAfpLedger(new AfpLedger());
  const x402Config = { signer: SANDBOX_SIGNER, payerAddress: PAYER, networks: [SEPOLIA], allowPrivateNetworks: opts.allowPrivateNetworks };
  app = createApp({
    platform: service,
    issuerWebhookSecret: SECRET,
    afp: { ledger, rails: [createCardRail(service, SECRET), createX402Rail(x402Config)], x402: createX402Payer(service, ledger, x402Config) },
  });
  return platform;
}

beforeEach(async () => {
  const platform = build();
  const reg = await app.request("/v1/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "ops@x402.example", name: "X402 Co", password: "x402-test-password", currency: "USD", account_type: "enterprise" }),
  });
  session = (await json(reg)).session_token;
  const holderId = (await json(await api("/v1/auth/me"))).account_holder.id;
  platform.setSubscriptionTier(holderId, "enterprise");
  await api("/v1/wallet/fund", { method: "POST", body: JSON.stringify({ amount: 100_000, currency: "USD" }) }); // $1 000
});

afterEach(() => {
  counterparty?.close();
  counterparty = undefined;
});

// ---- protocol ------------------------------------------------------------------------

describe("x402 protocol", () => {
  it("reads a v2 PAYMENT-REQUIRED header and a v1 body, normalising networks and amounts", async () => {
    const v2 = await readPaymentRequired(
      new Response("{}", {
        status: 402,
        headers: { "payment-required": b64({ x402Version: 2, accepts: [{ scheme: "exact", network: SEPOLIA, amount: "1000", asset: USDC, payTo: PAY_TO, maxTimeoutSeconds: 30 }] }) },
      }),
    );
    expect(v2?.version).toBe(2);
    expect(v2?.accepts[0]).toMatchObject({ network: SEPOLIA, amount: "1000" });

    const v1 = await readPaymentRequired(
      new Response(JSON.stringify({ x402Version: 1, accepts: [{ scheme: "exact", network: "base", maxAmountRequired: "50000", asset: USDC_BY_NETWORK["eip155:8453"]!.address, payTo: PAY_TO }] }), { status: 402 }),
    );
    expect(v1?.version).toBe(1);
    expect(v1?.accepts[0]).toMatchObject({ network: "eip155:8453", amount: "50000" });

    expect(await readPaymentRequired(new Response("not x402", { status: 402 }))).toBeUndefined();
  });

  it("chooses the cheapest USDC 'exact' option on an allowed network, and nothing else", async () => {
    const opt = (network: string, amount: string, asset = USDC_BY_NETWORK[network]?.address ?? "0xdead", scheme = "exact") =>
      ({ scheme, network, amount, asset, payTo: PAY_TO, maxTimeoutSeconds: 60, raw: {} }) as PaymentRequirement;
    const required = {
      version: 2 as const,
      accepts: [opt(SEPOLIA, "900"), opt(SEPOLIA, "500", "0x00000000000000000000000000000000000000aa"), opt(SEPOLIA, "700", undefined, "upto"), opt("eip155:8453", "100"), opt(SEPOLIA, "800")],
    };
    expect(chooseRequirement(required, [SEPOLIA])?.amount).toBe("800"); // not the fake token, not "upto", not mainnet
    expect(chooseRequirement(required, ["eip155:8453", SEPOLIA])?.amount).toBe("100");
    expect(chooseRequirement(required, ["eip155:1"])).toBeUndefined();
  });

  it("builds the v2 PAYMENT-SIGNATURE (echoing the requirement verbatim) and the v1 X-PAYMENT", () => {
    const raw = { scheme: "exact", network: SEPOLIA, amount: "1000", asset: USDC, payTo: PAY_TO, maxTimeoutSeconds: 60, extra: { name: "USDC", version: "2" } };
    const requirement = { ...raw, raw } as PaymentRequirement;
    const authorization = { from: PAYER, to: PAY_TO, value: "1000", validAfter: "0", validBefore: "9999999999", nonce: `0x${"00".repeat(32)}` };
    const v2 = paymentHeader({ version: 2, resource: { url: "https://x/y" }, accepts: [requirement] }, requirement, authorization, "0xsig");
    expect(v2.name).toBe("PAYMENT-SIGNATURE");
    expect(unb64(v2.value)).toEqual({ x402Version: 2, resource: { url: "https://x/y" }, accepted: raw, payload: { signature: "0xsig", authorization } });
    const v1 = paymentHeader({ version: 1, accepts: [{ ...requirement, raw: { ...raw, network: "base-sepolia" } }] }, { ...requirement, raw: { ...raw, network: "base-sepolia" } }, authorization, "0xsig");
    expect(v1.name).toBe("X-PAYMENT");
    expect(unb64(v1.value)).toMatchObject({ x402Version: 1, scheme: "exact", network: "base-sepolia" });
  });

  it("reads settlement from PAYMENT-RESPONSE or X-PAYMENT-RESPONSE", () => {
    expect(readSettlement(new Response(null, { headers: { "payment-response": b64({ success: true, transaction: "0xabc", network: SEPOLIA }) } }))).toMatchObject({ success: true, transaction: "0xabc" });
    expect(readSettlement(new Response(null, { headers: { "x-payment-response": b64({ success: true, transaction: "0xdef" }) } }))?.transaction).toBe("0xdef");
    expect(readSettlement(new Response(null))).toBeUndefined();
  });

  it("converts dollars and USDC atomic units exactly", () => {
    expect(usdToAtomic("0.05")).toBe(50_000n);
    expect(usdToAtomic("2")).toBe(2_000_000n);
    expect(usdToAtomic("0.000001")).toBe(1n);
    expect(() => usdToAtomic("-1")).toThrow();
    expect(() => usdToAtomic("0.0000001")).toThrow();
    expect(atomicToUsd(1_234_567n)).toBe("1.234567");
  });
});

// ---- signer --------------------------------------------------------------------------

describe("EIP-3009 signer", () => {
  it("matches viem's independent EIP-712 implementation, byte for byte", async () => {
    const key = `0x${"4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318"}`;
    const signer = createEip3009Signer(key);
    const account = privateKeyToAccount(key as `0x${string}`);
    expect(signer.address).toBe(account.address);

    const raw = { scheme: "exact", network: SEPOLIA, amount: "12345", asset: USDC, payTo: PAY_TO, maxTimeoutSeconds: 60, extra: { name: "USDC", version: "2" } };
    const authorization = { from: signer.address, value: "12345", validAfter: "1700000000", validBefore: "1700000600", nonce: `0x${"7f".repeat(32)}` };
    const { signature } = await signer.sign({ requirement: { ...raw, raw } as PaymentRequirement, ...authorization });

    const typedData = {
      domain: { name: "USDC", version: "2", chainId: 84532, verifyingContract: USDC as `0x${string}` },
      types: {
        TransferWithAuthorization: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "validAfter", type: "uint256" },
          { name: "validBefore", type: "uint256" },
          { name: "nonce", type: "bytes32" },
        ],
      },
      primaryType: "TransferWithAuthorization" as const,
      message: {
        from: signer.address as `0x${string}`,
        to: PAY_TO as `0x${string}`,
        value: 12345n,
        validAfter: 1700000000n,
        validBefore: 1700000600n,
        nonce: `0x${"7f".repeat(32)}` as `0x${string}`,
      },
    };
    expect(signature).toBe(await account.signTypedData(typedData));
    expect(await recoverTypedDataAddress({ ...typedData, signature: signature as `0x${string}` })).toBe(signer.address);
  });

  it("a real signer reports real value; the sandbox one doesn't", () => {
    expect(createX402Rail({ payerAddress: PAYER, signer: createEip3009Signer(`0x${"11".repeat(32)}`) }).carriesRealValue).toBe(true);
    expect(createX402Rail({ payerAddress: PAYER, signer: SANDBOX_SIGNER }).carriesRealValue).toBe(false);
  });
});

// ---- URL guard ---------------------------------------------------------------------------

describe("URL guard (no server-side request forgery)", () => {
  it("knows private and reserved addresses", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1"]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"]) expect(isPrivateAddress(ip), ip).toBe(false);
  });

  it("refuses plain HTTP, private hosts and embedded credentials unless explicitly sandboxed", async () => {
    await expect(assertFetchableUrl("http://example.com/x")).rejects.toThrow(/HTTPS/);
    await expect(assertFetchableUrl("https://127.0.0.1/x")).rejects.toThrow(/private/);
    await expect(assertFetchableUrl("https://[::1]/x")).rejects.toThrow(/private/);
    await expect(assertFetchableUrl("https://169.254.169.254/latest/meta-data")).rejects.toThrow(/private/);
    await expect(assertFetchableUrl("https://user:pw@8.8.8.8/x")).rejects.toThrow(/credentials/);
    await expect(assertFetchableUrl("https://8.8.8.8/x")).resolves.toBeInstanceOf(URL);
    await expect(assertFetchableUrl("http://127.0.0.1:9/x", { allowPrivateNetworks: true })).resolves.toBeInstanceOf(URL);
  });

  it("the pay endpoint refuses a private URL when the deployment isn't sandboxed", async () => {
    build({ allowPrivateNetworks: false });
    const reg = await app.request("/v1/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "b@x402.example", name: "B", password: "x402-test-password", currency: "USD" }),
    });
    session = (await json(reg)).session_token;
    const c = await card({});
    const res = await pay({ card_id: c.id, url: "http://127.0.0.1:9/admin", max_usd: "1" });
    expect(res.status).toBe(422);
    expect((await json(res)).error.code).toBe("x402_url_not_allowed");
  });
});

// ---- governed payments -----------------------------------------------------------------------

describe("POST /v1/afp/x402/pay", () => {
  it("pays a v2 server and returns the resource, with the settlement and a captured card charge", async () => {
    counterparty = await startCounterparty({ price: "25000" }); // $0.025
    const c = await card({ allowed_merchant_categories: ["x402"] });
    const res = await pay({ card_id: c.id, url: counterparty.url, max_usd: "0.05" });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.status).toBe("paid");
    expect(body.price).toMatchObject({ amount_atomic: "25000", usd: "0.025000", network: SEPOLIA });
    expect(body.charged_cents).toBe(3); // 2.5 cents, rounded up; the half cent is credit
    expect(body.tab).toMatchObject({ payments: 1, paid_atomic: "25000", charged_cents: 3, credit_atomic: "5000" });
    expect(body.settlement.transaction).toBe(`0x${"ab".repeat(32)}`);
    expect(body.transaction).toMatchObject({ rail: "x402", status: "settled", railReference: `0x${"ab".repeat(32)}` });
    expect(JSON.parse(body.resource.body)).toEqual({ report: "q3 freight rates", rows: 42 });
    expect(counterparty.paid).toHaveLength(1);
    expect(counterparty.paid[0]!.payload.authorization.from).toBe(PAYER);

    const txns = (await json(await api(`/v1/transactions?card_id=${c.id}`))).transactions;
    expect(txns).toHaveLength(1);
    expect(txns[0]).toMatchObject({ type: "capture", status: "completed", amount: 3, merchantName: `x402 · 127.0.0.1`, merchantCategory: "x402" });
    expect((await usdWallet()).available).toBe(100_000 - 3);
  });

  it("charges sub-cent prices through the tab: twelve $0.001 calls are two 1-cent charges", async () => {
    counterparty = await startCounterparty({ price: "1000" });
    const c = await card({});
    const charged: number[] = [];
    for (let i = 0; i < 12; i++) {
      const body = await json(await pay({ card_id: c.id, url: counterparty.url, max_usd: "0.01" }));
      expect(body.status).toBe("paid");
      charged.push(body.charged_cents);
    }
    expect(charged).toEqual([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0]);
    const tab = (await json(await api(`/v1/afp/x402/tabs/${c.id}`))).tab;
    expect(tab).toEqual({ card_id: c.id, payments: 12, paid_atomic: "12000", paid_usd: "0.012000", charged_cents: 2, credit_atomic: "8000" });
    expect((await usdWallet()).available).toBe(100_000 - 2);
    expect(counterparty.paid).toHaveLength(12);
  });

  it("speaks v1 (X-PAYMENT / X-PAYMENT-RESPONSE) too", async () => {
    counterparty = await startCounterparty({ price: "10000", version: 1 });
    const c = await card({});
    const body = await json(await pay({ card_id: c.id, url: counterparty.url, max_usd: "0.01" }));
    expect(body.status).toBe("paid");
    expect(body.charged_cents).toBe(1);
    expect(counterparty.paid[0]).toMatchObject({ x402Version: 1, network: "base-sepolia" });
  });

  it("a free resource is fetched and charged nothing", async () => {
    counterparty = await startCounterparty({ price: "0", free: true });
    const c = await card({});
    const body = await json(await pay({ card_id: c.id, url: counterparty.url, max_usd: "0.01" }));
    expect(body.status).toBe("free");
    expect(body.resource.status).toBe(200);
  });

  it("a card whose categories don't include x402 is refused before the host is contacted", async () => {
    counterparty = await startCounterparty({ price: "1000" });
    const fuel = await card({ allowed_merchant_categories: ["5541"] });
    const body = await json(await pay({ card_id: fuel.id, url: counterparty.url, max_usd: "1" }));
    expect(body).toMatchObject({ status: "declined", decline_reason: "merchant_category_not_allowed" });
    expect(counterparty.unpaid).toBe(0);
  });

  it("a host outside the card's x402 allow-list is refused before it is contacted", async () => {
    counterparty = await startCounterparty({ price: "1000" });
    const c = await card({ x402_allowed_hosts: ["api.freight-data.example"] });
    expect(c.x402AllowedHosts).toEqual(["api.freight-data.example"]);
    const body = await json(await pay({ card_id: c.id, url: counterparty.url, max_usd: "1" }));
    expect(body).toMatchObject({ status: "declined", decline_reason: "x402_host_not_allowed" });
    expect(counterparty.unpaid).toBe(0);
  });

  it("a price above the agent's own max is refused, unsigned and uncharged", async () => {
    counterparty = await startCounterparty({ price: "50000" }); // $0.05
    const c = await card({});
    const body = await json(await pay({ card_id: c.id, url: counterparty.url, max_usd: "0.01" }));
    expect(body).toMatchObject({ status: "declined", decline_reason: "x402_price_above_max", price: { usd: "0.050000" } });
    expect(counterparty.paid).toHaveLength(0);
    expect((await usdWallet()).available).toBe(100_000);
  });

  it("the card's per-transaction limit applies to the exact price", async () => {
    counterparty = await startCounterparty({ price: "1500000" }); // $1.50
    const c = await card({ limits: { per_transaction: 100 } });
    const body = await json(await pay({ card_id: c.id, url: counterparty.url, max_usd: "5" }));
    expect(body).toMatchObject({ status: "declined", decline_reason: "per_transaction_limit_exceeded" });
    expect(counterparty.paid).toHaveLength(0);
  });

  it("over the card's approval threshold it is held for a person; after approval the retry pays, once", async () => {
    counterparty = await startCounterparty({ price: "2500000" }); // $2.50
    const c = await card({ approval_threshold: 200 });
    const held = await json(await pay({ card_id: c.id, url: counterparty.url, max_usd: "3" }));
    expect(held).toMatchObject({ status: "held", decline_reason: "pending_human_approval" });
    expect(held.approval_id).toMatch(/^appr_/);
    expect(counterparty.paid).toHaveLength(0);

    const approved = await api(`/v1/approvals/${held.approval_id}/approve`, { method: "POST" });
    expect(approved.status).toBe(200);

    const retried = await json(await pay({ card_id: c.id, url: counterparty.url, max_usd: "3" }));
    expect(retried).toMatchObject({ status: "paid", charged_cents: 250 });
    expect(counterparty.paid).toHaveLength(1);

    const again = await json(await pay({ card_id: c.id, url: counterparty.url, max_usd: "3" }));
    expect(again.status).toBe("held"); // the approval was for one purchase
  });

  it("org policy that blocks the x402 category stops it on every card", async () => {
    counterparty = await startCounterparty({ price: "1000" });
    await api("/v1/policy", { method: "PUT", body: JSON.stringify({ blocked_merchant_categories: ["x402"] }) });
    const c = await card({});
    const body = await json(await pay({ card_id: c.id, url: counterparty.url, max_usd: "1" }));
    expect(body).toMatchObject({ status: "declined", decline_reason: "merchant_category_blocked_by_policy" });
    expect(counterparty.paid).toHaveLength(0);
  });

  it("a refused payment releases the hold and fails the transaction", async () => {
    counterparty = await startCounterparty({ price: "40000", onPaid: "reject" });
    const c = await card({});
    const body = await json(await pay({ card_id: c.id, url: counterparty.url, max_usd: "1" }));
    expect(body).toMatchObject({ status: "failed", decline_reason: "x402_payment_rejected", message: "invalid_payload" });
    expect(body.transaction.status).toBe("failed");
    expect((await usdWallet()).available).toBe(100_000);
    expect((await json(await api(`/v1/afp/x402/tabs/${c.id}`))).tab).toMatchObject({ payments: 0, charged_cents: 0 });
  });

  it("a server error after the signed payment is unknown: the hold stays and the payment is parked", async () => {
    counterparty = await startCounterparty({ price: "40000", onPaid: "error" });
    const c = await card({});
    const res = await pay({ card_id: c.id, url: counterparty.url, max_usd: "1" });
    expect(res.status).toBe(202);
    const body = await json(res);
    expect(body).toMatchObject({ status: "reconciling" });
    expect(body.transaction.status).toBe("reconciling");
    expect((await usdWallet()).held).toBe(4);
  });

  it("the same Idempotency-Key pays once", async () => {
    counterparty = await startCounterparty({ price: "10000" });
    const c = await card({});
    const first = await json(await pay({ card_id: c.id, url: counterparty.url, max_usd: "1" }, "same-key"));
    const second = await json(await pay({ card_id: c.id, url: counterparty.url, max_usd: "1" }, "same-key"));
    expect(first.status).toBe("paid");
    expect(second.transaction.id).toBe(first.transaction.id);
    expect(counterparty.paid).toHaveLength(1);
  });

  it("requires an Idempotency-Key and an explicit max_usd", async () => {
    const c = await card({});
    const noKey = await api("/v1/afp/x402/pay", { method: "POST", body: JSON.stringify({ card_id: c.id, url: "http://127.0.0.1/x", max_usd: "1" }) });
    expect(noKey.status).toBe(400);
    expect((await json(noKey)).error.code).toBe("idempotency_key_required");
    const noMax = await pay({ card_id: c.id, url: "http://127.0.0.1/x" });
    expect(noMax.status).toBe(400);
  });

  it("another org's card is not found", async () => {
    const c = await card({});
    const reg = await app.request("/v1/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "other@x402.example", name: "Other", password: "x402-test-password", currency: "USD" }),
    });
    session = (await json(reg)).session_token;
    const res = await pay({ card_id: c.id, url: "http://127.0.0.1/x", max_usd: "1" });
    expect(res.status).toBe(404);
  });
});
