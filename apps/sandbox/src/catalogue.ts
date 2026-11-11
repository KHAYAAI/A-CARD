/**
 * The sandbox's A-MERCHANT catalogue: fictional suppliers around Johannesburg,
 * on top of the demo world's building, fuel and hardware merchants. Prices are
 * plausible ZAR shelf prices, not quotes. Same product at several suppliers on
 * purpose, so ranking (price, distance, lead time, stock freshness) has
 * something to decide.
 */
type Call = (method: string, path: string, body?: unknown) => Promise<any>;

interface Item {
  sku: string;
  name: string;
  unit: string;
  price: number; // cents
  qty: number;
  lead: number; // days
}
interface Shop {
  name: string;
  mcc: string;
  city: string;
  at: { lat: number; lng: number };
  radius: number;
  reg: string;
  verified?: boolean;
  items: Item[];
}
const i = (sku: string, name: string, unit: string, price: number, qty: number, lead = 0): Item => ({ sku, name, unit, price, qty, lead });

export const SHOPS: Shop[] = [
  {
    name: "Fresh Basket Market", mcc: "5411", city: "Sandton", at: { lat: -26.1076, lng: 28.0567 }, radius: 40, reg: "2016/310101/07",
    items: [
      i("BRD-WH-700", "White bread 700g", "loaf", 1799, 400), i("BRD-BR-700", "Brown bread 700g", "loaf", 1899, 380),
      i("MLK-2L", "Full cream milk 2L", "bottle", 4299, 260), i("EGG-30", "Eggs, tray of 30", "tray", 11999, 90),
      i("OIL-5L", "Sunflower cooking oil 5L", "bottle", 24999, 120), i("RICE-5", "Long grain rice 5kg", "bag", 10999, 150),
      i("MAIZE-10", "Maize meal 10kg", "bag", 12999, 200), i("SUG-2.5", "White sugar 2.5kg", "bag", 5499, 210),
      i("TEA-100", "Rooibos tea bags, 100", "box", 4999, 140), i("COF-250", "Instant coffee 250g", "jar", 11999, 75),
      i("WAT-5L", "Spring water 5L", "bottle", 2999, 300),
    ],
  },
  {
    name: "Ubuntu Wholesale Grocers", mcc: "5411", city: "Soweto", at: { lat: -26.2678, lng: 27.8585 }, radius: 70, reg: "2012/118822/07",
    items: [
      i("BRD-WH-700", "White bread 700g", "loaf", 1599, 900, 1), i("MLK-2L", "Full cream milk 2L", "bottle", 3999, 500, 1),
      i("EGG-30", "Eggs, tray of 30", "tray", 10499, 300, 1), i("OIL-5L", "Sunflower cooking oil 5L", "bottle", 22999, 400, 1),
      i("RICE-5", "Long grain rice 5kg", "bag", 9499, 800, 1), i("MAIZE-10", "Maize meal 10kg", "bag", 11499, 1200, 1),
      i("SUG-2.5", "White sugar 2.5kg", "bag", 4999, 600, 1), i("WAT-5L", "Spring water 5L", "bottle", 2499, 1000, 1),
    ],
  },
  {
    name: "CityCare Pharmacy", mcc: "5912", city: "Rosebank", at: { lat: -26.1467, lng: 28.0436 }, radius: 35, reg: "2014/220033/07",
    items: [
      i("PAIN-24", "Pain tablets 24s", "box", 4599, 300), i("SAN-500", "Hand sanitiser 500ml", "bottle", 6999, 220),
      i("AID-KIT", "First aid kit, workplace", "kit", 34999, 40), i("MASK-50", "Face masks, box of 50", "box", 8999, 180),
      i("PLS-100", "Plasters assorted, 100", "box", 3999, 260), i("THERM", "Digital thermometer", "each", 12999, 60),
    ],
  },
  {
    name: "Gadget Hub SA", mcc: "5732", city: "Randburg", at: { lat: -26.0937, lng: 28.0063 }, radius: 50, reg: "2019/445566/07",
    items: [
      i("USBC-2M", "USB-C charging cable 2m", "each", 14999, 500), i("PWR-20K", "Power bank 20 000mAh", "each", 69999, 70),
      i("MOUSE-W", "Wireless mouse", "each", 29999, 120), i("STAND-L", "Laptop stand, aluminium", "each", 45999, 55),
      i("MON-24", "24\" monitor, Full HD", "each", 229999, 18, 2), i("WEB-1080", "Webcam 1080p", "each", 74999, 40),
      i("HEAD-USB", "USB headset with microphone", "each", 59999, 65), i("ROUT-AC", "Wi-Fi router, dual band", "each", 129999, 30, 1),
      i("LAP-BAG", "Laptop backpack 15.6\"", "each", 79999, 50), i("LAP-CHG", "Laptop charger 65W", "each", 59999, 45),
    ],
  },
  {
    name: "Reef Electronics Depot", mcc: "5732", city: "Germiston", at: { lat: -26.2250, lng: 28.1700 }, radius: 60, reg: "2008/992211/07",
    items: [
      i("USBC-2M", "USB-C charging cable 2m", "each", 12999, 1200, 1), i("PWR-20K", "Power bank 20 000mAh", "each", 62999, 200, 1),
      i("MOUSE-W", "Wireless mouse", "each", 24999, 400, 1), i("MON-24", "24\" monitor, Full HD", "each", 209999, 45, 3),
      i("HEAD-USB", "USB headset with microphone", "each", 52999, 150, 1),
      i("LAP-BAG", "Laptop backpack 15.6\"", "each", 69999, 120, 1), i("LAP-SLV", "Laptop sleeve 14\"", "each", 24999, 200, 1), i("LAP-CHG", "Laptop charger 65W", "each", 54999, 90, 1),
    ],
  },
  {
    name: "Paper & Pen Co", mcc: "5943", city: "Pretoria", at: { lat: -25.7479, lng: 28.2293 }, radius: 80, reg: "2013/554433/07",
    items: [
      i("A4-REAM", "A4 paper 80gsm, ream of 500", "ream", 8999, 2000, 1), i("A4-BOX", "A4 paper 80gsm, box of 5 reams", "box", 41999, 600, 1),
      i("FILE-BOX", "Box files, pack of 10", "pack", 29999, 150, 1), i("STAP-M", "Stapler, medium", "each", 6999, 200, 1),
      i("MARK-12", "Whiteboard markers, 12", "pack", 8999, 340, 1), i("TONER-BK", "Black toner cartridge", "each", 119999, 35, 2),
      i("STICKY-12", "Sticky notes, 12 pads", "pack", 5999, 500, 1),
    ],
  },
  {
    name: "OfficeNow Express", mcc: "5943", city: "Sandton", at: { lat: -26.1100, lng: 28.0500 }, radius: 40, reg: "2020/667788/07",
    items: [
      i("A4-REAM", "A4 paper 80gsm, ream of 500", "ream", 9999, 400, 0), i("MARK-12", "Whiteboard markers, 12", "pack", 9999, 80, 0),
      i("STAP-M", "Stapler, medium", "each", 7999, 60, 0), i("TONER-BK", "Black toner cartridge", "each", 124999, 12, 0),
    ],
  },
  {
    name: "Safe-T Workwear", mcc: "5699", city: "Kempton Park", at: { lat: -26.0997, lng: 28.2292 }, radius: 70, reg: "2010/771122/07",
    items: [
      i("HAT-W", "Hard hat, white", "each", 6999, 900, 1), i("BOOT-S9", "Safety boots, steel toe", "pair", 69999, 160, 1),
      i("VEST-HV", "Hi-vis vest", "each", 4999, 1200, 1), i("GLOVE-WK", "Work gloves, leather", "pair", 5999, 700, 1),
      i("GLASS-SF", "Safety glasses, clear", "each", 3999, 800, 1), i("OVER-N", "Overalls, navy", "each", 29999, 220, 2),
    ],
  },
  {
    name: "Workwear Warehouse", mcc: "5699", city: "Pretoria", at: { lat: -25.7700, lng: 28.2000 }, radius: 80, reg: "2015/445500/07",
    items: [
      i("HAT-W", "Hard hat, white", "each", 6499, 2000, 1), i("HAT-Y", "Hard hat, yellow", "each", 6499, 1500, 1), i("BOOT-S9", "Safety boots, steel toe", "pair", 64999, 400, 1),
      i("VEST-HV", "Hi-vis vest", "each", 4499, 3000, 1), i("GLOVE-WK", "Work gloves, leather", "pair", 5499, 2500, 1), i("EAR-PL", "Ear plugs, box of 200", "box", 18999, 300, 1),
    ],
  },
  {
    name: "Spotless Supplies", mcc: "5169", city: "Midrand", at: { lat: -25.9950, lng: 28.1300 }, radius: 70, reg: "2017/882233/07",
    items: [
      i("BLEACH-5", "Bleach 5L", "bottle", 6999, 400, 1), i("DISH-5", "Dishwashing liquid 5L", "bottle", 8999, 350, 1),
      i("SPRAY-750", "All-purpose cleaner 750ml", "bottle", 3499, 600, 1), i("BIN-80", "Bin bags 80L, roll of 20", "roll", 4999, 500, 1),
      i("SAN-5L", "Hand sanitiser 5L", "bottle", 24999, 120, 1),
    ],
  },
  {
    name: "Reef Auto Parts", mcc: "5533", city: "Germiston", at: { lat: -26.2100, lng: 28.1500 }, radius: 60, reg: "2011/334455/07",
    items: [
      i("OIL-5W30", "Engine oil 5W-30, 5L", "bottle", 59999, 140, 1), i("WIPER-24", "Wiper blades, pair", "pair", 19999, 220, 1),
      i("BATT-12V", "Car battery 12V", "each", 189999, 25, 1), i("BRAKE-F", "Brake pads, front set", "set", 79999, 60, 2),
      i("JUMP-C", "Jumper cables 3m", "each", 24999, 90, 1),
    ],
  },
  {
    name: "Mama Thandi Catering", mcc: "5812", city: "Soweto", at: { lat: -26.2400, lng: 27.9000 }, radius: 50, reg: "2018/119900/07",
    items: [
      i("PLAT-SAND", "Sandwich platter, serves 10", "platter", 89999, 40, 1), i("BOER-20", "Boerewors rolls, 20", "tray", 129999, 25, 1),
      i("DRINK-24", "Soft drinks, 24 cans", "case", 29999, 60, 1),
    ],
  },
  {
    name: "Pretoria Bulk Foods", mcc: "5411", city: "Centurion", at: { lat: -25.8603, lng: 28.1894 }, radius: 40, reg: "2021/101010/07", verified: false,
    items: [i("RICE-5", "Long grain rice 5kg", "bag", 6999, 5000, 2), i("MAIZE-10", "Maize meal 10kg", "bag", 8999, 5000, 2)],
  },
];

/** Extra stock for the demo world's building suppliers. */
export const EXTRA_BY_MERCHANT: Record<string, Item[]> = {
  "Rand Build Supply": [i("BRICK-500", "Face bricks, pallet of 500", "pallet", 289900, 40, 1), i("PAINT-20", "Interior wall paint 20L", "tin", 129900, 60, 1), i("TIMB-38", "Pine timber 38×114mm, 3.6m", "length", 18900, 300, 1)],
  "Kopanong Cement": [i("BRICK-500", "Face bricks, pallet of 500", "pallet", 279900, 25, 0)],
  "Soweto Builders Depot": [i("BRICK-500", "Face bricks, pallet of 500", "pallet", 259900, 200, 3), i("PAINT-20", "Interior wall paint 20L", "tin", 119900, 150, 3)],
};

/** What a visitor's words map to, for the scripted demo agent. */
export const KEYWORDS: Array<{ re: RegExp; query: string; quantity: number; label: string }> = [
  { re: /\bbread\b/i, query: "bread", quantity: 10, label: "bread" },
  { re: /\bmilk\b/i, query: "milk", quantity: 12, label: "milk" },
  { re: /\beggs?\b/i, query: "eggs", quantity: 2, label: "eggs" },
  { re: /\b(maize|mealie)\b/i, query: "maize", quantity: 5, label: "maize meal" },
  { re: /\brice\b/i, query: "rice", quantity: 5, label: "rice" },
  { re: /\b(cooking )?oil\b(?!.*engine)/i, query: "sunflower", quantity: 4, label: "cooking oil" },
  { re: /\b(coffee|tea)\b/i, query: "coffee", quantity: 3, label: "coffee" },
  { re: /\b(sanitis|sanitiz)/i, query: "sanitiser", quantity: 10, label: "hand sanitiser" },
  { re: /\b(first aid|plasters?)\b/i, query: "first aid", quantity: 2, label: "first aid kits" },
  { re: /\b(masks?)\b/i, query: "masks", quantity: 4, label: "face masks" },
  { re: /\b(pain|panado|tablets?)\b/i, query: "pain", quantity: 3, label: "pain tablets" },
  { re: /\b(usb|cable|charger)\b/i, query: "usb-c", quantity: 5, label: "USB-C cables" },
  { re: /\b(power ?bank)\b/i, query: "power bank", quantity: 2, label: "power banks" },
  { re: /\b(mouse|mice)\b/i, query: "mouse", quantity: 3, label: "wireless mice" },
  { re: /\b(monitor|screen)s?\b/i, query: "monitor", quantity: 2, label: "monitors" },
  { re: /\b(laptop|webcam|headset|router|desk)\b/i, query: "laptop", quantity: 2, label: "laptop gear" },
  { re: /\b(paper|a4|ream)s?\b/i, query: "paper", quantity: 10, label: "A4 paper" },
  { re: /\b(toner|printer)\b/i, query: "toner", quantity: 2, label: "toner" },
  { re: /\b(markers?|stapler|stationery|office)\b/i, query: "markers", quantity: 4, label: "office supplies" },
  { re: /\b(hard ?hats?|helmets?)\b/i, query: "hard hat", quantity: 10, label: "hard hats" },
  { re: /\b(boots?|workwear|safety)\b/i, query: "safety", quantity: 6, label: "safety gear" },
  { re: /\b(hi-?vis|vests?)\b/i, query: "hi-vis", quantity: 12, label: "hi-vis vests" },
  { re: /\b(gloves?)\b/i, query: "gloves", quantity: 12, label: "work gloves" },
  { re: /\b(clean(ing)?|bleach|detergent|bin bags?)\b/i, query: "bleach", quantity: 6, label: "cleaning supplies" },
  { re: /\b(engine oil|battery|wipers?|brake|car parts|auto)\b/i, query: "engine oil", quantity: 2, label: "car parts" },
  { re: /\b(catering|platter|boerewors|lunch)\b/i, query: "platter", quantity: 2, label: "catering" },
  { re: /\b(bricks?)\b/i, query: "bricks", quantity: 1, label: "bricks" },
  { re: /\b(paint)\b/i, query: "paint", quantity: 4, label: "paint" },
  { re: /\b(sand)\b/i, query: "plaster sand", quantity: 5, label: "plaster sand" },
  { re: /\b(diesel|fuel)\b/i, query: "diesel", quantity: 200, label: "diesel" },
  { re: /\b(tyres?|tires?)\b/i, query: "tyre", quantity: 4, label: "truck tyres" },
  { re: /\b(cement)\b/i, query: "cement", quantity: 50, label: "cement" },
];

export async function seedCatalogue(call: Call): Promise<{ merchants: number; items: number }> {
  let merchants = 0, items = 0;
  for (const shop of SHOPS) {
    const created = await call("POST", "/v1/merchants", {
      name: shop.name,
      merchant_category_code: shop.mcc,
      address: { addressLine: "Main Road", city: shop.city, province: "Gauteng", country: "ZA", ...shop.at },
      service_radius_km: shop.radius,
      kyb: { registration_number: shop.reg, contact_email: `orders@${shop.name.toLowerCase().replace(/[^a-z]+/g, "")}.example` },
    });
    const id = created.merchant.id as string;
    for (const it of shop.items) { await put(call, id, it); items++; }
    if (shop.verified !== false) await call("POST", `/v1/merchants/${id}/kyb`, { status: "verified", note: "sandbox catalogue" });
    merchants++;
  }
  const listed = (await call("GET", "/v1/merchants")).merchants as Array<{ id: string; name: string }>;
  for (const [name, extra] of Object.entries(EXTRA_BY_MERCHANT)) {
    const m = listed.find((x) => x.name === name);
    if (!m) continue;
    for (const it of extra) { await put(call, m.id, it); items++; }
  }
  return { merchants, items };
}

const put = (call: Call, merchantId: string, it: Item) =>
  call("PUT", `/v1/merchants/${merchantId}/items`, {
    sku: it.sku, name: it.name, unit: it.unit, unit_price_cents: it.price,
    availability: it.qty > 100 ? "in_stock" : "low_stock", quantity_available: it.qty, lead_time_days: it.lead,
  });
