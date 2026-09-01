import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { MerchantDirectory } from "@acard/core";
import { PostgresMerchantAuth, PostgresMerchantDirectory } from "../src/merchant/index.js";

/**
 * Integration tests for the multi-writer Postgres A-MERCHANT adapter —
 * exercises the real tables and the real `FOR UPDATE` row locks, same
 * spirit as `pg-service.test.ts` for the ledger. Skipped unless
 * ACARD_TEST_DATABASE_URL points at a reachable Postgres.
 *
 * The most important test in this file is not a feature test — it is
 * `search() matches the in-memory directory exactly`, which seeds identical
 * data into both backends and asserts the ranked results are the same
 * object, in the same order. That is the actual proof that pushing
 * *retrieval* to SQL while keeping `evaluateOffers` as the single shared
 * *ranking* implementation didn't silently change what an agent sees.
 */
const DB_URL = process.env.ACARD_TEST_DATABASE_URL;
const suite = DB_URL ? describe : describe.skip;

const directory = DB_URL ? new PostgresMerchantDirectory(DB_URL) : (undefined as unknown as PostgresMerchantDirectory);
const auth = DB_URL ? new PostgresMerchantAuth(DB_URL) : (undefined as unknown as PostgresMerchantAuth);

const TABLES = ["acard_merchant_sessions", "acard_merchant_invites", "acard_merchant_users", "acard_catalog_items", "acard_merchants"];

async function truncateAll() {
  await (directory as unknown as { pool: { query: (sql: string) => Promise<unknown> } }).pool.query(
    `TRUNCATE ${TABLES.join(", ")} CASCADE`,
  );
}

const JOBURG = { lat: -26.2041, lng: 28.0473, addressLine: "1 Main Road", city: "Johannesburg", province: "Gauteng", country: "ZA" };
const PRETORIA = { lat: -25.7479, lng: 28.2293, addressLine: "1 Church St", city: "Pretoria", province: "Gauteng", country: "ZA" };

async function registerVerified(
  dir: { register: (input: any) => any; setStatus: (id: string, status: any, reviewer: string, note?: string) => any },
  name: string,
  overrides: Record<string, unknown> = {},
) {
  const merchant = await dir.register({
    name,
    merchantCategoryCode: "5211",
    address: JOBURG,
    serviceRadiusKm: 30,
    kyb: { registrationNumber: "2019/123456/07", contactEmail: "orders@example.co.za" },
    ...overrides,
  });
  return dir.setStatus(merchant.id, "verified", "compliance@a-card.cc");
}

suite("PostgresMerchantDirectory (multi-writer)", () => {
  beforeEach(async () => {
    await directory.migrate();
    await truncateAll();
  });

  it("migrate() is idempotent — safe to call on every boot", async () => {
    await directory.migrate();
    await directory.migrate();
  });

  it("registers as pending_kyb, requires an attributed KYB decision, and only then is discoverable", async () => {
    const merchant = await directory.register({
      name: "Kasi Hardware",
      merchantCategoryCode: "5211",
      address: JOBURG,
      kyb: { registrationNumber: "2019/123456/07", contactEmail: "orders@example.co.za" },
    });
    expect(merchant.status).toBe("pending_kyb");
    expect(merchant.kyb.documents).toEqual([]);

    await directory.upsertItem(merchant.id, { sku: "CEM-50", name: "Cement 50kg", unitPriceCents: 10_800 });
    const before = await directory.search({ text: "cement" });
    expect(before.offers).toHaveLength(0);
    expect(before.excluded[0]?.reason).toBe("merchant is pending_kyb");

    await expect(directory.setStatus(merchant.id, "verified", "")).rejects.toThrow(/reviewer/);
    await directory.setStatus(merchant.id, "verified", "compliance@a-card.cc", "CIPC docs on file");

    const after = await directory.search({ text: "cement" });
    expect(after.offers).toHaveLength(1);
    const reloaded = await directory.get(merchant.id);
    expect(reloaded.kyb.reviewedBy).toBe("compliance@a-card.cc");
    expect(reloaded.kyb.note).toBe("CIPC docs on file");
  });

  it("attaches a KYB document without touching the review trail, and requires an uploader", async () => {
    const merchant = await registerVerified(directory, "Kasi Hardware");
    await expect(directory.attachKybDocument(merchant.id, { key: "kyb/x/1.pdf", filename: "reg.pdf", contentType: "application/pdf", uploadedBy: "" })).rejects.toThrow(
      /uploaded it/,
    );
    const updated = await directory.attachKybDocument(merchant.id, {
      key: "kyb/x/1.pdf",
      filename: "reg.pdf",
      contentType: "application/pdf",
      uploadedBy: "dev@example.co.za",
    });
    expect(updated.kyb.documents).toHaveLength(1);
    expect(updated.kyb.reviewedBy).toBe("compliance@a-card.cc"); // untouched
  });

  it("does not treat a price edit as a stock count (the freshness clock)", async () => {
    const merchant = await registerVerified(directory, "Kasi Hardware");
    const item = await directory.upsertItem(merchant.id, { sku: "CEM-50", name: "Cement 50kg", unitPriceCents: 10_800, quantityAvailable: 900 });
    const countedAt = item.inventoryUpdatedAt;

    const repriced = await directory.upsertItem(merchant.id, { sku: "CEM-50", name: "Cement 50kg", unitPriceCents: 11_200 });
    expect(repriced.unitPriceCents).toBe(11_200);
    expect(repriced.inventoryUpdatedAt).toBe(countedAt);

    const restated = await directory.restate(item.id, { availability: "low_stock", quantityAvailable: 12 });
    expect(restated.inventoryUpdatedAt).not.toBe(countedAt);
    expect(restated.availability).toBe("low_stock");
  });

  it("removeItem 404s on an unknown id, and real deletion is real", async () => {
    const merchant = await registerVerified(directory, "Kasi Hardware");
    const item = await directory.upsertItem(merchant.id, { sku: "CEM", name: "Cement 50kg", unitPriceCents: 10_800 });
    await directory.removeItem(item.id);
    await expect(directory.getItem(item.id)).rejects.toThrow();
    await expect(directory.removeItem(item.id)).rejects.toThrow();
  });

  it("reports catalog health matching classifyFreshness", async () => {
    const merchant = await registerVerified(directory, "Kasi Hardware");
    await directory.upsertItem(merchant.id, { sku: "A", name: "Cement 50kg", unitPriceCents: 10_800 });
    const health = await directory.catalogHealth(merchant.id);
    expect(health).toMatchObject({ items: 1, fresh: 1, stale: 0 });
  });

  it("answers the cement query — real SQL retrieval, real ranking", async () => {
    const a = await registerVerified(directory, "Merchant A");
    const b = await registerVerified(directory, "Merchant B");
    const c = await registerVerified(directory, "Merchant C");
    const far = await registerVerified(directory, "Pretoria Builders", { address: PRETORIA });

    await directory.upsertItem(a.id, { sku: "CEM", name: "Cement 50kg", unit: "bag", unitPriceCents: 10_800, quantityAvailable: 900, leadTimeDays: 1 });
    await directory.upsertItem(b.id, { sku: "CEM", name: "Cement 50kg", unit: "bag", unitPriceCents: 11_300, quantityAvailable: 900, leadTimeDays: 0 });
    await directory.upsertItem(c.id, { sku: "CEM", name: "Cement 50kg", unit: "bag", unitPriceCents: 10_560, quantityAvailable: 900, leadTimeDays: 3 });
    await directory.upsertItem(far.id, { sku: "CEM", name: "Cement 50kg", unit: "bag", unitPriceCents: 9_000, quantityAvailable: 900, leadTimeDays: 1 });

    const result = await directory.search({
      text: "cement",
      quantity: 500,
      near: { ...JOBURG, radiusKm: 15 },
      maxTotalCents: 6_000_000,
      maxLeadTimeDays: 1,
    });

    const names = result.offers.map((o) => o.merchant.name);
    expect(names).toContain("Merchant A");
    expect(names).toContain("Merchant B");
    expect(names).not.toContain("Merchant C");
    expect(names).not.toContain("Pretoria Builders");
    expect(result.excluded.some((e) => e.reason.includes("3-day lead time"))).toBe(true);
    expect(result.excluded.some((e) => e.reason.includes("search radius"))).toBe(true);
  });

  it("never fetches a non-verified merchant's items (the SQL narrowing), while still explaining why it was excluded", async () => {
    const pending = await directory.register({
      name: "Not Yet Verified",
      merchantCategoryCode: "5211",
      address: JOBURG,
      kyb: { registrationNumber: "2020/1/07", contactEmail: "pending@example.co.za" },
    });
    await directory.upsertItem(pending.id, { sku: "CEM", name: "Cement 50kg", unitPriceCents: 1 }); // absurdly cheap — would win if ever considered

    const result = await directory.search({ text: "cement" });
    expect(result.offers).toHaveLength(0);
    expect(result.excluded[0]?.reason).toBe("merchant is pending_kyb");
  });

  it("search() matches the in-memory directory exactly, given the same data and query", async () => {
    const memory = new MerchantDirectory();
    const seeds = [
      { name: "Merchant A", price: 10_800, lead: 1, addr: JOBURG },
      { name: "Merchant B", price: 11_300, lead: 0, addr: JOBURG },
      { name: "Merchant C", price: 10_560, lead: 3, addr: JOBURG },
      { name: "Pretoria Builders", price: 9_000, lead: 1, addr: PRETORIA },
    ];
    for (const seed of seeds) {
      const pgMerchant = await registerVerified(directory, seed.name, { address: seed.addr });
      await directory.upsertItem(pgMerchant.id, {
        sku: "CEM",
        name: "Cement 50kg",
        unit: "bag",
        unitPriceCents: seed.price,
        quantityAvailable: 900,
        leadTimeDays: seed.lead,
      });

      const memMerchant = memory.register({
        name: seed.name,
        merchantCategoryCode: "5211",
        address: seed.addr,
        serviceRadiusKm: 30,
        kyb: { registrationNumber: "2019/123456/07", contactEmail: "orders@example.co.za" },
      });
      memory.setStatus(memMerchant.id, "verified", "compliance@a-card.cc");
      memory.upsertItem(memMerchant.id, {
        sku: "CEM",
        name: "Cement 50kg",
        unit: "bag",
        unitPriceCents: seed.price,
        quantityAvailable: 900,
        leadTimeDays: seed.lead,
      });
    }

    const query = { text: "cement", quantity: 500, near: { ...JOBURG, radiusKm: 15 }, maxTotalCents: 6_000_000, maxLeadTimeDays: 1 };
    const pgResult = await directory.search(query);
    const memResult = memory.search(query);

    expect(pgResult.considered).toBe(memResult.considered);
    expect(pgResult.offers.map((o) => ({ name: o.merchant.name, score: o.score, matchReasons: o.matchReasons }))).toEqual(
      memResult.offers.map((o) => ({ name: o.merchant.name, score: o.score, matchReasons: o.matchReasons })),
    );
    expect(pgResult.excluded.map((e) => e.reason).sort()).toEqual(memResult.excluded.map((e) => e.reason).sort());
  });

  it("concurrent restates on the same item serialize correctly under the row lock", async () => {
    const merchant = await registerVerified(directory, "Kasi Hardware");
    const item = await directory.upsertItem(merchant.id, { sku: "CEM", name: "Cement 50kg", unitPriceCents: 10_800, quantityAvailable: 100 });

    await Promise.all(
      Array.from({ length: 10 }, (_, i) => directory.restate(item.id, { availability: "in_stock", quantityAvailable: 100 - i })),
    );
    const final = await directory.getItem(item.id);
    expect([...Array(10).keys()].map((i) => 100 - i)).toContain(final.quantityAvailable);
  });
});

afterAll(async () => {
  if (DB_URL) await directory.close();
});

suite("PostgresMerchantAuth (multi-writer)", () => {
  beforeEach(async () => {
    await directory.migrate();
    await truncateAll();
  });

  it("requires an attributed invite, same as the in-memory service", async () => {
    await expect(auth.createInvite("mch_1", "owner", "")).rejects.toThrow(/issued it/);
  });

  it("redeems an invite into a new user, and refuses a second redemption", async () => {
    const merchant = await registerVerified(directory, "Kasi Hardware");
    const { token } = await auth.createInvite(merchant.id, "owner", "compliance@a-card.cc");
    const user = await auth.redeemInvite(token, { workosUserId: "wu_1", email: "owner@kasi.co.za", name: "Thabo" });
    expect(user.merchantId).toBe(merchant.id);
    expect(user.role).toBe("owner");

    await expect(auth.redeemInvite(token, { workosUserId: "wu_1", email: "owner@kasi.co.za", name: "Thabo" })).rejects.toThrow(
      /already been used/,
    );
  });

  it("the same WorkOS identity redeeming twice for the same merchant reuses the user", async () => {
    const merchant = await registerVerified(directory, "Kasi Hardware");
    const profile = { workosUserId: "wu_2", email: "owner@kasi.co.za", name: "Thabo" };
    const first = await auth.createInvite(merchant.id, "owner", "compliance@a-card.cc");
    const userFirst = await auth.redeemInvite(first.token, profile);
    const second = await auth.createInvite(merchant.id, "staff", "compliance@a-card.cc");
    const userSecond = await auth.redeemInvite(second.token, profile);
    expect(userSecond.id).toBe(userFirst.id);
  });

  it("issues, resolves, and revokes a session", async () => {
    const merchant = await registerVerified(directory, "Kasi Hardware");
    const { token: inviteToken } = await auth.createInvite(merchant.id, "owner", "compliance@a-card.cc");
    const user = await auth.redeemInvite(inviteToken, { workosUserId: "wu_3", email: "owner@kasi.co.za", name: "Thabo" });
    const { token } = await auth.createSession(user);

    expect(await auth.resolveSession(token)).toEqual({ merchantUserId: user.id, merchantId: merchant.id, role: "owner" });
    await auth.revokeSession(token);
    expect(await auth.resolveSession(token)).toBeUndefined();
  });

  it("never stores the plaintext invite or session token", async () => {
    const merchant = await registerVerified(directory, "Kasi Hardware");
    const { token: inviteToken } = await auth.createInvite(merchant.id, "owner", "compliance@a-card.cc");
    const user = await auth.redeemInvite(inviteToken, { workosUserId: "wu_4", email: "owner@kasi.co.za", name: "Thabo" });
    const { token: sessionToken } = await auth.createSession(user);

    const dump = await (
      directory as unknown as { pool: { query: (sql: string) => Promise<{ rows: any[] }> } }
    ).pool.query("SELECT hashed_token FROM acard_merchant_invites UNION ALL SELECT hashed_token FROM acard_merchant_sessions");
    const stored = JSON.stringify(dump.rows);
    expect(stored).not.toContain(inviteToken);
    expect(stored).not.toContain(sessionToken);
  });
});
