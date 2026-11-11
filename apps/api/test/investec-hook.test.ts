import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Platform } from "@acard/core";
import { createApp } from "../src/app.js";

// Load the card code exactly as pasted into Investec: plain script, no imports, with fetch and process provided.
const source = readFileSync(fileURLToPath(new URL("../../../integrations/investec/main.js", import.meta.url)), "utf8");
const mod: { exports: any } = { exports: {} };
new Function("module", "process", "fetch", "console", source)(mod, process, (...a: [any, any]) => globalThis.fetch(...a), { log: () => {} });
const hook = mod.exports as { beforeTransaction(a: unknown): Promise<boolean>; afterTransaction(t: unknown): Promise<void>; afterDecline(t: unknown): Promise<void>; describe(a: unknown): any };
const HOOK_SECRET = "investec-hook-secret-0123456789ab";
const j = async (r: Response) => (await r.json()) as any;

/** What Investec hands the card code (shape as documented; see the header of main.js). */
const auth = (over: any = {}) => ({
  reference: `ref-${Math.random().toString(36).slice(2, 10)}`,
  card: { id: "inv-card-1" },
  centsAmount: 5_000,
  currencyCode: "zar",
  merchant: { name: "Fresh Basket", category: { code: "5411" }, country: { code: "ZA" } },
  ...over,
});

let app: ReturnType<typeof createApp>;
let key: string;
const realFetch = globalThis.fetch;
const env0 = { ...process.env };

async function setup() {
  // The card map is filled in once the real A-CARD card id exists.
  const cards: Record<string, string> = {};
  app = createApp({ platform: new Platform(), issuerWebhookSecret: "whsec_test", investecPilot: { secret: HOOK_SECRET, cards } });
  key = (await j(await app.request("/v1/signup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "pilot@example.co.za", name: "Pilot", currency: "ZAR" }) }))).api_key;
  const authed = (p: string, init: RequestInit = {}) => app.request(p, { ...init, headers: { authorization: `Bearer ${key}`, "content-type": "application/json" } });
  await authed("/v1/wallet/fund", { method: "POST", body: JSON.stringify({ amount: 1_000_000 }) });
  await authed("/v1/policy", { method: "PUT", body: JSON.stringify({ blocked_merchant_categories: ["7995"], approval_threshold: 20_000 }) });
  const card = (await j(await authed("/v1/cards", { method: "POST", body: JSON.stringify({ single_use: false }) }))).card;
  cards["inv-card-1"] = card.id;
  return card.id as string;
}

beforeEach(async () => {
  await setup();
  process.env.ACARD_URL = "http://acard.test";
  process.env.ACARD_HOOK_SECRET = HOOK_SECRET;
  delete process.env.ACARD_FAIL_OPEN;
  // The hook's fetch goes straight into the app, as the real network would.
  globalThis.fetch = (async (url: string, init: RequestInit) => app.request(String(url).replace("http://acard.test", ""), init)) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  process.env = { ...env0 };
});

describe("Investec card hook", () => {
  it("reads Investec's authorization into A-CARD's shape, in cents", () => {
    expect(hook.describe(auth({ reference: "r1" }))).toEqual({ authorization_id: "r1", card_id: "inv-card-1", amount: 5000, currency: "ZAR", merchant: { name: "Fresh Basket", category: "5411", country: "ZA" } });
  });

  it("approves an ordinary charge and declines a blocked category", async () => {
    expect(await hook.beforeTransaction(auth())).toBe(true);
    expect(await hook.beforeTransaction(auth({ merchant: { name: "Lucky Spin", category: { code: "7995" }, country: { code: "ZA" } } }))).toBe(false);
  });

  it("holds a charge above the approval threshold for a person (declines for now)", async () => {
    expect(await hook.beforeTransaction(auth({ centsAmount: 30_000 }))).toBe(false);
  });

  it("declines an unlinked card and a foreign currency without asking A-CARD", async () => {
    expect(await hook.beforeTransaction(auth({ card: { id: "someone-elses-card" } }))).toBe(false);
    let called = false;
    globalThis.fetch = (async () => { called = true; return new Response("{}"); }) as typeof fetch;
    expect(await hook.beforeTransaction(auth({ currencyCode: "eur" }))).toBe(false);
    expect(called).toBe(false);
  });

  it("fails closed when the hook secret is wrong or A-CARD is down, and open only if told to", async () => {
    process.env.ACARD_HOOK_SECRET = "wrong-secret-wrong-secret-wrong";
    expect(await hook.beforeTransaction(auth())).toBe(false);
    process.env.ACARD_HOOK_SECRET = HOOK_SECRET;
    globalThis.fetch = (async () => { throw new Error("connect ECONNREFUSED"); }) as typeof fetch;
    expect(await hook.beforeTransaction(auth())).toBe(false);
    process.env.ACARD_FAIL_OPEN = "true";
    expect(await hook.beforeTransaction(auth())).toBe(true);
  });

  it("never replays an earlier decision for a different charge that reuses a reference", async () => {
    const first = auth({ reference: "same-ref", centsAmount: 5_000 });
    expect(await hook.beforeTransaction(first)).toBe(true);
    const different = auth({ reference: "same-ref", centsAmount: 6_000, merchant: { name: "Lucky Spin", category: { code: "7995" }, country: { code: "ZA" } } });
    expect(await hook.beforeTransaction(different)).toBe(false); // refused, not replayed as an approval
    expect(await hook.beforeTransaction(first)).toBe(true); // the same charge retried is still fine
  });

  it("settles the hold on success and releases it when Investec declines, so the budget tracks real spend", async () => {
    const authed = (p: string) => app.request(p, { headers: { authorization: `Bearer ${key}` } });
    const available = async () => (await j(await authed("/v1/wallet"))).wallet.available as number;
    const start = await available();
    const a = auth({ centsAmount: 5_000 });
    expect(await hook.beforeTransaction(a)).toBe(true);
    expect(await available()).toBe(start - 5_000); // held
    await hook.afterTransaction({ reference: a.reference, centsAmount: 4_800 });
    const wallet = (await j(await authed("/v1/wallet"))).wallet;
    expect(wallet.held).toBe(0);
    expect(start - (await available())).toBe(4_800); // settled for the final amount

    const b = auth({ centsAmount: 7_000 });
    expect(await hook.beforeTransaction(b)).toBe(true);
    expect(await available()).toBe(start - 4_800 - 7_000);
    await hook.afterDecline({ reference: b.reference });
    expect(await available()).toBe(start - 4_800); // hold released
  });

  it("follow-ups cannot touch holds the hook did not create", async () => {
    const res = await app.request("/webhooks/investec/settle", { method: "POST", headers: { authorization: `Bearer ${HOOK_SECRET}`, "content-type": "application/json" }, body: JSON.stringify({ authorization_id: "not-ours" }) });
    expect((await j(res)).ok).toBe(false);
  });

  it("the endpoint needs the hook secret, which is not the issuer webhook secret", async () => {
    const body = JSON.stringify({ authorization_id: "x1", card_id: "inv-card-1", amount: 100, currency: "ZAR", merchant: { name: "m", category: "5411" } });
    expect((await app.request("/webhooks/investec/authorize", { method: "POST", body })).status).toBe(401);
    expect((await app.request("/webhooks/investec/authorize", { method: "POST", body, headers: { authorization: "Bearer whsec_test" } })).status).toBe(401);
  });

  it("is not mounted unless configured, and refuses a short secret", async () => {
    const bare = createApp({ platform: new Platform(), issuerWebhookSecret: "whsec_test" });
    expect((await bare.request("/webhooks/investec/authorize", { method: "POST", body: "{}" })).status).toBe(404);
    expect(() => createApp({ platform: new Platform(), issuerWebhookSecret: "whsec_test", investecPilot: { secret: "short", cards: {} } })).toThrow(/24 characters/);
  });
});
