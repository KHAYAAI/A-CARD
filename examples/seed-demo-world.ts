import { connect, money, rest, runIfMain, resolveOptions, type ExampleOptions } from "./lib.js";

/**
 * Seeds the demo world every example, video and screenshot uses: Khaya
 * Logistics, an enterprise org with ZAR and USD wallets, three departments,
 * org policy, three agent cards, and a small A-MERCHANT supply market around
 * Johannesburg. Merchant names are fictional on purpose.
 *
 *   npx tsx seed-demo-world.ts            # against http://localhost:8787
 *   ACARD_API_URL=… npx tsx seed-demo-world.ts
 *
 * Everything goes through the public API, so it works against any deployment
 * where the key's role is admin or owner. Prints the ids it created.
 */

export interface DemoWorld {
  apiKey: string;
  baseUrl: string;
  cards: { fleet: string; procurement: string; api: string };
  merchants: { randBuild: string; kopanong: string; soweto: string; vaal: string; highveld: string };
  departments: { fleet: string; procurement: string; engineering: string };
}

const MIDRAND = { lat: -25.9992, lng: 28.1263 };
const GERMISTON = { lat: -26.2309, lng: 28.1772 };
const SOWETO = { lat: -26.2485, lng: 27.854 };
const VEREENIGING = { lat: -26.6731, lng: 27.9261 };
const BOKSBURG = { lat: -26.2125, lng: 28.2626 };

export async function seedDemoWorld(options: ExampleOptions = {}): Promise<DemoWorld> {
  const { log } = resolveOptions(options);
  const { acard, apiKey, baseUrl } = await connect(options);
  const call = <T = any>(method: string, path: string, body?: unknown) => rest<T>(baseUrl, apiKey, method, path, body);

  // ---- money ---------------------------------------------------------------
  await acard.wallet.fund(50_000_000, "ZAR"); // R500 000.00
  await acard.wallet.fund(1_000_000, "USD"); // $10 000.00

  // ---- enterprise governance -------------------------------------------------
  const fleet = (await call("POST", "/v1/departments", { name: "Fleet", monthly_budget: 25_000_000, lead: "Thandi M." })).department.id;
  const procurement = (await call("POST", "/v1/departments", { name: "Procurement", monthly_budget: 40_000_000, lead: "Sipho N." })).department.id;
  const engineering = (await call("POST", "/v1/departments", { name: "Engineering", monthly_budget: 5_000_000, lead: "Ayanda K." })).department.id;
  await call("PUT", "/v1/policy", { blocked_merchant_categories: ["7995"], approval_threshold: 2_500_000 });

  // ---- agent cards -------------------------------------------------------------
  const fleetCard = await acard.cards.create({
    label: "fleet-agent-07",
    department_id: fleet,
    single_use: false,
    limits: { per_transaction: 500_000, total: 4_000_000, velocity: { amount: 1_500_000, window_seconds: 86_400 } },
    allowed_merchant_categories: ["5541", "5542", "7538"],
  });
  const procurementCard = await acard.cards.create({
    label: "procurement-bot-03",
    department_id: procurement,
    single_use: false,
    limits: { per_transaction: 2_500_000, total: 9_000_000 },
    allowed_merchant_categories: ["5200", "5211", "5251"],
    approval_threshold: 800_000,
  });
  // USD cards on the free plan are capped at $50 total.
  const apiCard = await acard.cards.create({
    label: "api-agent",
    department_id: engineering,
    currency: "USD",
    single_use: false,
    limits: { per_transaction: 2_000, total: 5_000 },
    allowed_merchant_categories: ["5734", "7372"],
  });

  // ---- A-MERCHANT supply ----------------------------------------------------------
  const merchant = async (input: {
    name: string;
    mcc: string;
    at: { lat: number; lng: number };
    city: string;
    radius: number;
    reg: string;
    verified: boolean;
    items: Array<Record<string, unknown>>;
  }) => {
    const created = await call("POST", "/v1/merchants", {
      name: input.name,
      merchant_category_code: input.mcc,
      address: { addressLine: "Main Reef Road", city: input.city, province: "Gauteng", country: "ZA", ...input.at },
      service_radius_km: input.radius,
      kyb: { registration_number: input.reg, contact_email: `orders@${input.name.toLowerCase().replace(/[^a-z]+/g, "")}.example` },
    });
    const id = created.merchant.id as string;
    for (const item of input.items) await call("PUT", `/v1/merchants/${id}/items`, item);
    if (input.verified) await call("POST", `/v1/merchants/${id}/kyb`, { status: "verified", note: "demo world" });
    return id;
  };

  const cement = (price: number, qty: number, lead: number) => ({
    sku: "CEM-425-50",
    name: "Cement 42.5N 50kg",
    unit: "bag",
    unit_price_cents: price,
    availability: qty > 100 ? "in_stock" : "low_stock",
    quantity_available: qty,
    lead_time_days: lead,
  });

  const randBuild = await merchant({
    name: "Rand Build Supply", mcc: "5211", at: MIDRAND, city: "Midrand", radius: 60, reg: "2015/123456/07", verified: true,
    items: [cement(11_500, 900, 1), { sku: "SAND-PLS-1T", name: "Plaster sand (1 ton)", unit: "ton", unit_price_cents: 62_000, quantity_available: 40, lead_time_days: 1 }],
  });
  const kopanong = await merchant({
    name: "Kopanong Cement", mcc: "5211", at: GERMISTON, city: "Germiston", radius: 40, reg: "2018/654321/07", verified: true,
    items: [cement(10_900, 120, 0)],
  });
  const soweto = await merchant({
    name: "Soweto Builders Depot", mcc: "5211", at: SOWETO, city: "Soweto", radius: 50, reg: "2011/222333/07", verified: true,
    items: [cement(10_400, 2_000, 3)],
  });
  const vaal = await merchant({
    name: "Vaal Hardware", mcc: "5251", at: VEREENIGING, city: "Vereeniging", radius: 80, reg: "2020/777888/07", verified: false,
    items: [cement(9_900, 600, 1)],
  });
  const highveld = await merchant({
    name: "Highveld Tyre & Fuel", mcc: "5541", at: BOKSBURG, city: "Boksburg", radius: 30, reg: "2009/444555/07", verified: true,
    items: [
      { sku: "DSL-50PPM", name: "Diesel 50ppm", unit: "litre", unit_price_cents: 2_310, availability: "in_stock", quantity_available: 30_000, lead_time_days: 0 },
      { sku: "TYR-315-80", name: "Truck tyre 315/80 R22.5", unit: "each", unit_price_cents: 685_000, quantity_available: 12, lead_time_days: 1 },
    ],
  });

  log(`Seeded Khaya Logistics at ${baseUrl}`);
  log(`  wallets      ${money(50_000_000)} · ${money(1_000_000, "USD")}`);
  log(`  departments  Fleet ${fleet} · Procurement ${procurement} · Engineering ${engineering}`);
  log(`  policy       MCC 7995 blocked · org approval threshold ${money(2_500_000)}`);
  log(`  cards        fleet-agent-07 ${fleetCard.id} · procurement-bot-03 ${procurementCard.id} · api-agent ${apiCard.id}`);
  log(`  merchants    5 (Vaal Hardware left pending KYB, so agents never see it)`);
  log(`  API key      ${apiKey}`);

  return {
    apiKey,
    baseUrl,
    cards: { fleet: fleetCard.id, procurement: procurementCard.id, api: apiCard.id },
    merchants: { randBuild, kopanong, soweto, vaal, highveld },
    departments: { fleet, procurement, engineering },
  };
}

runIfMain(import.meta.url, () => seedDemoWorld());
