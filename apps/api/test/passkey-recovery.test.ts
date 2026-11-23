import { beforeEach, describe, expect, it } from "vitest";
import { Platform } from "@acard/core";
import { createApp } from "../src/app.js";
import { MemoryPasskeyStore, TestVaultProvider } from "../src/attachedCards/index.js";
import { SoftAuthenticator } from "./helpers/softAuthenticator.js";

const RP = { rpId: "localhost", rpName: "A-CARD", origins: ["http://localhost:3000"] };
const PASSWORD = "a-long-test-password-123";
const j = async (r: Response) => (await r.json()) as any;
let app: ReturnType<typeof createApp>;
let session: string;
let userId: string;
let apiKey: string;
let provider: TestVaultProvider;
let passkeyStore: MemoryPasskeyStore;
const as = (token: string) => (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") =>
  app.request(path, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const person = (p: string, b?: unknown, m?: string) => as(session)(p, b, m);
const agent = (p: string, b?: unknown, m?: string) => as(apiKey)(p, b, m);
const buy = async (amount = 90_000) => j(await agent("/v1/attached-cards/purchases", { amount, currency: "ZAR", merchant_name: "Shop", merchant_category: "5411", checkout: { method: "network_token", destination: "acq:1" } }));

async function addPasskey(device: SoftAuthenticator) {
  const { options } = await j(await person("/v1/passkeys/registration-options", {}));
  const r = await person("/v1/passkeys/registration", { passkey_response: device.register(options) });
  expect(r.status).toBe(201);
  return j(r);
}
async function approve(purchaseId: string, device: SoftAuthenticator) {
  const o = await person(`/v1/attached-cards/purchases/${purchaseId}/approval-options`, {});
  if (o.status !== 200) return o;
  return person(`/v1/attached-cards/purchases/${purchaseId}/approve`, { passkey_response: device.assert((await j(o)).options) });
}

beforeEach(async () => {
  provider = new TestVaultProvider();
  passkeyStore = new MemoryPasskeyStore();
  app = createApp({ platform: new Platform(), issuerWebhookSecret: "whsec_test", attachedCards: { provider, passkeyStore }, passkeys: RP });
  const reg = await j(await app.request("/v1/auth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "owner@example.co.za", name: "Owner", password: PASSWORD, currency: "ZAR", account_type: "enterprise" }) }));
  session = reg.session_token;
  userId = reg.user.id;
  apiKey = (await j(await person("/v1/keys", { name: "agent" }))).api_key;
  await person("/v1/attached-cards", { provider_ref: "test_tok_visa_4242_1230" });
});

describe("lost phone: passkey recovery", () => {
  it("the first passkey comes with 10 one-time recovery codes, shown once", async () => {
    const first = await addPasskey(new SoftAuthenticator("localhost", "http://localhost:3000"));
    expect(first.recovery_codes).toHaveLength(10);
    expect(new Set(first.recovery_codes).size).toBe(10);
    expect(first.recovery_codes[0]).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
    const second = await addPasskey(new SoftAuthenticator("localhost", "http://localhost:3000"));
    expect(second.recovery_codes).toBeNull();
    const status = await j(await person("/v1/passkeys"));
    expect(status.recovery_codes).toEqual({ total: 10, unused: 10 });
    expect(JSON.stringify(status)).not.toContain(first.recovery_codes[0]);
  });

  it("with a second device, the lost phone's passkey is removed by signing with the other one", async () => {
    const phone = new SoftAuthenticator("localhost", "http://localhost:3000");
    const laptop = new SoftAuthenticator("localhost", "http://localhost:3000");
    const a = await addPasskey(phone);
    await addPasskey(laptop);
    // can't sign the removal with the lost phone itself
    let o = (await j(await person(`/v1/passkeys/${a.passkey.id}/removal-options`, {}))).options;
    expect(o.allowCredentials.map((x: any) => x.id)).not.toContain(a.passkey.id);
    expect((await person(`/v1/passkeys/${a.passkey.id}/remove`, { passkey_response: phone.assert(o) })).status).toBe(401);
    o = (await j(await person(`/v1/passkeys/${a.passkey.id}/removal-options`, {}))).options;
    expect((await person(`/v1/passkeys/${a.passkey.id}/remove`, { passkey_response: laptop.assert(o) })).status).toBe(200);
    // the lost phone can no longer approve; the laptop still can
    const p1 = (await buy()).purchase;
    expect((await approve(p1.id, phone)).status).toBe(401);
    expect((await j(await approve(p1.id, laptop))).purchase.status).toBe("paid");
    // the last passkey can't be removed this way
    const last = (await j(await person("/v1/passkeys"))).passkeys[0].id;
    expect((await person(`/v1/passkeys/${last}/removal-options`, {})).status).toBe(409);
  });

  it("with no other device: password + recovery code removes every passkey and pauses approvals for a day", async () => {
    const phone = new SoftAuthenticator("localhost", "http://localhost:3000");
    const { recovery_codes: codes } = await addPasskey(phone);
    expect((await person("/v1/passkeys/recover", { recovery_code: codes[0], password: "wrong-password" })).status).toBe(401);
    expect((await person("/v1/passkeys/recover", { recovery_code: "AAAAA-AAAAA", password: PASSWORD })).status).toBe(401);
    const r = await j(await person("/v1/passkeys/recover", { recovery_code: codes[0].toLowerCase().replace("-", " "), password: PASSWORD }));
    expect(r).toMatchObject({ passkeys_removed: 1, recovery_codes_left: 9 });
    // the code is spent
    expect((await person("/v1/passkeys/recover", { recovery_code: codes[0], password: PASSWORD })).status).toBe(401);
    // the old phone is dead; a new phone can be added but can't approve during the cooling-off
    const newPhone = new SoftAuthenticator("localhost", "http://localhost:3000");
    expect((await addPasskey(newPhone)).recovery_codes).toBeNull(); // 9 codes left, no new ones
    const p = (await buy()).purchase;
    const blocked = await person(`/v1/attached-cards/purchases/${p.id}/approve`, { passkey_response: {} });
    expect(blocked.status).toBe(403);
    expect((await j(blocked)).error.code).toBe("recovery_cooldown");
    // rules can be lowered but not raised during the cooling-off
    expect((await person("/v1/attached-cards/settings", { max_per_purchase: 100_000 }, "PUT")).status).toBe(200);
    expect((await person("/v1/attached-cards/settings", { auto_approve_under: 99_000 }, "PUT")).status).toBe(403);
    const status = await j(await person("/v1/passkeys"));
    expect(status.cooldown_until).toBeTruthy();
    expect(status.events.map((e: any) => e.kind)).toEqual(expect.arrayContaining(["recovered", "passkey_added", "recovery_code_failed"]));
    // after the cooling-off, the new phone approves normally
    await passkeyStore.setCooldown(userId, Date.now() - 1);
    expect((await approve(p.id, phone)).status).toBe(401); // the lost phone is dead for good
    expect((await j(await approve(p.id, newPhone))).purchase.status).toBe("paid");
    expect(provider.released).toHaveLength(1);
  });

  it("new recovery codes need a passkey signature and replace the old ones", async () => {
    const phone = new SoftAuthenticator("localhost", "http://localhost:3000");
    const { recovery_codes: old } = await addPasskey(phone);
    const { options } = await j(await person("/v1/passkeys/recovery-codes/options", {}));
    const fresh = (await j(await person("/v1/passkeys/recovery-codes", { passkey_response: phone.assert(options) }))).recovery_codes;
    expect(fresh).toHaveLength(10);
    expect((await person("/v1/passkeys/recover", { recovery_code: old[0], password: PASSWORD })).status).toBe(401);
    expect((await person("/v1/passkeys/recover", { recovery_code: fresh[0], password: PASSWORD })).status).toBe(200);
  });

  it("an agent can't recover, and guessing codes is throttled", async () => {
    await addPasskey(new SoftAuthenticator("localhost", "http://localhost:3000"));
    expect((await agent("/v1/passkeys/recover", { recovery_code: "AAAAA-AAAAA", password: PASSWORD })).status).toBe(403);
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) statuses.push((await person("/v1/passkeys/recover", { recovery_code: `AAAAA-AAAA${i}`, password: PASSWORD })).status);
    expect(statuses.slice(0, 5).every((s) => s === 401)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
  });
});
