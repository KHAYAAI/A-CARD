import { beforeEach, describe, expect, it } from "vitest";
import { Platform, type MerchantAuthService } from "@acard/core";
import { InMemoryMerchantAuth, InMemoryMerchantDirectory } from "../src/merchant/index.js";
import { createApp } from "../src/app.js";
import type { AuthKitProfile, MerchantAuthKitClient } from "../src/merchantAuthKit.js";

const SECRET = "whsec_test";
const DASHBOARD_URL = "https://app.a-card.cc";
const JOBURG = { lat: -26.2041, lng: 28.0473, addressLine: "1 Main Road", city: "Johannesburg", province: "Gauteng", country: "ZA" };

/**
 * A fake AuthKit — mirrors what a merchant would actually do (get redirected
 * to WorkOS, authenticate there, get redirected back with a code) without a
 * live WorkOS project. Each code is minted once by `signIn` and is only ever
 * valid for the identity it was minted for, same as the real thing.
 */
function fakeAuthKit(): MerchantAuthKitClient & { signIn(profile: AuthKitProfile): string } {
  const codes = new Map<string, AuthKitProfile>();
  let n = 0;
  return {
    getAuthorizationUrl(state) {
      return `https://auth.workos.com/authorize?state=${encodeURIComponent(state)}`;
    },
    async authenticateWithCode(code) {
      const profile = codes.get(code);
      if (!profile) throw new Error("invalid code");
      codes.delete(code);
      return profile;
    },
    signIn(profile) {
      const code = `code_${++n}`;
      codes.set(code, profile);
      return code;
    },
  };
}

let platform: Platform;
let merchantAuth: MerchantAuthService;
let authKit: ReturnType<typeof fakeAuthKit>;
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

function portal(path: string, token: string | undefined, init: RequestInit = {}) {
  return app.request(path, {
    ...init,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

async function registerVerifiedMerchant(name = "Kasi Hardware") {
  const res = await authed("/v1/merchants", {
    method: "POST",
    body: JSON.stringify({
      name,
      merchant_category_code: "5211",
      address: JOBURG,
      kyb: { registration_number: "2019/123456/07", contact_email: "orders@example.co.za" },
    }),
  });
  const merchantId = (await json(res)).merchant.id as string;
  await authed(`/v1/merchants/${merchantId}/kyb`, { method: "POST", body: JSON.stringify({ status: "verified" }) });
  return merchantId;
}

/** Runs the full invite → authorize → WorkOS → callback loop, returns the merchant's session token. */
async function onboardMerchantOwner(merchantId: string, profile: AuthKitProfile) {
  const inviteRes = await authed(`/v1/merchants/${merchantId}/portal-invites`, { method: "POST", body: JSON.stringify({}) });
  expect(inviteRes.status).toBe(201);
  const inviteUrl: string = (await json(inviteRes)).invite_url;
  const inviteToken = new URL(inviteUrl).searchParams.get("invite")!;

  const authorizeRes = await app.request(`/v1/merchant-auth/authorize?invite=${encodeURIComponent(inviteToken)}`, { redirect: "manual" });
  expect(authorizeRes.status).toBe(302);
  const workosUrl = new URL(authorizeRes.headers.get("location")!);
  expect(workosUrl.searchParams.get("state")).toBe(inviteToken);

  const code = authKit.signIn(profile);
  const callbackRes = await app.request(`/v1/merchant-auth/callback?code=${code}&state=${encodeURIComponent(inviteToken)}`, {
    redirect: "manual",
  });
  expect(callbackRes.status).toBe(302);
  const redirect = new URL(callbackRes.headers.get("location")!);
  expect(redirect.origin + redirect.pathname).toBe(`${DASHBOARD_URL}/merchant`);
  return redirect.searchParams.get("portal_token")!;
}

beforeEach(async () => {
  platform = new Platform();
  merchantAuth = platform.merchantAuth;
  authKit = fakeAuthKit();
  app = createApp({
    platform,
    issuerWebhookSecret: SECRET,
    dashboardUrl: DASHBOARD_URL,
    merchants: new InMemoryMerchantDirectory(platform.merchants),
    merchantAuth: new InMemoryMerchantAuth(merchantAuth),
    merchantAuthKit: authKit,
  });
  const res = await app.request("/v1/signup", {
    method: "POST",
    body: JSON.stringify({ email: "dev@example.co.za", name: "Dev", currency: "ZAR" }),
    headers: { "content-type": "application/json" },
  });
  apiKey = (await json(res)).api_key;
});

describe("merchant portal invite flow", () => {
  it("takes an operator invite through WorkOS AuthKit to a working portal session", async () => {
    const merchantId = await registerVerifiedMerchant();
    const portalToken = await onboardMerchantOwner(merchantId, {
      workosUserId: "wu_1",
      email: "owner@kasihardware.co.za",
      name: "Thabo",
    });

    const me = await json(await portal("/v1/merchant-portal/me", portalToken));
    expect(me.user.email).toBe("owner@kasihardware.co.za");
    expect(me.user.role).toBe("owner");
    expect(me.merchant.id).toBe(merchantId);
    // The portal gets the same redacted view an agent gets — never the KYB pack.
    expect("kyb" in me.merchant).toBe(false);
  });

  it("only an admin can generate a portal invite", async () => {
    const merchantId = await registerVerifiedMerchant();
    const readOnlyKeyRes = await authed("/v1/keys", { method: "POST", body: JSON.stringify({ name: "ro", scope: "read_only" }) });
    const readOnlyKey = (await json(readOnlyKeyRes)).api_key;
    const res = await app.request(`/v1/merchants/${merchantId}/portal-invites`, {
      method: "POST",
      headers: { authorization: `Bearer ${readOnlyKey}`, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(403);
  });

  it("rejects an unknown, expired, or already-used invite", async () => {
    const merchantId = await registerVerifiedMerchant();

    const bogus = await app.request("/v1/merchant-auth/authorize?invite=totally_made_up", { redirect: "manual" });
    expect(bogus.status).toBe(400);

    // Redeem a real one once, then try again with the same token.
    const inviteRes = await authed(`/v1/merchants/${merchantId}/portal-invites`, { method: "POST", body: JSON.stringify({}) });
    const inviteToken = new URL((await json(inviteRes)).invite_url).searchParams.get("invite")!;
    const code1 = authKit.signIn({ workosUserId: "wu_2", email: "owner@kasihardware.co.za", name: "Thabo" });
    await app.request(`/v1/merchant-auth/callback?code=${code1}&state=${encodeURIComponent(inviteToken)}`, { redirect: "manual" });

    const reuse = await app.request(`/v1/merchant-auth/authorize?invite=${encodeURIComponent(inviteToken)}`, { redirect: "manual" });
    expect(reuse.status).toBe(400);
    expect((await json(reuse)).error.code).toBe("invite_used");
  });

  it("rejects a callback whose code was never issued (forged state can't forge a WorkOS identity)", async () => {
    const merchantId = await registerVerifiedMerchant();
    const inviteRes = await authed(`/v1/merchants/${merchantId}/portal-invites`, { method: "POST", body: JSON.stringify({}) });
    const inviteToken = new URL((await json(inviteRes)).invite_url).searchParams.get("invite")!;

    const res = await app.request(`/v1/merchant-auth/callback?code=not_a_real_code&state=${encodeURIComponent(inviteToken)}`, {
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    const redirect = new URL(res.headers.get("location")!);
    expect(redirect.searchParams.get("portal_error")).toBeTruthy();
  });

  it("logging in twice with the same WorkOS identity for the same merchant reuses the same user", async () => {
    const merchantId = await registerVerifiedMerchant();
    const profile: AuthKitProfile = { workosUserId: "wu_3", email: "owner@kasihardware.co.za", name: "Thabo" };
    const first = await onboardMerchantOwner(merchantId, profile);
    const meFirst = await json(await portal("/v1/merchant-portal/me", first));

    // A second invite for the same merchant, redeemed by the same WorkOS identity.
    const second = await onboardMerchantOwner(merchantId, profile);
    const meSecond = await json(await portal("/v1/merchant-portal/me", second));
    expect(meSecond.user.id).toBe(meFirst.user.id);
  });
});

describe("merchant portal session and isolation", () => {
  it("rejects portal routes with no session, and never accepts an A-CARD API key", async () => {
    expect((await portal("/v1/merchant-portal/me", undefined)).status).toBe(401);
    const merchantId = await registerVerifiedMerchant();
    void merchantId;
    expect((await portal("/v1/merchant-portal/me", apiKey)).status).toBe(401);
  });

  it("lets the merchant manage its own catalog, including the one-tap restate", async () => {
    const merchantId = await registerVerifiedMerchant();
    const token = await onboardMerchantOwner(merchantId, { workosUserId: "wu_4", email: "owner@kasihardware.co.za", name: "Thabo" });

    const created = await json(
      await portal("/v1/merchant-portal/items", token, {
        method: "PUT",
        body: JSON.stringify({ sku: "CEM-50", name: "Cement 50kg", unit_price_cents: 10_800, quantity_available: 900 }),
      }),
    );
    expect(created.item.merchantId).toBe(merchantId);

    const restated = await json(
      await portal(`/v1/merchant-portal/items/${created.item.id}/restate`, token, {
        method: "POST",
        body: JSON.stringify({ availability: "low_stock", quantity_available: 20 }),
      }),
    );
    expect(restated.item.availability).toBe("low_stock");
    expect(restated.item.quantityAvailable).toBe(20);

    const health = await json(await portal("/v1/merchant-portal/health", token));
    expect(health).toMatchObject({ items: 1, fresh: 1 });

    // And it's now really discoverable, through the exact same search an agent uses.
    const found = await json(await authed(`/v1/merchants/search?q=cement`));
    expect(found.offers[0].merchant.name).toBe("Kasi Hardware");
  });

  it("never lets one merchant's session touch another merchant's catalog", async () => {
    const mine = await registerVerifiedMerchant("Kasi Hardware");
    const theirs = await registerVerifiedMerchant("Other Hardware");
    const myToken = await onboardMerchantOwner(mine, { workosUserId: "wu_5", email: "owner@kasi.co.za", name: "Thabo" });

    const theirItem = await json(
      await authed(`/v1/merchants/${theirs}/items`, {
        method: "PUT",
        body: JSON.stringify({ sku: "CEM", name: "Cement 50kg", unit_price_cents: 10_000 }),
      }),
    );

    // Reading/writing/restating/deleting someone else's item all 404 rather
    // than leaking whether it exists, and none of them touch it.
    expect((await portal(`/v1/merchant-portal/items/${theirItem.item.id}/restate`, myToken, {
      method: "POST",
      body: JSON.stringify({ availability: "out_of_stock" }),
    })).status).toBe(404);
    expect((await portal(`/v1/merchant-portal/items/${theirItem.item.id}`, myToken, { method: "DELETE" })).status).toBe(404);

    const stillThere = await json(await authed(`/v1/merchants/${theirs}`));
    expect(stillThere.items[0].availability).toBe("in_stock");

    // And listing items only ever returns my own shop's catalog.
    const mine_ = await json(await portal("/v1/merchant-portal/items", myToken));
    expect(mine_.items).toHaveLength(0);
  });

  it("logout revokes the session", async () => {
    const merchantId = await registerVerifiedMerchant();
    const token = await onboardMerchantOwner(merchantId, { workosUserId: "wu_6", email: "owner@kasi.co.za", name: "Thabo" });
    expect((await portal("/v1/merchant-portal/me", token)).status).toBe(200);
    expect((await portal("/v1/merchant-portal/logout", token, { method: "POST" })).status).toBe(200);
    expect((await portal("/v1/merchant-portal/me", token)).status).toBe(401);
  });
});

describe("merchant portal staff invites", () => {
  it("lets an owner invite staff, and the invite carries the owner's own email as issuer", async () => {
    const merchantId = await registerVerifiedMerchant();
    const ownerToken = await onboardMerchantOwner(merchantId, { workosUserId: "wu_owner", email: "owner@kasi.co.za", name: "Thabo" });

    const inviteRes = await portal("/v1/merchant-portal/team/invites", ownerToken, {
      method: "POST",
      body: JSON.stringify({ role: "staff" }),
    });
    expect(inviteRes.status).toBe(201);
    const invite = await json(inviteRes);
    expect(invite.invite.role).toBe("staff");
    expect(invite.invite.issuedBy).toBe("owner@kasi.co.za");

    const staffCode = authKit.signIn({ workosUserId: "wu_staff", email: "assistant@kasi.co.za", name: "Naledi" });
    const inviteToken = new URL(invite.invite_url).searchParams.get("invite")!;
    const callbackRes = await app.request(`/v1/merchant-auth/callback?code=${staffCode}&state=${encodeURIComponent(inviteToken)}`, {
      redirect: "manual",
    });
    const staffToken = new URL(callbackRes.headers.get("location")!).searchParams.get("portal_token")!;

    const staffMe = await json(await portal("/v1/merchant-portal/me", staffToken));
    expect(staffMe.user.role).toBe("staff");
    expect(staffMe.merchant.id).toBe(merchantId);

    // Staff can do the one job that matters...
    const items = await json(await portal("/v1/merchant-portal/items", staffToken));
    expect(items.items).toEqual([]);
  });

  it("staff cannot invite other staff, or see the team roster", async () => {
    const merchantId = await registerVerifiedMerchant();
    const ownerToken = await onboardMerchantOwner(merchantId, { workosUserId: "wu_owner2", email: "owner2@kasi.co.za", name: "Thabo" });
    const staffInvite = await json(
      await portal("/v1/merchant-portal/team/invites", ownerToken, { method: "POST", body: JSON.stringify({ role: "staff" }) }),
    );
    const staffCode = authKit.signIn({ workosUserId: "wu_staff2", email: "assistant2@kasi.co.za", name: "Naledi" });
    const staffInviteToken = new URL(staffInvite.invite_url).searchParams.get("invite")!;
    const cb = await app.request(`/v1/merchant-auth/callback?code=${staffCode}&state=${encodeURIComponent(staffInviteToken)}`, {
      redirect: "manual",
    });
    const staffToken = new URL(cb.headers.get("location")!).searchParams.get("portal_token")!;

    expect((await portal("/v1/merchant-portal/team", staffToken)).status).toBe(403);
    expect((await portal("/v1/merchant-portal/team/invites", staffToken, { method: "POST", body: JSON.stringify({}) })).status).toBe(403);
  });

  it("an owner sees the roster and any still-pending invites", async () => {
    const merchantId = await registerVerifiedMerchant();
    const ownerToken = await onboardMerchantOwner(merchantId, { workosUserId: "wu_owner3", email: "owner3@kasi.co.za", name: "Thabo" });
    await portal("/v1/merchant-portal/team/invites", ownerToken, { method: "POST", body: JSON.stringify({ role: "staff" }) });

    const team = await json(await portal("/v1/merchant-portal/team", ownerToken));
    expect(team.users).toHaveLength(1);
    expect(team.invites).toHaveLength(1);
    expect(team.invites[0].role).toBe("staff");
  });
});

describe("without merchantAuthKit configured", () => {
  it("portal login has nowhere to go, but invite creation still works so the operator flow isn't blocked", async () => {
    const bareForm = new Platform();
    const bare = createApp({ platform: bareForm, issuerWebhookSecret: SECRET, merchants: new InMemoryMerchantDirectory(bareForm.merchants), merchantAuth: new InMemoryMerchantAuth(bareForm.merchantAuth) });

    const signup = await bare.request("/v1/signup", {
      method: "POST",
      body: JSON.stringify({ email: "dev2@example.co.za", name: "Dev" }),
      headers: { "content-type": "application/json" },
    });
    const key = (await json(signup)).api_key;
    const create = await bare.request("/v1/merchants", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        name: "Kasi Hardware",
        merchant_category_code: "5211",
        address: JOBURG,
        kyb: { registration_number: "2019/1/07", contact_email: "orders@example.co.za" },
      }),
    });
    const merchantId = (await json(create)).merchant.id;

    const invite = await bare.request(`/v1/merchants/${merchantId}/portal-invites`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(invite.status).toBe(201);

    // But nothing on the login path is mounted without an AuthKit client to send the merchant to.
    expect((await bare.request("/v1/merchant-auth/authorize?invite=x")).status).toBe(404);
    expect((await bare.request("/v1/merchant-portal/me")).status).toBe(404);
  });

  it("without a directory at all, the whole surface — including invites — is unmounted", async () => {
    const bare = createApp({ platform: new Platform(), issuerWebhookSecret: SECRET });
    expect((await bare.request("/v1/merchant-portal/me")).status).toBe(404);
  });
});

describe("purchase notices — the feedback loop, end to end", () => {
  async function setupShop() {
    const merchantId = await registerVerifiedMerchant();
    const token = await onboardMerchantOwner(merchantId, {
      workosUserId: "wu_owner",
      email: "owner@kasihardware.co.za",
      name: "Thandi",
    });
    const itemRes = await portal("/v1/merchant-portal/items", token, {
      method: "PUT",
      body: JSON.stringify({
        sku: "CEM-50",
        name: "Cement 50kg",
        unit: "bag",
        unit_price_cents: 8_800,
        quantity_available: 600,
      }),
    });
    return { merchantId, token, item: (await json(itemRes)).item };
  }

  it("runs buyer report → merchant sees it → acknowledge + restate in one call", async () => {
    const { merchantId, token, item } = await setupShop();

    // 1. The buyer reports what they bought, priced from the catalog.
    const reported = await authed(`/v1/merchants/${merchantId}/purchases`, {
      method: "POST",
      body: JSON.stringify({ item_id: item.id, quantity: 500, card_transaction_id: "ctx_abc" }),
    });
    expect(reported.status).toBe(201);
    const notice = (await json(reported)).purchase;
    expect(notice.totalCents).toBe(4_400_000);
    expect(notice.status).toBe("reported");
    expect(notice.cardTransactionId).toBe("ctx_abc");

    // 2. It shows up as pending work in the merchant's own portal.
    const health = await json(await portal("/v1/merchant-portal/health", token));
    expect(health.pendingPurchases).toBe(1);
    const listed = await json(await portal("/v1/merchant-portal/purchases", token));
    expect(listed.purchases).toHaveLength(1);

    // 3. Acknowledging and restating stock is one action — the whole point.
    const before = (await json(await portal("/v1/merchant-portal/items", token))).items[0];
    const ack = await portal(`/v1/merchant-portal/purchases/${notice.id}/acknowledge`, token, {
      method: "POST",
      body: JSON.stringify({ note: "collected Tuesday", restate: { availability: "in_stock", quantity_available: 100 } }),
    });
    expect(ack.status).toBe(200);
    const acked = await json(ack);
    expect(acked.purchase.status).toBe("acknowledged");
    expect(acked.item.quantityAvailable).toBe(100);

    // The freshness clock moved — which is the outcome the whole loop exists for.
    expect(Date.parse(acked.item.inventoryUpdatedAt)).toBeGreaterThanOrEqual(Date.parse(before.inventoryUpdatedAt));
    expect((await json(await portal("/v1/merchant-portal/health", token))).pendingPurchases).toBe(0);
  });

  it("acknowledging without restating is allowed — a merchant who doesn't know their count still confirms", async () => {
    const { merchantId, token, item } = await setupShop();
    const notice = (
      await json(
        await authed(`/v1/merchants/${merchantId}/purchases`, {
          method: "POST",
          body: JSON.stringify({ item_id: item.id, quantity: 5 }),
        }),
      )
    ).purchase;

    const res = await portal(`/v1/merchant-portal/purchases/${notice.id}/acknowledge`, token, {
      method: "POST",
      body: JSON.stringify({}),
    });
    const body = await json(res);
    expect(body.purchase.status).toBe("acknowledged");
    expect(body.item).toBeUndefined();
  });

  it("a merchant can dispute, and cannot then re-resolve it", async () => {
    const { merchantId, token, item } = await setupShop();
    const notice = (
      await json(
        await authed(`/v1/merchants/${merchantId}/purchases`, {
          method: "POST",
          body: JSON.stringify({ item_id: item.id, quantity: 5 }),
        }),
      )
    ).purchase;

    const disputed = await json(
      await portal(`/v1/merchant-portal/purchases/${notice.id}/dispute`, token, {
        method: "POST",
        body: JSON.stringify({ note: "never received this order" }),
      }),
    );
    expect(disputed.purchase.status).toBe("disputed");

    const again = await portal(`/v1/merchant-portal/purchases/${notice.id}/acknowledge`, token, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(again.status).toBe(409);
  });

  it("reporting a purchase does not move money or touch stock", async () => {
    const { merchantId, token, item } = await setupShop();
    const walletBefore = await json(await authed("/v1/wallet"));

    await authed(`/v1/merchants/${merchantId}/purchases`, {
      method: "POST",
      body: JSON.stringify({ item_id: item.id, quantity: 500 }),
    });

    expect(await json(await authed("/v1/wallet"))).toEqual(walletBefore);
    const stock = (await json(await portal("/v1/merchant-portal/items", token))).items[0];
    expect(stock.quantityAvailable).toBe(600);
  });

  it("one shop cannot see or resolve another shop's notices", async () => {
    const { merchantId, item } = await setupShop();
    const notice = (
      await json(
        await authed(`/v1/merchants/${merchantId}/purchases`, {
          method: "POST",
          body: JSON.stringify({ item_id: item.id, quantity: 1 }),
        }),
      )
    ).purchase;

    const otherId = await registerVerifiedMerchant("Rival Hardware");
    const otherToken = await onboardMerchantOwner(otherId, {
      workosUserId: "wu_rival",
      email: "owner@rival.co.za",
      name: "Sipho",
    });

    expect((await json(await portal("/v1/merchant-portal/purchases", otherToken))).purchases).toHaveLength(0);
    const res = await portal(`/v1/merchant-portal/purchases/${notice.id}/acknowledge`, otherToken, {
      method: "POST",
      body: JSON.stringify({}),
    });
    // 404, not 403 — same discipline as every other cross-merchant read.
    expect(res.status).toBe(404);
  });

  it("rejects an item that does not belong to the merchant in the path", async () => {
    const { item } = await setupShop();
    const otherId = await registerVerifiedMerchant("Rival Hardware");
    const res = await authed(`/v1/merchants/${otherId}/purchases`, {
      method: "POST",
      body: JSON.stringify({ item_id: item.id, quantity: 1 }),
    });
    expect(res.status).toBe(404);
  });

  it("a buyer sees their own purchases across every merchant", async () => {
    const { merchantId, item } = await setupShop();
    await authed(`/v1/merchants/${merchantId}/purchases`, {
      method: "POST",
      body: JSON.stringify({ item_id: item.id, quantity: 1 }),
    });
    const mine = await json(await authed("/v1/purchases"));
    expect(mine.purchases).toHaveLength(1);
    expect(mine.purchases[0].itemName).toBe("Cement 50kg");
  });
});

describe("the merchant's own API — what a POS integrates against", () => {
  async function shopWithKey(scope: "read_only" | "read_write" = "read_write") {
    const merchantId = await registerVerifiedMerchant();
    const token = await onboardMerchantOwner(merchantId, {
      workosUserId: `wu_${scope}_${merchantId}`,
      email: "owner@kasihardware.co.za",
      name: "Thandi",
    });
    const created = await portal("/v1/merchant-portal/api-keys", token, {
      method: "POST",
      body: JSON.stringify({ name: "Till sync", scope }),
    });
    expect(created.status).toBe(201);
    const body = await json(created);
    return { merchantId, token, secret: body.secret as string, apiKey: body.api_key };
  }

  function api(path: string, secret: string, init: RequestInit = {}) {
    return app.request(path, {
      ...init,
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json", ...(init.headers ?? {}) },
    });
  }

  it("issues a key whose secret is returned once and never stored in the clear", async () => {
    const { merchantId, token, secret, apiKey } = await shopWithKey();
    expect(secret.startsWith("mk_live_")).toBe(true);
    expect(apiKey.prefix).toBe(secret.slice(0, 16));

    const listed = (await json(await portal("/v1/merchant-portal/api-keys", token))).api_keys;
    expect(listed).toHaveLength(1);
    // The list never carries the secret back.
    expect(JSON.stringify(listed)).not.toContain(secret);
    expect(merchantId).toBeTruthy();
  });

  it("identifies itself and reports catalog health", async () => {
    const { secret } = await shopWithKey();
    const me = await json(await api("/v1/merchant-api/me", secret));
    expect(me.merchant.name).toBe("Kasi Hardware");
    expect(me.scope).toBe("read_write");
    // The agent-facing view — never the KYB pack.
    expect(me.merchant.kyb).toBeUndefined();
  });

  it("bulk-syncs a catalog by the merchant's own SKUs, idempotently", async () => {
    const { secret } = await shopWithKey();
    const payload = {
      items: [
        { sku: "CEM-50", name: "Cement 50kg", unit: "bag", unit_price_cents: 8_800, quantity_available: 600 },
        { sku: "SAND-1", name: "River sand", unit: "m3", unit_price_cents: 45_000, quantity_available: 20 },
      ],
    };
    const first = await api("/v1/merchant-api/catalog", secret, { method: "PUT", body: JSON.stringify(payload) });
    expect(first.status).toBe(200);
    expect((await json(first)).synced).toBe(2);

    // Pushing the same catalog again updates in place rather than duplicating.
    await api("/v1/merchant-api/catalog", secret, { method: "PUT", body: JSON.stringify(payload) });
    expect((await json(await api("/v1/merchant-api/catalog", secret))).items).toHaveLength(2);
  });

  it("one bad row does not discard the good ones, and names the SKU that failed", async () => {
    const { secret } = await shopWithKey();
    const res = await api("/v1/merchant-api/catalog", secret, {
      method: "PUT",
      body: JSON.stringify({
        items: [
          { sku: "GOOD", name: "Good item", unit_price_cents: 1_000 },
          // Negative price is refused by the domain, not by zod.
          { sku: "BAD", name: "Bad item", unit_price_cents: 0 },
        ],
      }),
    });
    const body = await json(res);
    expect(body.synced).toBeGreaterThanOrEqual(1);
    expect(body.results.find((r: { sku: string }) => r.sku === "GOOD").ok).toBe(true);
  });

  it("restates stock by SKU — the call a till fires after every sale", async () => {
    const { secret } = await shopWithKey();
    await api("/v1/merchant-api/catalog", secret, {
      method: "PUT",
      body: JSON.stringify({ items: [{ sku: "CEM-50", name: "Cement 50kg", unit_price_cents: 8_800, quantity_available: 600 }] }),
    });

    const res = await api("/v1/merchant-api/stock", secret, {
      method: "POST",
      body: JSON.stringify({ items: [{ sku: "CEM-50", availability: "low_stock", quantity_available: 12 }] }),
    });
    expect(res.status).toBe(200);
    expect((await json(res)).restated).toBe(1);

    const items = (await json(await api("/v1/merchant-api/catalog", secret))).items;
    expect(items[0].availability).toBe("low_stock");
    expect(items[0].quantityAvailable).toBe(12);
  });

  it("an unknown SKU is reported per-row, not as a failed sync", async () => {
    const { secret } = await shopWithKey();
    const res = await api("/v1/merchant-api/stock", secret, {
      method: "POST",
      body: JSON.stringify({ items: [{ sku: "NOT-A-SKU", availability: "in_stock" }] }),
    });
    expect(res.status).toBe(207);
    expect((await json(res)).results[0].error).toBe("unknown sku");
  });

  it("a read-only key can read but not write", async () => {
    const { secret } = await shopWithKey("read_only");
    expect((await api("/v1/merchant-api/catalog", secret)).status).toBe(200);
    const write = await api("/v1/merchant-api/catalog", secret, {
      method: "PUT",
      body: JSON.stringify({ items: [{ sku: "X", name: "X", unit_price_cents: 1 }] }),
    });
    expect(write.status).toBe(403);
  });

  it("pulls purchase notices and acknowledges them, restating in the same call", async () => {
    const { merchantId, secret } = await shopWithKey();
    await api("/v1/merchant-api/catalog", secret, {
      method: "PUT",
      body: JSON.stringify({ items: [{ sku: "CEM-50", name: "Cement 50kg", unit: "bag", unit_price_cents: 8_800, quantity_available: 600 }] }),
    });
    const item = (await json(await api("/v1/merchant-api/catalog", secret))).items[0];

    await authed(`/v1/merchants/${merchantId}/purchases`, {
      method: "POST",
      body: JSON.stringify({ item_id: item.id, quantity: 500 }),
    });

    const pending = (await json(await api("/v1/merchant-api/purchases?status=reported", secret))).purchases;
    expect(pending).toHaveLength(1);

    const ack = await api(`/v1/merchant-api/purchases/${pending[0].id}/acknowledge`, secret, {
      method: "POST",
      body: JSON.stringify({ restate: { availability: "in_stock", quantity_available: 100 } }),
    });
    expect(ack.status).toBe(200);
    expect((await json(ack)).item.quantityAvailable).toBe(100);
  });

  it("rejects a missing, malformed, or revoked key", async () => {
    const { token, secret, apiKey } = await shopWithKey();
    expect((await app.request("/v1/merchant-api/me")).status).toBe(401);
    expect((await api("/v1/merchant-api/me", "not_a_key")).status).toBe(401);
    // An A-CARD tenant key must never satisfy this guard.
    expect((await api("/v1/merchant-api/me", apiKeyFor())).status).toBe(401);

    await portal(`/v1/merchant-portal/api-keys/${apiKey.id}`, token, { method: "DELETE" });
    expect((await api("/v1/merchant-api/me", secret)).status).toBe(401);
  });

  it("one merchant's key cannot read another merchant's catalog", async () => {
    const a = await shopWithKey();
    const otherId = await registerVerifiedMerchant("Rival Hardware");
    const otherToken = await onboardMerchantOwner(otherId, { workosUserId: "wu_rival2", email: "o@rival.co.za", name: "S" });
    const otherSecret = (
      await json(
        await portal("/v1/merchant-portal/api-keys", otherToken, { method: "POST", body: JSON.stringify({ name: "Rival till" }) }),
      )
    ).secret;

    await api("/v1/merchant-api/catalog", a.secret, {
      method: "PUT",
      body: JSON.stringify({ items: [{ sku: "SECRET", name: "Kasi only", unit_price_cents: 100 }] }),
    });
    const rivalView = (await json(await api("/v1/merchant-api/catalog", otherSecret))).items;
    expect(rivalView).toHaveLength(0);
  });

  it("only an owner can mint or revoke keys", async () => {
    const merchantId = await registerVerifiedMerchant();
    const ownerToken = await onboardMerchantOwner(merchantId, { workosUserId: "wu_o", email: "o@k.co.za", name: "O" });
    const staffInvite = await portal("/v1/merchant-portal/team/invites", ownerToken, {
      method: "POST",
      body: JSON.stringify({ role: "staff" }),
    });
    const staffToken = new URL((await json(staffInvite)).invite_url).searchParams.get("invite")!;
    const code = authKit.signIn({ workosUserId: "wu_s", email: "s@k.co.za", name: "S" });
    const cb = await app.request(`/v1/merchant-auth/callback?code=${code}&state=${encodeURIComponent(staffToken)}`, { redirect: "manual" });
    const staffSession = new URL(cb.headers.get("location")!).searchParams.get("portal_token")!;

    const res = await portal("/v1/merchant-portal/api-keys", staffSession, {
      method: "POST",
      body: JSON.stringify({ name: "sneaky" }),
    });
    expect(res.status).toBe(403);
  });
});

/** The A-CARD tenant key from the outer suite, for the negative auth test. */
function apiKeyFor() {
  return apiKey;
}

describe("orders, fulfilment, and the POS connection", () => {
  async function shopWithKeyAndItem() {
    const merchantId = await registerVerifiedMerchant();
    const token = await onboardMerchantOwner(merchantId, {
      workosUserId: `wu_ord_${merchantId}`,
      email: "owner@kasihardware.co.za",
      name: "Thandi",
    });
    const secret = (
      await json(await portal("/v1/merchant-portal/api-keys", token, { method: "POST", body: JSON.stringify({ name: "Till" }) }))
    ).secret as string;
    await app.request("/v1/merchant-api/catalog", {
      method: "PUT",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: JSON.stringify({ items: [{ sku: "CEM-50", name: "Cement 50kg", unit: "bag", unit_price_cents: 8_800, quantity_available: 600 }] }),
    });
    const item = (
      await json(
        await app.request("/v1/merchant-api/catalog", { headers: { authorization: `Bearer ${secret}` } }),
      )
    ).items[0];
    return { merchantId, token, secret, item };
  }

  const mApi = (path: string, secret: string, init: RequestInit = {}) =>
    app.request(path, {
      ...init,
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json", ...(init.headers ?? {}) },
    });

  it("an agent places an order and the merchant walks it to delivered", async () => {
    const { merchantId, secret, item } = await shopWithKeyAndItem();

    const placed = await authed(`/v1/merchants/${merchantId}/orders`, {
      method: "POST",
      body: JSON.stringify({
        lines: [{ item_id: item.id, quantity: 400 }],
        fulfilment: { method: "delivery", address: "Soweto site", needed_by: "2026-09-19T00:00:00.000Z" },
      }),
    });
    expect(placed.status).toBe(201);
    const order = (await json(placed)).order;
    expect(order.totalCents).toBe(8_800 * 400);
    expect(order.status).toBe("placed");

    // It shows up as work for the merchant.
    expect((await json(await mApi("/v1/merchant-api/orders?status=placed", secret))).orders).toHaveLength(1);

    const advance = (status: string, body: Record<string, unknown> = {}) =>
      mApi(`/v1/merchant-api/orders/${order.id}/advance`, secret, { method: "POST", body: JSON.stringify({ status, ...body }) });

    await advance("accepted", { promised_at: "2026-09-18T10:00:00.000Z" });
    await advance("preparing");
    await advance("dispatched", { tracking_reference: "TRK-9" });
    const delivered = (await json(await advance("delivered"))).order;

    expect(delivered.status).toBe("delivered");
    expect(delivered.fulfilment.trackingReference).toBe("TRK-9");
    expect(delivered.fulfilment.deliveredAt).toBeTruthy();
  });

  it("an illegal transition is refused", async () => {
    const { merchantId, secret, item } = await shopWithKeyAndItem();
    const order = (
      await json(
        await authed(`/v1/merchants/${merchantId}/orders`, {
          method: "POST",
          body: JSON.stringify({ lines: [{ item_id: item.id, quantity: 1 }], fulfilment: { method: "collection" } }),
        }),
      )
    ).order;
    await mApi(`/v1/merchant-api/orders/${order.id}/advance`, secret, { method: "POST", body: JSON.stringify({ status: "rejected" }) });
    const again = await mApi(`/v1/merchant-api/orders/${order.id}/advance`, secret, {
      method: "POST",
      body: JSON.stringify({ status: "accepted" }),
    });
    expect(again.status).toBe(409);
  });

  it("a buyer can cancel before acceptance and sees only their own orders", async () => {
    const { merchantId, item } = await shopWithKeyAndItem();
    const order = (
      await json(
        await authed(`/v1/merchants/${merchantId}/orders`, {
          method: "POST",
          body: JSON.stringify({ lines: [{ item_id: item.id, quantity: 1 }], fulfilment: { method: "collection" } }),
        }),
      )
    ).order;

    expect((await json(await authed("/v1/orders"))).orders).toHaveLength(1);
    const cancelled = await authed(`/v1/orders/${order.id}/cancel`, { method: "POST", body: JSON.stringify({}) });
    expect((await json(cancelled)).order.status).toBe("cancelled");
  });

  it("an order against an unverified merchant is refused", async () => {
    const res = await authed("/v1/merchants", {
      method: "POST",
      body: JSON.stringify({
        name: "Unverified Co",
        merchant_category_code: "5211",
        address: JOBURG,
        kyb: { registration_number: "x", contact_email: "a@b.co.za" },
      }),
    });
    const unverifiedId = (await json(res)).merchant.id;
    const placed = await authed(`/v1/merchants/${unverifiedId}/orders`, {
      method: "POST",
      body: JSON.stringify({ lines: [{ item_id: "item_x", quantity: 1 }], fulfilment: { method: "collection" } }),
    });
    expect(placed.status).toBe(409);
  });

  it("reliability is reported with its confidence, and a new merchant is not punished for being new", async () => {
    const { merchantId, secret } = await shopWithKeyAndItem();
    const fresh = (await json(await authed(`/v1/merchants/${merchantId}`))).reliability;
    expect(fresh.confidence).toBe("none");
    expect(fresh.score).toBe(0.5);
    expect((await json(await mApi("/v1/merchant-api/reliability", secret))).reliability.orders).toBe(0);
  });
});

describe("POS connection: events actually reach the merchant's system", () => {
  /** Stands in for a POS endpoint, capturing exactly what we send it. */
  function fakePos(options: { fail?: boolean } = {}) {
    const received: Array<{ body: string; signature: string | null; event: string | null }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      received.push({
        body: String(init?.body ?? ""),
        signature: headers.get("x-acard-signature"),
        event: headers.get("x-acard-event"),
      });
      return new Response(options.fail ? "nope" : "ok", { status: options.fail ? 500 : 200 });
    }) as unknown as typeof fetch;
    return { received, fetchImpl };
  }

  async function setup(pos: ReturnType<typeof fakePos>) {
    platform = new Platform();
    merchantAuth = platform.merchantAuth;
    authKit = fakeAuthKit();
    app = createApp({
      platform,
      issuerWebhookSecret: SECRET,
      dashboardUrl: DASHBOARD_URL,
      merchants: new InMemoryMerchantDirectory(platform.merchants),
      merchantAuth: new InMemoryMerchantAuth(merchantAuth),
      merchantAuthKit: authKit,
      merchantWebhookFetch: pos.fetchImpl,
    });
    const su = await app.request("/v1/signup", {
      method: "POST",
      body: JSON.stringify({ email: "dev@example.co.za", name: "Dev", currency: "ZAR" }),
      headers: { "content-type": "application/json" },
    });
    apiKey = (await json(su)).api_key;

    const merchantId = await registerVerifiedMerchant();
    const token = await onboardMerchantOwner(merchantId, { workosUserId: "wu_pos", email: "o@k.co.za", name: "T" });
    const secret = (
      await json(await portal("/v1/merchant-portal/api-keys", token, { method: "POST", body: JSON.stringify({ name: "Till" }) }))
    ).secret as string;
    const mApi = (path: string, init: RequestInit = {}) =>
      app.request(path, { ...init, headers: { authorization: `Bearer ${secret}`, "content-type": "application/json", ...(init.headers ?? {}) } });

    await mApi("/v1/merchant-api/catalog", {
      method: "PUT",
      body: JSON.stringify({ items: [{ sku: "CEM", name: "Cement", unit_price_cents: 8_800 }] }),
    });
    const item = (await json(await mApi("/v1/merchant-api/catalog"))).items[0];
    return { merchantId, secret, mApi, item };
  }

  it("registers an endpoint and pushes a signed order.placed to it", async () => {
    const pos = fakePos();
    const { merchantId, mApi, item } = await setup(pos);

    const registered = await mApi("/v1/merchant-api/webhook", {
      method: "PUT",
      body: JSON.stringify({ url: "https://pos.example/acard" }),
    });
    expect(registered.status).toBe(201);
    const body = await json(registered);
    expect(body.secret.startsWith("mwh_")).toBe(true);
    // The stored hash is never handed back.
    expect(body.webhook.hashedSecret).toBeUndefined();

    await authed(`/v1/merchants/${merchantId}/orders`, {
      method: "POST",
      body: JSON.stringify({ lines: [{ item_id: item.id, quantity: 5 }], fulfilment: { method: "collection" } }),
    });
    await new Promise((r) => setTimeout(r, 30));

    expect(pos.received).toHaveLength(1);
    expect(pos.received[0]!.event).toBe("order.placed");
    // Same t=…,v1=… scheme as the issuer webhook, so one verifier handles both.
    expect(pos.received[0]!.signature).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(JSON.parse(pos.received[0]!.body).data.order.lines[0].sku).toBe("CEM");
  });

  it("a dead endpoint never fails the agent's order, and the failure is visible", async () => {
    const pos = fakePos({ fail: true });
    const { merchantId, mApi, item } = await setup(pos);
    await mApi("/v1/merchant-api/webhook", { method: "PUT", body: JSON.stringify({ url: "https://dead.example/hook" }) });

    const placed = await authed(`/v1/merchants/${merchantId}/orders`, {
      method: "POST",
      body: JSON.stringify({ lines: [{ item_id: item.id, quantity: 1 }], fulfilment: { method: "collection" } }),
    });
    // The order succeeded regardless.
    expect(placed.status).toBe(201);
    await new Promise((r) => setTimeout(r, 30));

    const merchant = await platform.merchants.get(merchantId);
    expect(merchant.webhook!.lastDeliveryOk).toBe(false);
    expect(merchant.webhook!.consecutiveFailures).toBe(1);
  });

  it("redelivers an order a dead endpoint missed", async () => {
    const pos = fakePos();
    const { merchantId, mApi, item } = await setup(pos);
    const order = (
      await json(
        await authed(`/v1/merchants/${merchantId}/orders`, {
          method: "POST",
          body: JSON.stringify({ lines: [{ item_id: item.id, quantity: 1 }], fulfilment: { method: "collection" } }),
        }),
      )
    ).order;
    // Endpoint registered only AFTER the order was placed — the classic case.
    await mApi("/v1/merchant-api/webhook", { method: "PUT", body: JSON.stringify({ url: "https://pos.example/acard" }) });
    expect(pos.received).toHaveLength(0);

    await mApi(`/v1/merchant-api/orders/${order.id}/redeliver`, { method: "POST" });
    await new Promise((r) => setTimeout(r, 30));
    expect(pos.received).toHaveLength(1);
  });

  it("respects an event subscription filter", async () => {
    const pos = fakePos();
    const { merchantId, mApi, item } = await setup(pos);
    await mApi("/v1/merchant-api/webhook", {
      method: "PUT",
      body: JSON.stringify({ url: "https://pos.example/acard", events: ["order.cancelled"] }),
    });
    await authed(`/v1/merchants/${merchantId}/orders`, {
      method: "POST",
      body: JSON.stringify({ lines: [{ item_id: item.id, quantity: 1 }], fulfilment: { method: "collection" } }),
    });
    await new Promise((r) => setTimeout(r, 30));
    // Subscribed to cancellations only, so a placement is not delivered.
    expect(pos.received).toHaveLength(0);
  });

  it("clearing the endpoint stops delivery", async () => {
    const pos = fakePos();
    const { merchantId, mApi, item } = await setup(pos);
    await mApi("/v1/merchant-api/webhook", { method: "PUT", body: JSON.stringify({ url: "https://pos.example/acard" }) });
    await mApi("/v1/merchant-api/webhook", { method: "DELETE" });
    await authed(`/v1/merchants/${merchantId}/orders`, {
      method: "POST",
      body: JSON.stringify({ lines: [{ item_id: item.id, quantity: 1 }], fulfilment: { method: "collection" } }),
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(pos.received).toHaveLength(0);
  });
});
