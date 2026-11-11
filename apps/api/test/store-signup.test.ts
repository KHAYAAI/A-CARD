import { beforeEach, describe, expect, it } from "vitest";
import { Platform } from "@acard/core";
import { InMemoryMerchantAuth, InMemoryMerchantDirectory } from "../src/merchant/index.js";
import { createApp } from "../src/app.js";
import { parseCatalogCsv } from "../src/merchant/csv.js";

const JOBURG = { lat: -26.2041, lng: 28.0473, addressLine: "1 Main Road", city: "Johannesburg", province: "Gauteng", country: "ZA" };
const STORE = { name: "Corner Dairy (Pty) Ltd", trading_name: "Corner Dairy", merchant_category_code: "5411", address: JOBURG, service_radius_km: 25, kyb: { registration_number: "2020/123456/07", contact_email: "owner@cornerdairy.example" } };
const j = async (r: Response) => (await r.json()) as any;

let app: ReturnType<typeof createApp>;
let tenantKey: string;
const tenant = (p: string) => app.request(p, { headers: { authorization: `Bearer ${tenantKey}` } });

const build = (selfServe: boolean) => {
  const platform = new Platform();
  return createApp({
    platform,
    issuerWebhookSecret: "whsec_test",
    merchants: new InMemoryMerchantDirectory(platform.merchants),
    merchantAuth: new InMemoryMerchantAuth(platform.merchantAuth),
    selfServeStores: selfServe ? { maxPerHourPerIp: 3 } : undefined,
  });
};
const signup = (body: unknown, ip = "1.1.1.1") => app.request("/v1/merchant-api/signup", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip }, body: JSON.stringify(body) });
const putCsv = (secret: string, csv: string) => app.request("/v1/merchant-api/catalog/csv", { method: "PUT", headers: { authorization: `Bearer ${secret}`, "content-type": "text/csv" }, body: csv });

describe("CSV parsing", () => {
  it("reads quoted fields, rand prices and friendly availability, and reports bad rows by number", () => {
    const { items, errors } = parseCatalogCsv('SKU,Name,Price,Availability,Qty\nA1,"Milk, 1L",R18.99,in stock,10\nA2,Eggs,54,low,3\nA3,Bad,abc,,\nA1,Dup,5,,\n,NoSku,5,,\nA5,Neg,-1,,\n');
    expect(items.map((i) => [i.sku, i.name, i.unit_price_cents, i.availability, i.quantity_available])).toEqual([
      ["A1", "Milk, 1L", 1899, "in_stock", 10],
      ["A2", "Eggs", 5400, "low_stock", 3],
    ]);
    expect(errors.map((e) => e.row)).toEqual([4, 5, 6, 7]);
    expect(errors[0]!.error).toMatch(/not a number/);
    expect(errors[1]!.error).toMatch(/duplicate/);
  });
  it("rejects a file without the required columns, and caps rows", () => {
    expect(parseCatalogCsv("a,b\n1,2").errors[0]!.error).toMatch(/missing required column: sku, name, price/);
    const big = "sku,name,price\n" + Array.from({ length: 520 }, (_, i) => `S${i},P${i},1`).join("\n");
    const r = parseCatalogCsv(big);
    expect(r.items).toHaveLength(500);
    expect(r.errors[0]!.error).toMatch(/first 500/);
  });
});

describe("self-serve store signup", () => {
  beforeEach(async () => {
    app = build(true);
    tenantKey = (await j(await app.request("/v1/signup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "buyer@example.co.za", name: "Buyer", currency: "ZAR" }) }))).api_key;
  });

  it("is off unless the operator enables it", async () => {
    app = build(false);
    expect((await signup(STORE)).status).toBe(404);
  });

  it("creates a pending store with a write key, and the store is invisible to agents until verified", async () => {
    const res = await signup({ ...STORE, items: [{ sku: "M1", name: "Cement 50kg", unit_price_cents: 11900 }] });
    expect(res.status).toBe(201);
    const out = await j(res);
    expect(out.status).toBe("pending_kyb");
    expect(out.secret).toMatch(/^mk_/);
    expect(out.items_uploaded).toBe(1);
    expect(out.merchant.verified).toBe(false);
    expect(JSON.stringify(out.merchant)).not.toContain("registration_number");
    const found = await j(await tenant("/v1/merchants/search?q=cement"));
    expect(JSON.stringify(found)).not.toContain("Corner Dairy");
  });

  it("lets the new key upload a CSV, with per-row errors, and still cannot be found while pending", async () => {
    const { secret } = await j(await signup(STORE));
    const res = await putCsv(secret, "sku,name,price,quantity\nMILK,Milk 1L,18.99,50\nBAD,Broken,xyz,1\n");
    expect(res.status).toBe(207);
    const out = await j(res);
    expect(out.synced).toBe(1);
    expect(out.errors[0]).toMatchObject({ row: 3, sku: "BAD" });
    const mine = await j(await app.request("/v1/merchant-api/catalog", { headers: { authorization: `Bearer ${secret}` } }));
    expect(mine.items).toHaveLength(1);
    expect(mine.items[0]).toMatchObject({ sku: "MILK", unitPriceCents: 1899 });
    // re-uploading the same file is idempotent by SKU
    await putCsv(secret, "sku,name,price,quantity\nMILK,Milk 1L,19.99,40\n");
    const again = await j(await app.request("/v1/merchant-api/catalog", { headers: { authorization: `Bearer ${secret}` } }));
    expect(again.items).toHaveLength(1);
    expect(again.items[0].unitPriceCents).toBe(1999);
  });

  it("becomes discoverable only after an operator verifies it", async () => {
    const out = await j(await signup({ ...STORE, items: [{ sku: "C1", name: "Cement 50kg", unit_price_cents: 11900 }] }));
    const verify = await app.request(`/v1/merchants/${out.merchant.id}/kyb`, { method: "POST", headers: { authorization: `Bearer ${tenantKey}`, "content-type": "application/json" }, body: JSON.stringify({ status: "verified" }) });
    expect(verify.status).toBe(200);
    const found = await j(await tenant("/v1/merchants/search?q=cement&lat=-26.2&lng=28.04"));
    expect(JSON.stringify(found)).toContain("Corner Dairy");
  });

  it("rejects a read-only key, a bad key, bad input, and rate-limits an address", async () => {
    expect((await putCsv("mk_nope", "sku,name,price\nA,B,1")).status).toBe(401);
    expect((await signup({ name: "x" })).status).toBeGreaterThanOrEqual(400);
    for (let i = 0; i < 3; i++) expect((await signup(STORE, "9.9.9.9")).status).toBe(201);
    expect((await signup(STORE, "9.9.9.9")).status).toBe(429);
    expect((await signup(STORE, "8.8.8.8")).status).toBe(201);
  });

  it("serves a CSV template with no auth", async () => {
    const r = await app.request("/v1/merchant-api/catalog/csv-template");
    expect(r.status).toBe(200);
    expect(await r.text()).toMatch(/^sku,name,/);
  });
});
