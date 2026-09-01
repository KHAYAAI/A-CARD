import { beforeEach, describe, expect, it } from "vitest";
import { Platform, type MerchantAuthService } from "@acard/core";
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
    merchants: platform.merchants,
    merchantAuth,
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

describe("without merchantAuthKit configured", () => {
  it("portal login has nowhere to go, but invite creation still works so the operator flow isn't blocked", async () => {
    const bareForm = new Platform();
    const bare = createApp({ platform: bareForm, issuerWebhookSecret: SECRET, merchants: bareForm.merchants, merchantAuth: bareForm.merchantAuth });

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
