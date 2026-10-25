import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { z, type ZodTypeAny } from "zod";
import { Platform } from "@acard/core";
import { InMemoryMerchantDirectory } from "../src/merchant/index.js";
import { createApp } from "../src/app.js";
import { buildOpenApi, ROUTES, toHonoPath } from "../src/openapi.js";
import { renderMarkdown } from "../src/openapiMarkdown.js";
import * as R from "../src/responses.js";

/**
 * Keeps the published API reference honest in three ways:
 *   1. every route app.ts registers is documented, and nothing documented is missing from the app;
 *   2. the committed docs/api/openapi.json is exactly what the generator produces today;
 *   3. real responses parse against the documented component schemas, deep-strict —
 *      an undocumented field fails here rather than silently missing from the spec.
 */

const appSource = readFileSync(fileURLToPath(new URL("../src/app.ts", import.meta.url)), "utf8");

function registeredRoutes(): string[] {
  // Every route in app.ts is registered as `app.<method>("<path>"` — including
  // the conditionally mounted ones, which an instantiated app would hide.
  const found = [...appSource.matchAll(/\bapp\.(get|post|put|patch|delete)\(\s*"([^"]+)"/g)];
  return [...new Set(found.map((m) => `${(m[1] ?? "").toUpperCase()} ${m[2]}`))].sort();
}

function documentedRoutes(): string[] {
  return [...new Set(ROUTES.map((r) => `${r.method.toUpperCase()} ${toHonoPath(r.path)}`))].sort();
}

/** Recursively applies `.strict()` so an unexpected field anywhere fails the parse. */
function deepStrict(schema: ZodTypeAny): ZodTypeAny {
  if (schema instanceof z.ZodObject) {
    const shape = Object.fromEntries(Object.entries(schema.shape).map(([k, v]) => [k, deepStrict(v as ZodTypeAny)]));
    return z.object(shape).strict();
  }
  if (schema instanceof z.ZodArray) return z.array(deepStrict(schema.element));
  if (schema instanceof z.ZodOptional) return deepStrict(schema.unwrap()).optional();
  if (schema instanceof z.ZodNullable) return deepStrict(schema.unwrap()).nullable();
  if (schema instanceof z.ZodUnion) return z.union(schema.options.map(deepStrict) as [ZodTypeAny, ZodTypeAny]);
  if (schema instanceof z.ZodRecord) return z.record(schema.keySchema, deepStrict(schema.valueSchema));
  return schema;
}

function expectShape(schema: ZodTypeAny, value: unknown) {
  const result = deepStrict(schema).safeParse(value);
  if (!result.success) throw new Error(JSON.stringify(result.error.issues, null, 2));
}

describe("OpenAPI reference", () => {
  it("documents every route app.ts registers, and nothing it does not", () => {
    const registered = registeredRoutes();
    const documented = documentedRoutes();
    expect(documented.filter((r) => !registered.includes(r))).toEqual([]);
    expect(registered.filter((r) => !documented.includes(r))).toEqual([]);
    expect(registered.length).toBeGreaterThan(100);
  });

  it("has no duplicate operations", () => {
    const keys = ROUTES.map((r) => `${r.method} ${r.path}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("matches the committed docs/api/openapi.json (run `npm run openapi` to refresh)", () => {
    const committed = readFileSync(fileURLToPath(new URL("../../../docs/api/openapi.json", import.meta.url)), "utf8");
    expect(JSON.parse(committed)).toEqual(JSON.parse(JSON.stringify(buildOpenApi())));
  });

  it("matches the committed docs/api/reference.md (run `npm run openapi` to refresh)", () => {
    const committed = readFileSync(fileURLToPath(new URL("../../../docs/api/reference.md", import.meta.url)), "utf8");
    expect(committed).toBe(renderMarkdown(JSON.parse(JSON.stringify(buildOpenApi()))));
  });

  it("gives every operation a unique operationId and resolvable $refs", () => {
    const doc = buildOpenApi() as any;
    const ids: string[] = [];
    for (const methods of Object.values(doc.paths) as any[]) for (const op of Object.values(methods) as any[]) ids.push(op.operationId);
    expect(new Set(ids).size).toBe(ids.length);
    const refs = [...JSON.stringify(doc).matchAll(/"\$ref":"#\/components\/(schemas|responses)\/([A-Za-z]+)"/g)];
    for (const [, kind, name] of refs) expect(doc.components[kind as string][name as string], `${kind}/${name}`).toBeDefined();
  });
});

describe("documented response shapes match real responses", () => {
  let app: ReturnType<typeof createApp>;
  let key: string;
  const authed = (path: string, init: RequestInit = {}) =>
    app.request(path, { ...init, headers: { authorization: `Bearer ${key}`, "content-type": "application/json", ...(init.headers ?? {}) } });
  const post = async (path: string, body: unknown) => (await authed(path, { method: "POST", body: JSON.stringify(body) })).json() as Promise<any>;
  const get = async (path: string) => (await authed(path)).json() as Promise<any>;

  beforeAll(async () => {
    const platform = new Platform();
    app = createApp({ platform, issuerWebhookSecret: "whsec_test", merchants: new InMemoryMerchantDirectory(platform.merchants) });
    const res = await app.request("/v1/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "docs@example.com", name: "Docs Org", currency: "ZAR" }),
    });
    const body = (await res.json()) as any;
    expectShape(z.object({ account_holder: R.accountHolder, api_key: z.string(), api_key_id: z.string() }), body);
    key = body.api_key;
  });

  it("wallets, cards, transactions, approvals", async () => {
    await post("/v1/wallet/fund", { amount: 1_000_000 });
    const wallet = await get("/v1/wallet");
    expectShape(z.object({ wallet: R.walletBalance, wallets: z.array(R.walletBalance) }), wallet);

    const created = await post("/v1/cards", {
      label: "procurement-bot-03",
      limits: { per_transaction: 2_500_000, total: 9_000_000, velocity: { amount: 5_000_000, window_seconds: 86_400 } },
      allowed_merchant_categories: ["5200", "5211"],
      approval_threshold: 800_000,
      single_use: false,
    });
    expectShape(z.object({ card: R.createdCard }), created);
    const cardId = created.card.id;

    expectShape(z.object({ cards: z.array(R.card) }), await get("/v1/cards"));
    expectShape(z.object({ card: R.card }), await get(`/v1/cards/${cardId}`));

    const simulated = z.object({
      authorization_id: z.string(),
      approved: z.boolean(),
      decline_reason: z.string().optional(),
      approval_id: z.string().optional(),
      wallet: R.walletBalance,
    });
    const ok = await post("/v1/simulate/purchase", { card_id: cardId, amount: 50_000, merchant: { name: "Rand Build Supply", category: "5211" } });
    expectShape(simulated, ok);
    expect(ok.approved).toBe(true);
    const declined = await post("/v1/simulate/purchase", { card_id: cardId, amount: 50_000, merchant: { name: "Game Electronics", category: "5732" } });
    expectShape(simulated, declined);
    expect(declined.decline_reason).toBe("merchant_category_not_allowed");
    const held = await post("/v1/simulate/purchase", { card_id: cardId, amount: 1_840_000, merchant: { name: "Rand Build Supply", category: "5211" } });
    expect(held.decline_reason).toBe("pending_human_approval");

    expectShape(z.object({ transactions: z.array(R.cardTransaction) }), await get("/v1/transactions"));
    expectShape(z.object({ audit: z.array(R.cardTransaction) }), await get("/v1/audit"));
    expectShape(z.object({ approvals: z.array(R.approval) }), await get("/v1/approvals"));
    expectShape(z.object({ approval: R.approval }), await post(`/v1/approvals/${held.approval_id}/approve`, {}));
    expectShape(z.object({ card: R.card }), await post(`/v1/cards/${cardId}/close`, {}));
  });

  it("errors carry { error: { code, message } }", async () => {
    const res = await authed("/v1/cards/card_missing");
    expect(res.status).toBe(404);
    expectShape(R.errorBody, await res.json());
    const invalid = await authed("/v1/cards", { method: "POST", body: JSON.stringify({ limits: { total: -5 } }) });
    expect(invalid.status).toBe(400);
    const body = (await invalid.json()) as any;
    expectShape(R.errorBody, body);
    expect(body.error.code).toBe("invalid_request");
  });

  it("A-MERCHANT search, merchant detail and orders", async () => {
    const merchant = await post("/v1/merchants", {
      name: "Rand Build Supply",
      merchant_category_code: "5211",
      address: { addressLine: "12 Old Pretoria Rd", city: "Midrand", province: "Gauteng", country: "ZA", lat: -25.99, lng: 28.13 },
      service_radius_km: 40,
      kyb: { registration_number: "2015/123456/07", contact_email: "orders@randbuild.example" },
    });
    const merchantId = merchant.merchant.id;
    await post(`/v1/merchants/${merchantId}/kyb`, { status: "verified" });
    const itemRes = await authed(`/v1/merchants/${merchantId}/items`, {
      method: "PUT",
      body: JSON.stringify({ sku: "CEM-425-50", name: "Cement 42.5N 50kg", unit: "bag", unit_price_cents: 11_500, availability: "in_stock", quantity_available: 900, lead_time_days: 1 }),
    });
    const item = (await itemRes.json()) as any;
    expectShape(z.object({ item: R.catalogItem }), item);

    await authed("/v1/merchant-portal/hours"); // not mounted without a portal; must not affect anything below
    const search = await get("/v1/merchants/search?q=cement&quantity=500&lat=-26.2041&lng=28.0473&radius_km=40");
    expectShape(R.offerSearchResult, search);
    expect(search.offers.length).toBe(1);

    const detail = await get(`/v1/merchants/${merchantId}`);
    expectShape(z.object({ merchant: R.publicMerchant, items: z.array(R.catalogItem), reliability: z.unknown() }), detail);
    expectShape(z.object({ merchants: z.array(R.publicMerchant) }), await get("/v1/merchants"));

    const placed = await post(`/v1/merchants/${merchantId}/orders`, {
      lines: [{ item_id: item.item.id, quantity: 500 }],
      fulfilment: { method: "delivery", address: "Khaya Logistics, Germiston", needed_by: "2026-11-01" },
    });
    expectShape(z.object({ order: R.order }), placed);
    expectShape(z.object({ orders: z.array(R.order) }), await get("/v1/orders"));
    expectShape(z.object({ order: R.order }), await get(`/v1/orders/${placed.order.id}`));
    expectShape(z.object({ order: R.order }), await post(`/v1/orders/${placed.order.id}/cancel`, {}));
  });

  it("serves the spec at /openapi.json without authentication", async () => {
    const res = await app.request("/openapi.json");
    expect(res.status).toBe(200);
    const doc = (await res.json()) as any;
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.paths["/v1/cards"].post.requestBody).toBeDefined();
  });
});
