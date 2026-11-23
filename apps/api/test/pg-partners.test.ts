import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemoryPartnerStore, PostgresPartnerStore, type PartnerStore } from "../src/partners/index.js";

/** The same contract against memory and (when ACARD_TEST_DATABASE_URL is set) Postgres. */
const DB_URL = process.env.ACARD_TEST_DATABASE_URL;
const stores: Array<[string, () => Promise<PartnerStore & { close?: () => Promise<void> }>]> = [["memory", async () => new MemoryPartnerStore()]];
if (DB_URL) stores.push(["postgres", async () => {
  const s = new PostgresPartnerStore(DB_URL);
  await s.migrate();
  await s.pool.query("TRUNCATE acard_partners, acard_partner_customers, acard_distributors");
  return s;
}]);

for (const [name, make] of stores) {
  describe(`partner store (${name})`, () => {
    let s: Awaited<ReturnType<typeof make>>;
    beforeAll(async () => { s = await make(); });
    afterAll(async () => { await s.close?.(); });

    it("stores partners, customers and distributors and enforces uniqueness", async () => {
      const p = { id: "ptn_1", accountHolderId: "ah_p", name: "P", brand: { displayName: "P Pay", primaryColor: "#000000" }, terms: { volumeBps: 100, perActiveCard: 50, monthlyMinimum: 30000, currency: "USD" }, createdAt: new Date().toISOString() };
      await s.insertPartner(p);
      await expect(s.insertPartner({ ...p, id: "ptn_2" })).rejects.toThrow();
      expect((await s.getPartnerByHolder("ah_p"))?.brand.displayName).toBe("P Pay");
      await s.insertDistributor({ id: "dst_1", name: "Hub", shareBps: 2000, createdAt: new Date().toISOString() });
      await s.updatePartner({ ...p, distributorId: "dst_1", terms: { ...p.terms, volumeBps: 80 } });
      expect(await s.getPartner("ptn_1")).toMatchObject({ distributorId: "dst_1", terms: { volumeBps: 80 } });
      await s.insertCustomer({ partnerId: "ptn_1", accountHolderId: "ah_c1", externalRef: "u1", createdAt: new Date().toISOString() });
      await expect(s.insertCustomer({ partnerId: "ptn_1", accountHolderId: "ah_c2", externalRef: "u1", createdAt: new Date().toISOString() })).rejects.toThrow();
      await expect(s.insertCustomer({ partnerId: "ptn_9", accountHolderId: "ah_c1", createdAt: new Date().toISOString() })).rejects.toThrow();
      expect((await s.getCustomerByRef("ptn_1", "u1"))?.accountHolderId).toBe("ah_c1");
      expect((await s.getCustomerByHolder("ah_c1"))?.partnerId).toBe("ptn_1");
      expect(await s.getCustomer("ptn_9", "ah_c1")).toBeUndefined();
      expect(await s.listCustomers("ptn_1")).toHaveLength(1);
      expect(await s.listDistributors()).toHaveLength(1);
    });
  });
}
