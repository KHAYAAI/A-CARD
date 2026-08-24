import { describe, expect, it } from "vitest";
import { Platform } from "@acard/core";
import { createApp } from "../src/app.js";
import { RealPayFastClient, type PayFastClient, type PayFastItn } from "../src/payfast.js";

/**
 * Two layers: the signing scheme itself (order-sensitive MD5, not the
 * network-dependent host/confirm-back checks — those need a real PayFast
 * sandbox), and the HTTP wiring — instant funding disabled once PayFast is
 * configured, checkout builds a signed form, and the ITN webhook only
 * credits the wallet through `validateItn`, never on signature alone.
 */
const CONFIG = { merchantId: "10000100", merchantKey: "46f0cd694581a", passphrase: "test-passphrase" };
const SECRET = "whsec_test";

describe("PayFast signature scheme", () => {
  it("builds a checkout whose own signature it also verifies", () => {
    const client = new RealPayFastClient(CONFIG);
    const { fields } = client.buildCheckout({
      amountMinorUnits: 100_000,
      itemName: "A-CARD wallet top-up",
      reference: "ref_1",
      email: "dev@acard.co.za",
      returnUrl: "https://app.example.com/wallet?funded=1",
      cancelUrl: "https://app.example.com/wallet?funded=0",
      notifyUrl: "https://app.example.com/webhooks/payfast",
      customStr1: "ah_1",
    });
    expect(fields.amount).toBe("1000.00");
    expect(fields.signature).toMatch(/^[a-f0-9]{32}$/);

    const itn: PayFastItn = { fields, rawBody: "", remoteIp: "" };
    expect(client.verifyItnSignature(itn)).toBe(true);
  });

  it("rejects a tampered field (amount changed after signing)", () => {
    const client = new RealPayFastClient(CONFIG);
    const { fields } = client.buildCheckout({
      amountMinorUnits: 100_000,
      itemName: "Top-up",
      reference: "ref_2",
      email: "dev@acard.co.za",
      returnUrl: "https://x/y",
      cancelUrl: "https://x/y",
      notifyUrl: "https://x/webhooks/payfast",
    });
    const tampered = { ...fields, amount: "1.00" };
    expect(client.verifyItnSignature({ fields: tampered, rawBody: "", remoteIp: "" })).toBe(false);
  });

  it("is order-sensitive: the same fields signed in a different order don't match", () => {
    const client = new RealPayFastClient(CONFIG);
    const { fields } = client.buildCheckout({
      amountMinorUnits: 5_000,
      itemName: "Top-up",
      reference: "ref_3",
      email: "dev@acard.co.za",
      returnUrl: "https://x/y",
      cancelUrl: "https://x/y",
      notifyUrl: "https://x/webhooks/payfast",
    });
    const { signature, ...rest } = fields;
    const reordered = Object.fromEntries([...Object.entries(rest).reverse(), ["signature", signature]]) as Record<string, string>;
    expect(client.verifyItnSignature({ fields: reordered, rawBody: "", remoteIp: "" })).toBe(false);
  });

  it("differs between sandbox and live hosts on the checkout action URL", () => {
    const live = new RealPayFastClient(CONFIG).buildCheckout(minimalInput());
    const sandbox = new RealPayFastClient({ ...CONFIG, sandbox: true }).buildCheckout(minimalInput());
    expect(live.action).toBe("https://www.payfast.co.za/eng/process");
    expect(sandbox.action).toBe("https://sandbox.payfast.co.za/eng/process");
  });
});

function minimalInput() {
  return {
    amountMinorUnits: 1_000,
    itemName: "Top-up",
    reference: "ref",
    email: "dev@acard.co.za",
    returnUrl: "https://x/y",
    cancelUrl: "https://x/y",
    notifyUrl: "https://x/webhooks/payfast",
  };
}

function fakePayFast(overrides: Partial<PayFastClient> = {}): PayFastClient {
  return {
    buildCheckout: (input) => ({
      action: "https://sandbox.payfast.co.za/eng/process",
      fields: { merchant_id: CONFIG.merchantId, amount: (input.amountMinorUnits / 100).toFixed(2), signature: "fake" },
    }),
    validateItn: async () => true,
    ...overrides,
  };
}

async function json(res: Response) {
  return (await res.json()) as any;
}

function withToken(app: ReturnType<typeof createApp>, path: string, token: string, init: RequestInit = {}) {
  return app.request(path, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

describe("PayFast not configured (default)", () => {
  it("/v1/wallet/fund keeps the instant sandbox credit behavior", async () => {
    const app = createApp({ platform: new Platform(), issuerWebhookSecret: SECRET });
    const signup = await json(
      await app.request("/v1/signup", {
        method: "POST",
        body: JSON.stringify({ email: "dev@acard.co.za", name: "Dev" }),
        headers: { "content-type": "application/json" },
      }),
    );
    const res = await withToken(app, "/v1/wallet/fund", signup.api_key, { method: "POST", body: JSON.stringify({ amount: 1_000 }) });
    expect(res.status).toBe(201);
  });

  it("/v1/wallet/fund/checkout is 501", async () => {
    const app = createApp({ platform: new Platform(), issuerWebhookSecret: SECRET });
    const signup = await json(
      await app.request("/v1/signup", {
        method: "POST",
        body: JSON.stringify({ email: "dev@acard.co.za", name: "Dev" }),
        headers: { "content-type": "application/json" },
      }),
    );
    const res = await withToken(app, "/v1/wallet/fund/checkout", signup.api_key, { method: "POST", body: JSON.stringify({ amount: 1_000 }) });
    expect(res.status).toBe(501);
  });
});

describe("PayFast configured", () => {
  it("disables instant /v1/wallet/fund (would otherwise be free money once real funding is live)", async () => {
    const app = createApp({ platform: new Platform(), issuerWebhookSecret: SECRET, payfast: fakePayFast(), dashboardUrl: "https://app.example.com" });
    const signup = await json(
      await app.request("/v1/signup", {
        method: "POST",
        body: JSON.stringify({ email: "dev@acard.co.za", name: "Dev" }),
        headers: { "content-type": "application/json" },
      }),
    );
    const res = await withToken(app, "/v1/wallet/fund", signup.api_key, { method: "POST", body: JSON.stringify({ amount: 1_000 }) });
    expect(res.status).toBe(409);
    expect((await json(res)).error.code).toBe("instant_funding_disabled");
  });

  it("leaves instant funding available for non-ZAR currencies — PayFast only ever settles ZAR", async () => {
    const app = createApp({ platform: new Platform(), issuerWebhookSecret: SECRET, payfast: fakePayFast(), dashboardUrl: "https://app.example.com" });
    const signup = await json(
      await app.request("/v1/signup", {
        method: "POST",
        body: JSON.stringify({ email: "dev@acard.co.za", name: "Dev" }),
        headers: { "content-type": "application/json" },
      }),
    );
    const res = await withToken(app, "/v1/wallet/fund", signup.api_key, {
      method: "POST",
      body: JSON.stringify({ amount: 1_000, currency: "USD" }),
    });
    expect(res.status).toBe(201);
  });

  it("checkout returns a signed form the frontend can submit, with our own notify_url — never client-supplied", async () => {
    let captured: any;
    const app = createApp({
      platform: new Platform(),
      issuerWebhookSecret: SECRET,
      dashboardUrl: "https://app.example.com",
      payfast: fakePayFast({
        buildCheckout: (input) => {
          captured = input;
          return { action: "https://sandbox.payfast.co.za/eng/process", fields: { signature: "fake" } };
        },
      }),
    });
    const signup = await json(
      await app.request("/v1/signup", {
        method: "POST",
        body: JSON.stringify({ email: "dev@acard.co.za", name: "Dev" }),
        headers: { "content-type": "application/json" },
      }),
    );
    const res = await withToken(app, "/v1/wallet/fund/checkout", signup.api_key, { method: "POST", body: JSON.stringify({ amount: 250_000 }) });
    expect(res.status).toBe(200);
    const { action, fields } = await json(res);
    expect(action).toBe("https://sandbox.payfast.co.za/eng/process");
    expect(fields.signature).toBe("fake");
    expect(captured.notifyUrl).toBe("https://app.example.com/webhooks/payfast");
    expect(captured.amountMinorUnits).toBe(250_000);
  });

  it("credits the wallet on a valid, COMPLETE ITN, and only then", async () => {
    const app = createApp({
      platform: new Platform(),
      issuerWebhookSecret: SECRET,
      dashboardUrl: "https://app.example.com",
      payfast: fakePayFast(),
    });
    const signup = await json(
      await app.request("/v1/signup", {
        method: "POST",
        body: JSON.stringify({ email: "dev@acard.co.za", name: "Dev", currency: "ZAR" }),
        headers: { "content-type": "application/json" },
      }),
    );
    const before = await json(await withToken(app, "/v1/wallet", signup.api_key));
    expect(before.wallet.posted).toBe(0);

    const body = new URLSearchParams({
      m_payment_id: "pf_ref_1",
      pf_payment_id: "998877",
      payment_status: "COMPLETE",
      amount_gross: "1000.00",
      custom_str1: signup.account_holder.id,
      signature: "irrelevant-because-fake-validates-true",
    }).toString();

    const res = await app.request("/webhooks/payfast", { method: "POST", body, headers: { "content-type": "application/x-www-form-urlencoded" } });
    expect(res.status).toBe(200);

    const after = await json(await withToken(app, "/v1/wallet", signup.api_key));
    expect(after.wallet.posted).toBe(100_000);
  });

  it("rejects an ITN that fails validation, crediting nothing", async () => {
    const app = createApp({
      platform: new Platform(),
      issuerWebhookSecret: SECRET,
      dashboardUrl: "https://app.example.com",
      payfast: fakePayFast({ validateItn: async () => false }),
    });
    const signup = await json(
      await app.request("/v1/signup", {
        method: "POST",
        body: JSON.stringify({ email: "dev@acard.co.za", name: "Dev", currency: "ZAR" }),
        headers: { "content-type": "application/json" },
      }),
    );
    const body = new URLSearchParams({
      m_payment_id: "pf_ref_2",
      payment_status: "COMPLETE",
      amount_gross: "500.00",
      custom_str1: signup.account_holder.id,
      signature: "bad",
    }).toString();
    const res = await app.request("/webhooks/payfast", { method: "POST", body, headers: { "content-type": "application/x-www-form-urlencoded" } });
    expect(res.status).toBe(401);

    const after = await json(await withToken(app, "/v1/wallet", signup.api_key));
    expect(after.wallet.posted).toBe(0);
  });

  it("is idempotent on a replayed pf_payment_id", async () => {
    const app = createApp({
      platform: new Platform(),
      issuerWebhookSecret: SECRET,
      dashboardUrl: "https://app.example.com",
      payfast: fakePayFast(),
    });
    const signup = await json(
      await app.request("/v1/signup", {
        method: "POST",
        body: JSON.stringify({ email: "dev@acard.co.za", name: "Dev", currency: "ZAR" }),
        headers: { "content-type": "application/json" },
      }),
    );
    const body = new URLSearchParams({
      m_payment_id: "pf_ref_3",
      pf_payment_id: "998811",
      payment_status: "COMPLETE",
      amount_gross: "200.00",
      custom_str1: signup.account_holder.id,
      signature: "irrelevant",
    }).toString();

    await app.request("/webhooks/payfast", { method: "POST", body, headers: { "content-type": "application/x-www-form-urlencoded" } });
    const second = await app.request("/webhooks/payfast", { method: "POST", body, headers: { "content-type": "application/x-www-form-urlencoded" } });
    expect((await json(second)).duplicate).toBe(true);

    const after = await json(await withToken(app, "/v1/wallet", signup.api_key));
    expect(after.wallet.posted).toBe(20_000); // credited exactly once
  });
});

describe("PayFast subscription billing", () => {
  it("/v1/billing/checkout is 501 when PayFast isn't configured", async () => {
    const app = createApp({ platform: new Platform(), issuerWebhookSecret: SECRET });
    const signup = await json(
      await app.request("/v1/signup", {
        method: "POST",
        body: JSON.stringify({ email: "dev@acard.co.za", name: "Dev" }),
        headers: { "content-type": "application/json" },
      }),
    );
    const res = await withToken(app, "/v1/billing/checkout", signup.api_key, { method: "POST", body: JSON.stringify({ tier: "basic" }) });
    expect(res.status).toBe(501);
  });

  it("checkout tags the purpose as sub:<tier>, distinct from wallet funding", async () => {
    let captured: any;
    const app = createApp({
      platform: new Platform(),
      issuerWebhookSecret: SECRET,
      dashboardUrl: "https://app.example.com",
      payfast: fakePayFast({
        buildCheckout: (input) => {
          captured = input;
          return { action: "https://sandbox.payfast.co.za/eng/process", fields: { signature: "fake" } };
        },
      }),
    });
    const signup = await json(
      await app.request("/v1/signup", {
        method: "POST",
        body: JSON.stringify({ email: "dev@acard.co.za", name: "Dev" }),
        headers: { "content-type": "application/json" },
      }),
    );
    const res = await withToken(app, "/v1/billing/checkout", signup.api_key, { method: "POST", body: JSON.stringify({ tier: "pro" }) });
    expect(res.status).toBe(200);
    expect(captured.customStr2).toBe("sub:pro");
    expect(captured.customStr1).toBe(signup.account_holder.id);
    expect(captured.amountMinorUnits).toBe(2_800); // packages/core/src/billing.ts's pro priceUsdCents
    expect(captured.notifyUrl).toBe("https://app.example.com/webhooks/payfast"); // same webhook as wallet funding
  });

  it("upgrades the account tier on a valid sub: ITN, distinct from a wallet-funding ITN", async () => {
    const app = createApp({
      platform: new Platform(),
      issuerWebhookSecret: SECRET,
      dashboardUrl: "https://app.example.com",
      payfast: fakePayFast(),
    });
    const signup = await json(
      await app.request("/v1/signup", {
        method: "POST",
        body: JSON.stringify({ email: "dev@acard.co.za", name: "Dev" }),
        headers: { "content-type": "application/json" },
      }),
    );

    const body = new URLSearchParams({
      m_payment_id: "pf_sub_1",
      pf_payment_id: "sub_998877",
      payment_status: "COMPLETE",
      amount_gross: "28.00",
      custom_str1: signup.account_holder.id,
      custom_str2: "sub:pro",
      signature: "irrelevant-because-fake-validates-true",
    }).toString();
    const res = await app.request("/webhooks/payfast", { method: "POST", body, headers: { "content-type": "application/x-www-form-urlencoded" } });
    expect(res.status).toBe(200);

    // Confirms the upgrade actually raised the plan limit (pro = 100 cards/month) —
    // and that the wallet was NOT credited, unlike the "fund" purpose.
    for (let i = 0; i < 6; i++) {
      const cardRes = await withToken(app, "/v1/cards", signup.api_key, { method: "POST", body: "{}" });
      expect(cardRes.status).toBe(201);
    }
    const wallet = await json(await withToken(app, "/v1/wallet", signup.api_key));
    expect(wallet.wallet.posted).toBe(0);
  });
});
