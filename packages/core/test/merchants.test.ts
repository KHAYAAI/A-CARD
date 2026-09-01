import { describe, expect, it } from "vitest";
import {
  AGING_INVENTORY_HOURS,
  classifyFreshness,
  distanceKm,
  FRESH_INVENTORY_HOURS,
  MerchantDirectory,
  Platform,
  publicMerchant,
  type Merchant,
} from "../src/index.js";

const HOUR = 3_600_000;

// Real Johannesburg coordinates — distance assertions below are checked
// against actual straight-line separations, not invented ones.
const JOBURG_CBD = { lat: -26.2041, lng: 28.0473 };
const MIDRAND = { lat: -25.9895, lng: 28.1284 };
const PRETORIA = { lat: -25.7479, lng: 28.2293 };

function address(point: { lat: number; lng: number }, city = "Johannesburg") {
  return { ...point, addressLine: "1 Main Road", city, province: "Gauteng", country: "ZA" };
}

function verifiedMerchant(
  directory: MerchantDirectory,
  overrides: Partial<Parameters<MerchantDirectory["register"]>[0]> = {},
): Merchant {
  const merchant = directory.register({
    name: "Kasi Hardware",
    merchantCategoryCode: "5211",
    address: address(JOBURG_CBD),
    serviceRadiusKm: 30,
    kyb: { registrationNumber: "2019/123456/07", contactEmail: "orders@kasihardware.co.za" },
    ...overrides,
  });
  return directory.setStatus(merchant.id, "verified", "compliance@a-card.cc");
}

describe("merchant registration and KYB", () => {
  it("registers as pending and stays invisible to discovery until verified", () => {
    const directory = new MerchantDirectory();
    const merchant = directory.register({
      name: "Kasi Hardware",
      merchantCategoryCode: "5211",
      address: address(JOBURG_CBD),
      kyb: { registrationNumber: "2019/123456/07", contactEmail: "orders@kasihardware.co.za" },
    });
    expect(merchant.status).toBe("pending_kyb");

    directory.upsertItem(merchant.id, { sku: "CEM-50", name: "Cement 50kg", unitPriceCents: 10_800 });
    const before = directory.search({ text: "cement" });
    expect(before.offers).toHaveLength(0);
    expect(before.excluded[0]?.reason).toBe("merchant is pending_kyb");

    directory.setStatus(merchant.id, "verified", "compliance@a-card.cc");
    expect(directory.search({ text: "cement" }).offers).toHaveLength(1);
  });

  it("records who made the KYB decision, and refuses an unattributed one", () => {
    const directory = new MerchantDirectory();
    const merchant = verifiedMerchant(directory);
    expect(directory.get(merchant.id).kyb.reviewedBy).toBe("compliance@a-card.cc");
    expect(directory.get(merchant.id).kyb.reviewedAt).toBeTruthy();
    expect(() => directory.setStatus(merchant.id, "suspended", "")).toThrow(/reviewer/);
  });

  it("suspends a merchant out of discovery without deleting the catalog", () => {
    const directory = new MerchantDirectory();
    const merchant = verifiedMerchant(directory);
    directory.upsertItem(merchant.id, { sku: "CEM-50", name: "Cement 50kg", unitPriceCents: 10_800 });
    directory.setStatus(merchant.id, "suspended", "compliance@a-card.cc", "under review");

    expect(directory.search({ text: "cement" }).offers).toHaveLength(0);
    expect(directory.listItems(merchant.id)).toHaveLength(1);
  });

  it("never exposes the KYB pack in the agent-facing view", () => {
    const directory = new MerchantDirectory();
    const view = publicMerchant(directory.get(verifiedMerchant(directory).id));
    expect(view.verified).toBe(true);
    expect(JSON.stringify(view)).not.toContain("2019/123456/07");
    expect(JSON.stringify(view)).not.toContain("orders@kasihardware.co.za");
    expect("kyb" in view).toBe(false);
  });
});

describe("inventory freshness", () => {
  it("classifies against the documented thresholds", () => {
    expect(classifyFreshness(1)).toBe("fresh");
    expect(classifyFreshness(FRESH_INVENTORY_HOURS)).toBe("fresh");
    expect(classifyFreshness(FRESH_INVENTORY_HOURS + 1)).toBe("aging");
    expect(classifyFreshness(AGING_INVENTORY_HOURS + 1)).toBe("stale");
  });

  it("does not treat a price edit as a stock count", () => {
    const directory = new MerchantDirectory();
    const merchant = verifiedMerchant(directory);
    const item = directory.upsertItem(merchant.id, {
      sku: "CEM-50",
      name: "Cement 50kg",
      unitPriceCents: 10_800,
      quantityAvailable: 900,
    });
    const countedAt = item.inventoryUpdatedAt;

    const repriced = directory.upsertItem(merchant.id, { sku: "CEM-50", name: "Cement 50kg", unitPriceCents: 11_200 });
    expect(repriced.unitPriceCents).toBe(11_200);
    expect(repriced.inventoryUpdatedAt).toBe(countedAt);
    expect(repriced.updatedAt >= countedAt).toBe(true);
  });

  it("restating stock refreshes the clock", () => {
    const directory = new MerchantDirectory();
    const merchant = verifiedMerchant(directory);
    const item = directory.upsertItem(merchant.id, { sku: "CEM-50", name: "Cement 50kg", unitPriceCents: 10_800 });

    // Age the count by two weeks, then have the merchant confirm it.
    const stale = { ...item, inventoryUpdatedAt: new Date(Date.now() - 14 * 24 * HOUR).toISOString() };
    const aged = MerchantDirectory.hydrate({ merchants: [directory.get(merchant.id)], items: [stale] });
    expect(aged.search({ text: "cement" }).offers[0]?.freshness).toBe("stale");

    aged.restate(item.id, { availability: "in_stock", quantityAvailable: 900 });
    expect(aged.search({ text: "cement" }).offers[0]?.freshness).toBe("fresh");
  });

  it("reports catalog health so a stale merchant is visible before an agent finds one", () => {
    const directory = new MerchantDirectory();
    const merchant = verifiedMerchant(directory);
    const fresh = directory.upsertItem(merchant.id, { sku: "A", name: "Cement 50kg", unitPriceCents: 10_800 });
    const old = directory.upsertItem(merchant.id, { sku: "B", name: "River sand", unitPriceCents: 45_000 });

    const aged = MerchantDirectory.hydrate({
      merchants: [directory.get(merchant.id)],
      items: [fresh, { ...old, inventoryUpdatedAt: new Date(Date.now() - 30 * 24 * HOUR).toISOString() }],
    });
    const health = aged.catalogHealth(merchant.id);
    expect(health).toMatchObject({ items: 2, fresh: 1, stale: 1, aging: 0 });
  });
});

describe("discovery", () => {
  it("answers the cement question: 500 bags, within 15km, by tomorrow, under R60,000", () => {
    const directory = new MerchantDirectory();

    const a = verifiedMerchant(directory, { name: "Merchant A", address: address(JOBURG_CBD) });
    const b = verifiedMerchant(directory, { name: "Merchant B", address: address(JOBURG_CBD) });
    const c = verifiedMerchant(directory, { name: "Merchant C", address: address(JOBURG_CBD) });
    const far = verifiedMerchant(directory, { name: "Pretoria Builders", address: address(PRETORIA, "Pretoria") });

    directory.upsertItem(a.id, { sku: "CEM", name: "Cement 50kg", unit: "bag", unitPriceCents: 10_800, quantityAvailable: 900, leadTimeDays: 1 });
    directory.upsertItem(b.id, { sku: "CEM", name: "Cement 50kg", unit: "bag", unitPriceCents: 11_300, quantityAvailable: 900, leadTimeDays: 0 });
    directory.upsertItem(c.id, { sku: "CEM", name: "Cement 50kg", unit: "bag", unitPriceCents: 10_560, quantityAvailable: 900, leadTimeDays: 3 });
    directory.upsertItem(far.id, { sku: "CEM", name: "Cement 50kg", unit: "bag", unitPriceCents: 9_000, quantityAvailable: 900, leadTimeDays: 1 });

    const result = directory.search({
      text: "cement",
      quantity: 500,
      near: { ...JOBURG_CBD, radiusKm: 15 },
      maxTotalCents: 6_000_000,
      maxLeadTimeDays: 1,
    });

    const names = result.offers.map((o) => o.merchant.name);
    expect(names).toContain("Merchant A");
    expect(names).toContain("Merchant B");
    // C is cheap but three days out; Pretoria is cheapest but 50km away.
    expect(names).not.toContain("Merchant C");
    expect(names).not.toContain("Pretoria Builders");

    const offerA = result.offers.find((o) => o.merchant.name === "Merchant A");
    expect(offerA?.totalCents).toBe(5_400_000);
    expect(offerA?.quantity).toBe(500);

    // Nothing is silently dropped — the agent can see and explain each miss.
    expect(result.excluded.some((e) => e.reason.includes("3-day lead time"))).toBe(true);
    expect(result.excluded.some((e) => e.reason.includes("search radius"))).toBe(true);
  });

  it("excludes what cannot be supplied, and says why", () => {
    const directory = new MerchantDirectory();
    const merchant = verifiedMerchant(directory);
    directory.upsertItem(merchant.id, { sku: "CEM", name: "Cement 50kg", unit: "bag", unitPriceCents: 10_800, quantityAvailable: 120 });
    directory.upsertItem(merchant.id, { sku: "SAND", name: "River sand", unitPriceCents: 45_000, availability: "out_of_stock" });

    const short = directory.search({ text: "cement", quantity: 500 });
    expect(short.offers).toHaveLength(0);
    expect(short.excluded[0]?.reason).toBe("only 120 bag available, 500 requested");

    const sand = directory.search({ text: "sand" });
    expect(sand.offers).toHaveLength(0);
    expect(sand.excluded[0]?.reason).toBe("out of stock");

    const budget = directory.search({ text: "cement", quantity: 100, maxTotalCents: 1_000_000 });
    expect(budget.excluded[0]?.reason).toContain("exceeds the 1000000 budget");
  });

  it("filters to the MCCs a card is allowed to pay at", () => {
    const directory = new MerchantDirectory();
    const hardware = verifiedMerchant(directory, { name: "Kasi Hardware", merchantCategoryCode: "5211" });
    const grocer = verifiedMerchant(directory, { name: "Corner Spaza", merchantCategoryCode: "5411" });
    directory.upsertItem(hardware.id, { sku: "BAG", name: "Cement bag", unitPriceCents: 10_800 });
    directory.upsertItem(grocer.id, { sku: "BAG", name: "Cement bag", unitPriceCents: 9_900 });

    const result = directory.search({ text: "cement", merchantCategoryCodes: ["5211"] });
    expect(result.offers.map((o) => o.merchant.name)).toEqual(["Kasi Hardware"]);
    expect(result.excluded.some((e) => e.reason.includes("5411"))).toBe(true);
  });

  it("honours a merchant's agent allow-list", () => {
    const directory = new MerchantDirectory();
    const merchant = directory.register({
      name: "Contract Supplier",
      merchantCategoryCode: "5211",
      address: address(JOBURG_CBD),
      agentAccess: "allowlist",
      allowedAccountHolderIds: ["ah_trusted"],
      kyb: { registrationNumber: "2020/1/07", contactEmail: "sales@contract.co.za" },
    });
    directory.setStatus(merchant.id, "verified", "compliance@a-card.cc");
    directory.upsertItem(merchant.id, { sku: "CEM", name: "Cement 50kg", unitPriceCents: 10_000 });

    expect(directory.search({ text: "cement", requestedBy: "ah_other" }).offers).toHaveLength(0);
    expect(directory.search({ text: "cement", requestedBy: "ah_trusted" }).offers).toHaveLength(1);
    expect(directory.search({ text: "cement" }).excluded[0]?.reason).toContain("named organisations");
  });

  it("respects the merchant's own delivery radius, not just the search radius", () => {
    const directory = new MerchantDirectory();
    // Collection-only merchant 25km from the buyer, inside a 40km search.
    const merchant = verifiedMerchant(directory, { address: address(MIDRAND, "Midrand"), serviceRadiusKm: 10 });
    directory.upsertItem(merchant.id, { sku: "CEM", name: "Cement 50kg", unitPriceCents: 10_000 });

    const result = directory.search({ text: "cement", near: { ...JOBURG_CBD, radiusKm: 40 } });
    expect(result.offers).toHaveLength(0);
    expect(result.excluded[0]?.reason).toContain("delivery radius");
  });

  it("ranks fresh stock above a stale cheaper offer and explains both", () => {
    const directory = new MerchantDirectory();
    const fresh = verifiedMerchant(directory, { name: "Fresh Supplier" });
    const stale = verifiedMerchant(directory, { name: "Stale Supplier" });
    const freshItem = directory.upsertItem(fresh.id, { sku: "CEM", name: "Cement 50kg", unitPriceCents: 11_000 });
    const staleItem = directory.upsertItem(stale.id, { sku: "CEM", name: "Cement 50kg", unitPriceCents: 10_900 });

    const aged = MerchantDirectory.hydrate({
      merchants: [directory.get(fresh.id), directory.get(stale.id)],
      items: [freshItem, { ...staleItem, inventoryUpdatedAt: new Date(Date.now() - 21 * 24 * HOUR).toISOString() }],
    });

    const offers = aged.search({ text: "cement" }).offers;
    expect(offers[0]?.merchant.name).toBe("Fresh Supplier");
    expect(offers[0]?.matchReasons).toContain("stock confirmed in the last 24h");
    expect(offers[1]?.matchReasons).toContain("stock not confirmed in over a week — verify before ordering");
    // The cheaper offer is still returned — downranked, not hidden.
    expect(offers[1]?.matchReasons).toContain("lowest total price");
  });

  it("can refuse stale inventory outright when the agent insists on a recent count", () => {
    const directory = new MerchantDirectory();
    const merchant = verifiedMerchant(directory);
    const item = directory.upsertItem(merchant.id, { sku: "CEM", name: "Cement 50kg", unitPriceCents: 10_800 });
    const aged = MerchantDirectory.hydrate({
      merchants: [directory.get(merchant.id)],
      items: [{ ...item, inventoryUpdatedAt: new Date(Date.now() - 72 * HOUR).toISOString() }],
    });

    expect(aged.search({ text: "cement" }).offers).toHaveLength(1);
    const strict = aged.search({ text: "cement", maxInventoryAgeHours: 24 });
    expect(strict.offers).toHaveLength(0);
    expect(strict.excluded[0]?.reason).toContain("stock last confirmed");
  });

  it("scores a single result without dividing by a zero spread", () => {
    const directory = new MerchantDirectory();
    const merchant = verifiedMerchant(directory);
    directory.upsertItem(merchant.id, { sku: "CEM", name: "Cement 50kg", unitPriceCents: 10_800 });
    const offer = directory.search({ text: "cement" }).offers[0];
    expect(offer?.score).toBe(1);
    expect(Number.isFinite(offer?.score)).toBe(true);
  });

  it("rejects a nonsense quantity rather than guessing", () => {
    const directory = new MerchantDirectory();
    expect(() => directory.search({ quantity: 0 })).toThrow(/positive integer/);
  });
});

describe("distance", () => {
  it("matches real separations between Gauteng landmarks", () => {
    // Johannesburg CBD to Pretoria is roughly 50km straight-line.
    expect(distanceKm(JOBURG_CBD, PRETORIA)).toBeGreaterThan(45);
    expect(distanceKm(JOBURG_CBD, PRETORIA)).toBeLessThan(56);
    expect(distanceKm(JOBURG_CBD, JOBURG_CBD)).toBe(0);
  });
});

describe("platform integration", () => {
  it("survives a snapshot round trip, and hydrates a pre-A-MERCHANT snapshot", () => {
    const platform = new Platform();
    const merchant = platform.merchants.register({
      name: "Kasi Hardware",
      merchantCategoryCode: "5211",
      address: address(JOBURG_CBD),
      kyb: { registrationNumber: "2019/123456/07", contactEmail: "orders@kasihardware.co.za" },
    });
    platform.merchants.setStatus(merchant.id, "verified", "compliance@a-card.cc");
    platform.merchants.upsertItem(merchant.id, { sku: "CEM", name: "Cement 50kg", unitPriceCents: 10_800 });

    const snapshot = platform.serialize();
    const restored = Platform.hydrate(JSON.parse(JSON.stringify(snapshot)));
    expect(restored.merchants.search({ text: "cement" }).offers).toHaveLength(1);
    expect(restored.merchants.get(merchant.id).kyb.reviewedBy).toBe("compliance@a-card.cc");

    const { merchants: _dropped, ...older } = snapshot;
    const legacy = Platform.hydrate(older as typeof snapshot);
    expect(legacy.merchants.list()).toHaveLength(0);
  });
});
