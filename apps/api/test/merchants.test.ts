import { beforeEach, describe, expect, it } from "vitest";
import { Platform } from "@acard/core";
import { InMemoryMerchantDirectory } from "../src/merchant/index.js";
import { createApp } from "../src/app.js";

const SECRET = "whsec_test";
const JOBURG = { lat: -26.2041, lng: 28.0473 };

let platform: Platform;
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

async function registerVerified(name: string, overrides: Record<string, unknown> = {}) {
  const res = await authed("/v1/merchants", {
    method: "POST",
    body: JSON.stringify({
      name,
      merchant_category_code: "5211",
      address: { ...JOBURG, addressLine: "1 Main Road", city: "Johannesburg", province: "Gauteng", country: "ZA" },
      service_radius_km: 30,
      kyb: { registration_number: "2019/123456/07", contact_email: "orders@example.co.za" },
      ...overrides,
    }),
  });
  expect(res.status).toBe(201);
  const { merchant } = await json(res);
  await authed(`/v1/merchants/${merchant.id}/kyb`, { method: "POST", body: JSON.stringify({ status: "verified" }) });
  return merchant.id as string;
}

beforeEach(async () => {
  platform = new Platform();
  app = createApp({ platform, issuerWebhookSecret: SECRET, merchants: new InMemoryMerchantDirectory(platform.merchants) });
  const res = await app.request("/v1/signup", {
    method: "POST",
    body: JSON.stringify({ email: "dev@example.co.za", name: "Dev", currency: "ZAR" }),
    headers: { "content-type": "application/json" },
  });
  apiKey = (await json(res)).api_key;
});

describe("A-MERCHANT API", () => {
  it("is not mounted at all when no directory is configured", async () => {
    const bare = createApp({ platform: new Platform(), issuerWebhookSecret: SECRET });
    const signup = await bare.request("/v1/signup", {
      method: "POST",
      body: JSON.stringify({ email: "other@example.co.za", name: "Other" }),
      headers: { "content-type": "application/json" },
    });
    const key = (await json(signup)).api_key;
    const res = await bare.request("/v1/merchants/search?q=cement", { headers: { authorization: `Bearer ${key}` } });
    expect(res.status).toBe(404);
  });

  it("requires authentication like every other /v1 route", async () => {
    expect((await app.request("/v1/merchants/search?q=cement")).status).toBe(401);
  });

  it("registers a merchant, verifies it, and only then returns it to an agent", async () => {
    const create = await authed("/v1/merchants", {
      method: "POST",
      body: JSON.stringify({
        name: "Kasi Hardware",
        merchant_category_code: "5211",
        address: { ...JOBURG, addressLine: "1 Main Road", city: "Johannesburg", province: "Gauteng", country: "ZA" },
        kyb: { registration_number: "2019/123456/07", contact_email: "orders@kasihardware.co.za" },
      }),
    });
    expect(create.status).toBe(201);
    const merchantId = (await json(create)).merchant.id;

    await authed(`/v1/merchants/${merchantId}/items`, {
      method: "PUT",
      body: JSON.stringify({ sku: "CEM-50", name: "Cement 50kg", unit: "bag", unit_price_cents: 10_800, quantity_available: 900 }),
    });

    let search = await json(await authed("/v1/merchants/search?q=cement"));
    expect(search.offers).toHaveLength(0);
    expect(search.excluded[0].reason).toBe("merchant is pending_kyb");

    const decision = await authed(`/v1/merchants/${merchantId}/kyb`, {
      method: "POST",
      body: JSON.stringify({ status: "verified", note: "CIPC docs on file" }),
    });
    expect(decision.status).toBe(200);
    // The reviewer is taken from the authenticated caller, never the request body.
    expect((await json(decision)).merchant.kyb.reviewedBy).toBe("dev@example.co.za");

    search = await json(await authed("/v1/merchants/search?q=cement"));
    expect(search.offers).toHaveLength(1);
    expect(search.offers[0].merchant.name).toBe("Kasi Hardware");
  });

  it("never leaks the KYB pack through an agent-facing read", async () => {
    const merchantId = await registerVerified("Kasi Hardware");
    const body = await (await authed(`/v1/merchants/${merchantId}`)).text();
    expect(body).not.toContain("2019/123456/07");
    expect(body).not.toContain("orders@example.co.za");
    expect(JSON.parse(body).merchant.verified).toBe(true);
  });

  it("answers the cement query with ranked offers and stated exclusions", async () => {
    const a = await registerVerified("Merchant A");
    const b = await registerVerified("Merchant B");
    const c = await registerVerified("Merchant C");

    const stock = async (id: string, cents: number, leadTimeDays: number) =>
      authed(`/v1/merchants/${id}/items`, {
        method: "PUT",
        body: JSON.stringify({
          sku: "CEM-50",
          name: "Cement 50kg",
          unit: "bag",
          unit_price_cents: cents,
          quantity_available: 900,
          lead_time_days: leadTimeDays,
        }),
      });
    await stock(a, 10_800, 1);
    await stock(b, 11_300, 0);
    await stock(c, 10_560, 3);

    const result = await json(
      await authed(
        `/v1/merchants/search?q=cement&quantity=500&lat=${JOBURG.lat}&lng=${JOBURG.lng}&radius_km=15&max_total_cents=6000000&max_lead_time_days=1`,
      ),
    );

    const names = result.offers.map((o: any) => o.merchant.name);
    expect(names).toContain("Merchant A");
    expect(names).toContain("Merchant B");
    expect(names).not.toContain("Merchant C");
    expect(result.offers[0].totalCents).toBeLessThanOrEqual(6_000_000);
    expect(result.excluded.some((e: any) => e.reason.includes("3-day lead time"))).toBe(true);
  });

  it("enforces a merchant's allow-list against the authenticated caller, not a supplied id", async () => {
    const merchantId = await registerVerified("Contract Supplier", {
      agent_access: "allowlist",
      allowed_account_holder_ids: ["ah_someone_else"],
    });
    await authed(`/v1/merchants/${merchantId}/items`, {
      method: "PUT",
      body: JSON.stringify({ sku: "CEM", name: "Cement 50kg", unit_price_cents: 10_000 }),
    });

    // Even asking on behalf of the allowed org does not work — the query is
    // always scoped to whoever holds the API key.
    const result = await json(await authed("/v1/merchants/search?q=cement&requestedBy=ah_someone_else"));
    expect(result.offers).toHaveLength(0);
    expect(result.excluded[0].reason).toContain("named organisations");
  });

  it("restates stock without touching price, and reports catalog health", async () => {
    const merchantId = await registerVerified("Kasi Hardware");
    const item = (
      await json(
        await authed(`/v1/merchants/${merchantId}/items`, {
          method: "PUT",
          body: JSON.stringify({ sku: "CEM", name: "Cement 50kg", unit_price_cents: 10_800, quantity_available: 900 }),
        }),
      )
    ).item;

    const restated = (
      await json(
        await authed(`/v1/merchants/${merchantId}/items/${item.id}/restate`, {
          method: "POST",
          body: JSON.stringify({ availability: "low_stock", quantity_available: 40 }),
        }),
      )
    ).item;
    expect(restated.availability).toBe("low_stock");
    expect(restated.quantityAvailable).toBe(40);
    expect(restated.unitPriceCents).toBe(10_800);

    const health = await json(await authed(`/v1/merchants/${merchantId}/health`));
    expect(health).toMatchObject({ items: 1, fresh: 1, stale: 0 });
  });

  it("refuses to restate an item that belongs to another merchant", async () => {
    const mine = await registerVerified("Kasi Hardware");
    const theirs = await registerVerified("Other Hardware");
    const item = (
      await json(
        await authed(`/v1/merchants/${theirs}/items`, {
          method: "PUT",
          body: JSON.stringify({ sku: "CEM", name: "Cement 50kg", unit_price_cents: 10_800 }),
        }),
      )
    ).item;

    const res = await authed(`/v1/merchants/${mine}/items/${item.id}/restate`, {
      method: "POST",
      body: JSON.stringify({ availability: "out_of_stock" }),
    });
    expect(res.status).toBe(404);
  });

  it("scopes discovery to the MCCs a card is allowed to pay at", async () => {
    const hardware = await registerVerified("Kasi Hardware", { merchant_category_code: "5211" });
    const grocer = await registerVerified("Corner Spaza", { merchant_category_code: "5411" });
    for (const id of [hardware, grocer]) {
      await authed(`/v1/merchants/${id}/items`, {
        method: "PUT",
        body: JSON.stringify({ sku: "CEM", name: "Cement 50kg", unit_price_cents: 10_000 }),
      });
    }

    const card = (
      await json(
        await authed("/v1/cards", {
          method: "POST",
          body: JSON.stringify({ single_use: false, allowed_merchant_categories: ["5211"] }),
        }),
      )
    ).card;

    const result = await json(
      await authed(`/v1/merchants/search?q=cement&categories=${card.allowedMerchantCategories.join(",")}`),
    );
    expect(result.offers.map((o: any) => o.merchant.name)).toEqual(["Kasi Hardware"]);
  });

  it("rejects a malformed search rather than guessing", async () => {
    expect((await authed("/v1/merchants/search?quantity=0")).status).toBe(400);
    expect((await authed("/v1/merchants/search?lat=999&lng=0")).status).toBe(400);
  });

  it("returns 404 for an unknown merchant", async () => {
    expect((await authed("/v1/merchants/mch_nope")).status).toBe(404);
  });
});
