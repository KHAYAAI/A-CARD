import { beforeEach, describe, expect, it } from "vitest";
import { Platform } from "@acard/core";
import { createApp } from "../src/app.js";
import { TestVaultProvider } from "../src/attachedCards/index.js";
import { SoftAuthenticator } from "./helpers/softAuthenticator.js";

const RP = { rpId: "localhost", rpName: "A-CARD", origins: ["http://localhost:3000"] };
const j = async (r: Response) => (await r.json()) as any;
let app: ReturnType<typeof createApp>;
let provider: TestVaultProvider;
let session: string;
let apiKey: string;
let phone: SoftAuthenticator;
const as = (token: string) => (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") =>
  app.request(path, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const person = (p: string, b?: unknown, m?: string) => as(session)(p, b, m);
const agent = (p: string, b?: unknown, m?: string) => as(apiKey)(p, b, m);
const buy = (amount: number, extra: object = {}) => agent("/v1/attached-cards/purchases", { amount, currency: "ZAR", merchant_name: "Fresh Basket", merchant_category: "5411", checkout: { method: "network_token", destination: "acq:fresh-basket" }, ...extra });

async function registerPasskey() {
  const { options } = await j(await person("/v1/passkeys/registration-options", {}));
  const r = await person("/v1/passkeys/registration", { passkey_response: phone.register(options) });
  expect(r.status).toBe(201);
}

beforeEach(async () => {
  provider = new TestVaultProvider();
  phone = new SoftAuthenticator("localhost", "http://localhost:3000");
  app = createApp({ platform: new Platform(), issuerWebhookSecret: "whsec_test", attachedCards: { provider }, passkeys: RP });
  const reg = await j(await app.request("/v1/auth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "owner@example.co.za", name: "Owner", password: "a-long-test-password-123", currency: "ZAR", account_type: "enterprise" }) }));
  session = reg.session_token;
  apiKey = (await j(await person("/v1/keys", { name: "agent" }))).api_key;
  await person("/v1/attached-cards", { provider_ref: "test_tok_visa_4242_1230", label: "My Visa" });
  await person("/v1/attached-cards/settings", { auto_approve_under: 20_000, max_per_purchase: 200_000 }, "PUT");
});

describe("attached cards", () => {
  it("refuses card numbers anywhere in a request, and never returns the vault reference", async () => {
    const r = await person("/v1/attached-cards", { provider_ref: "test_tok_visa_4242_1230", label: "4242 4242 4242 4242" });
    expect(r.status).toBe(400);
    expect((await j(r)).error.code).toBe("card_number_refused");
    const list = await j(await agent("/v1/attached-cards"));
    expect(list.cards).toHaveLength(1);
    expect(list.cards[0]).toMatchObject({ brand: "visa", last4: "4242", label: "My Visa" });
    expect(JSON.stringify(list)).not.toContain("test_tok_");
  });

  it("only a person can attach, remove or change settings; an agent key cannot", async () => {
    expect((await agent("/v1/attached-cards", { provider_ref: "test_tok_mastercard_4444_1230" })).status).toBe(403);
    expect((await agent("/v1/attached-cards/settings", { auto_approve_under: 9_999_999 }, "PUT")).status).toBe(403);
    expect((await person("/v1/attached-cards", { provider_ref: "not-a-real-ref" })).status).toBe(400);
    expect((await person("/v1/attached-cards", { provider_ref: "test_tok_visa_1111_0120" })).status).toBe(400); // expired
  });

  it("pays small purchases under the holder's rule, through a single release bound to merchant and amount", async () => {
    const r = await j(await buy(15_000));
    expect(r.purchase).toMatchObject({ status: "paid", approved_by: "auto_approve_rule", release: { bound_amount: 15_000, bound_merchant: "Fresh Basket" } });
    expect(provider.released).toHaveLength(1);
    expect(provider.released[0]).toMatchObject({ amount: 15_000, target: { merchantName: "Fresh Basket", method: "network_token" } });
  });

  it("applies organisation policy and the per-purchase cap", async () => {
    await person("/v1/policy", { blocked_merchant_categories: ["7995"] }, "PUT");
    expect((await j(await buy(5_000, { merchant_category: "7995" }))).purchase).toMatchObject({ status: "declined", reason: "merchant_category_blocked_by_policy" });
    expect((await j(await buy(250_000))).purchase).toMatchObject({ status: "declined", reason: "over_per_purchase_limit" });
    expect(provider.released).toHaveLength(0);
  });

  it("holds larger purchases until the holder signs with their passkey; nothing is released before", async () => {
    await registerPasskey();
    const { purchase, passkey_needed } = await j(await buy(90_000));
    expect(purchase.status).toBe("awaiting_approval");
    expect(passkey_needed).toBe(true);
    expect(provider.released).toHaveLength(0);
    // the agent cannot ask for the passkey prompt or approve
    expect((await agent(`/v1/attached-cards/purchases/${purchase.id}/approval-options`, {})).status).toBe(403);
    expect((await agent(`/v1/attached-cards/purchases/${purchase.id}/approve`, { passkey_response: {} })).status).toBe(403);
    const { options } = await j(await person(`/v1/attached-cards/purchases/${purchase.id}/approval-options`, {}));
    const ok = await j(await person(`/v1/attached-cards/purchases/${purchase.id}/approve`, { passkey_response: phone.assert(options) }));
    expect(ok.purchase).toMatchObject({ status: "paid", approved_by: "owner@example.co.za" });
    expect(provider.released).toHaveLength(1);
  });

  it("rejects a reused, wrong-purchase, wrong-origin or not-user-verified passkey signature", async () => {
    await registerPasskey();
    const a = (await j(await buy(90_000))).purchase;
    const b = (await j(await buy(80_000))).purchase;
    const optsA = (await j(await person(`/v1/attached-cards/purchases/${a.id}/approval-options`, {}))).options;
    // a signature for purchase A cannot approve purchase B
    expect((await person(`/v1/attached-cards/purchases/${b.id}/approve`, { passkey_response: phone.assert(optsA) })).status).toBe(401);
    // no face/PIN check
    let o = (await j(await person(`/v1/attached-cards/purchases/${a.id}/approval-options`, {}))).options;
    expect((await person(`/v1/attached-cards/purchases/${a.id}/approve`, { passkey_response: phone.assert(o, { userVerified: false }) })).status).toBe(401);
    // phishing origin
    o = (await j(await person(`/v1/attached-cards/purchases/${a.id}/approval-options`, {}))).options;
    expect((await person(`/v1/attached-cards/purchases/${a.id}/approve`, { passkey_response: phone.assert(o, { origin: "https://evil.example" }) })).status).toBe(401);
    // a correct one works once, and the same signature cannot be replayed
    o = (await j(await person(`/v1/attached-cards/purchases/${a.id}/approval-options`, {}))).options;
    const sig = phone.assert(o);
    expect((await person(`/v1/attached-cards/purchases/${a.id}/approve`, { passkey_response: sig })).status).toBe(200);
    expect((await person(`/v1/attached-cards/purchases/${a.id}/approve`, { passkey_response: sig })).status).toBeGreaterThanOrEqual(400);
    expect(provider.released).toHaveLength(1);
  });

  it("without a registered passkey nobody can approve, and denial releases nothing", async () => {
    const p = (await j(await buy(90_000))).purchase;
    expect((await person(`/v1/attached-cards/purchases/${p.id}/approval-options`, {})).status).toBe(409); // no passkey yet
    const denied = await j(await person(`/v1/attached-cards/purchases/${p.id}/deny`, {}));
    expect(denied.purchase).toMatchObject({ status: "denied" });
    expect(provider.released).toHaveLength(0);
  });

  it("is not mounted without a provider and passkey settings", async () => {
    const bare = createApp({ platform: new Platform(), issuerWebhookSecret: "whsec_test" });
    const k = (await j(await bare.request("/v1/signup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "x@example.co.za", name: "X" }) }))).api_key;
    expect((await bare.request("/v1/attached-cards", { headers: { authorization: `Bearer ${k}` } })).status).toBe(404);
  });
});
