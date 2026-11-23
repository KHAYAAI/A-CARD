import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Platform } from "@acard/core";
import { createApp } from "../src/app.js";
import { AttachedCardService, PostgresAttachedCardStore, TestVaultProvider } from "../src/attachedCards/index.js";
import { SoftAuthenticator } from "./helpers/softAuthenticator.js";

/**
 * Attached cards and passkeys on a real Postgres. Skipped unless
 * ACARD_TEST_DATABASE_URL points at a reachable database.
 *
 * The important ones: a purchase can only be released once when two API
 * instances race to approve it, a passkey challenge can only be used once
 * when ten requests race for it, and everything survives a restart.
 */
const DB_URL = process.env.ACARD_TEST_DATABASE_URL;
const suite = DB_URL ? describe : describe.skip;
const KEY = Buffer.alloc(32, 7);
const RP = { rpId: "localhost", rpName: "A-CARD", origins: ["http://localhost:3000"] };
const j = async (r: Response) => (await r.json()) as any;
const stores: PostgresAttachedCardStore[] = [];
const newStore = () => { const s = new PostgresAttachedCardStore(DB_URL!, KEY); stores.push(s); return s; };

suite("attached cards and passkeys on Postgres", () => {
  let store: PostgresAttachedCardStore;
  beforeEach(async () => {
    store = newStore();
    await store.migrate();
    await store.pool.query("TRUNCATE acard_attached_cards, acard_attached_card_settings, acard_attached_purchases, acard_passkeys, acard_passkey_challenges");
  });
  afterAll(async () => { await Promise.all(stores.map((s) => s.close().catch(() => {}))); });

  it("migrate() is idempotent", async () => {
    await store.migrate();
    await store.migrate();
  });

  it("encrypts the vault reference at rest and never stores a card number", async () => {
    const svc = new AttachedCardService(new TestVaultProvider(), async () => [], store);
    const card = await svc.attach("ah_1", "test_tok_visa_4242_1230", "owner@example.co.za");
    const raw = (await store.pool.query("SELECT * FROM acard_attached_cards")).rows[0];
    expect(JSON.stringify(raw)).not.toContain("test_tok_visa");
    expect(raw.last4).toBe("4242");
    expect((await store.getCard(card.id))!.providerRef).toBe("test_tok_visa_4242_1230");
  });

  it("two API instances racing to approve the same purchase release it exactly once", async () => {
    const provider = new TestVaultProvider();
    const a = new AttachedCardService(provider, async () => [], newStore());
    const b = new AttachedCardService(provider, async () => [], newStore());
    await a.attach("ah_1", "test_tok_visa_4242_1230", "owner");
    await a.setSettings("ah_1", { autoApproveUnder: 0 });
    const p = await a.request("ah_1", { amount: 90_000, currency: "ZAR", target: { merchantName: "Shop", merchantCategory: "5411", method: "network_token", destination: "acq:1" } }, "agent");
    expect(p.status).toBe("awaiting_approval");
    const results = await Promise.allSettled([...Array(5)].flatMap(() => [a.approve("ah_1", p.id, "owner"), b.approve("ah_1", p.id, "owner")]));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(provider.released).toHaveLength(1);
    expect((await a.get("ah_1", p.id)).status).toBe("paid");
  });

  it("a passkey challenge can be taken only once, even by ten racing requests", async () => {
    await store.putChallenge("purchase:x", { challenge: "abc", userId: "u1", expires: Date.now() + 60_000 });
    const others = [...Array(10)].map(() => newStore());
    const got = await Promise.all(others.map((s) => s.takeChallenge("purchase:x")));
    expect(got.filter(Boolean)).toHaveLength(1);
  });

  it("the full HTTP flow works on Postgres and survives a restart", async () => {
    const provider = new TestVaultProvider();
    const platform = new Platform();
    const phone = new SoftAuthenticator("localhost", "http://localhost:3000");
    const boot = (st: PostgresAttachedCardStore) => createApp({ platform, issuerWebhookSecret: "whsec_test", attachedCards: { provider, store: st, passkeyStore: st }, passkeys: RP });
    let app = boot(store);
    const reg = await j(await app.request("/v1/auth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "pg@example.co.za", name: "PG", password: "a-long-test-password-123", currency: "ZAR", account_type: "enterprise" }) }));
    const call = (path: string, body?: unknown, token = reg.session_token as string) =>
      app.request(path, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const { options } = await j(await call("/v1/passkeys/registration-options", {}));
    expect((await call("/v1/passkeys/registration", { passkey_response: phone.register(options) })).status).toBe(201);
    await call("/v1/attached-cards", { provider_ref: "test_tok_mastercard_4444_1230" });
    const key = (await j(await call("/v1/keys", { name: "agent" }))).api_key;
    const p = (await j(await call("/v1/attached-cards/purchases", { amount: 90_000, currency: "ZAR", merchant_name: "Shop", merchant_category: "5411", checkout: { method: "network_token", destination: "acq:1" } }, key))).purchase;
    expect(p.status).toBe("awaiting_approval");

    // "restart": a fresh pool and a fresh app over the same database (the platform's own state is in memory here)
    const restarted = newStore();
    app = boot(restarted);
    expect((await j(await call("/v1/passkeys"))).passkeys).toHaveLength(1);
    expect((await j(await call("/v1/attached-cards"))).cards[0]).toMatchObject({ brand: "mastercard", last4: "4444" });
    const o = (await j(await call(`/v1/attached-cards/purchases/${p.id}/approval-options`, {}))).options;
    const sig = phone.assert(o);
    const ok = await j(await call(`/v1/attached-cards/purchases/${p.id}/approve`, { passkey_response: sig }));
    expect(ok.purchase).toMatchObject({ status: "paid", approved_by: "pg@example.co.za" });
    expect((await call(`/v1/attached-cards/purchases/${p.id}/approve`, { passkey_response: sig })).status).toBeGreaterThanOrEqual(400);
    expect(provider.released).toHaveLength(1);
    const counter = (await restarted.pool.query("SELECT counter FROM acard_passkeys")).rows[0].counter;
    expect(Number(counter)).toBeGreaterThan(1); // moved forward with each signature
  });
});
