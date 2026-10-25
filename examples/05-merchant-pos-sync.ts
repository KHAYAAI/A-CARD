import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { AcardMerchant, verifyMerchantWebhook, type MerchantEvent, type Order } from "@acard/sdk";
import { money, resolveOptions, runIfMain, type ExampleOptions } from "./lib.js";

/**
 * The merchant side: a till / POS integration.
 *
 *   - pushes its stock file to A-MERCHANT by SKU (agents rank fresh stock higher)
 *   - runs a webhook endpoint, verifies every delivery, and
 *   - accepts each agent order it can fill, promising a time
 *
 *   ACARD_MERCHANT_KEY=mk_live_… npx tsx 05-merchant-pos-sync.ts
 *
 * A shop owner mints the key with POST /v1/merchant-portal/api-keys
 * ({ "name": "Till 1", "scope": "read_write" }) from their portal session.
 * Set PUBLIC_WEBHOOK_URL when A-CARD can't reach localhost — e.g. an ngrok URL
 * forwarding to this process's port.
 */

/** What a POS stock export looks like. Your SKUs, your units, your prices. */
export const POS_STOCK_EXPORT = [
  { sku: "CEM-425-50", name: "Cement 42.5N 50kg", unit: "bag", price: 11_500, onHand: 900, leadDays: 1 },
  { sku: "SAND-PLS-1T", name: "Plaster sand (1 ton)", unit: "ton", price: 62_000, onHand: 40, leadDays: 1 },
  { sku: "BRK-CLAY-1K", name: "Clay stock bricks (1 000)", unit: "pallet", price: 245_000, onHand: 0, leadDays: 5 },
];

export interface PosOptions extends ExampleOptions {
  merchantKey?: string;
  /** Port for the webhook receiver. 0 = any free port. */
  port?: number;
  /** URL A-CARD should push to. Defaults to this process on localhost. */
  publicUrl?: string;
}

export async function startPos(options: PosOptions = {}) {
  const { baseUrl, log } = resolveOptions(options);
  const merchantKey = options.merchantKey ?? process.env.ACARD_MERCHANT_KEY;
  if (!merchantKey) throw new Error("Set ACARD_MERCHANT_KEY to a merchant API key (mk_live_…) from the merchant portal.");
  const shop = new AcardMerchant({ apiKey: merchantKey, baseUrl });

  // 1. Sync the stock file. One call; one bad row would never drop the rest.
  const synced = await shop.catalog.sync(
    POS_STOCK_EXPORT.map((row) => ({
      sku: row.sku,
      name: row.name,
      unit: row.unit,
      unit_price_cents: row.price,
      quantity_available: row.onHand,
      availability: row.onHand === 0 ? ("out_of_stock" as const) : row.onHand < 50 ? ("low_stock" as const) : ("in_stock" as const),
      lead_time_days: row.leadDays,
    })),
  );
  log(`Synced ${POS_STOCK_EXPORT.length} SKUs from the POS export (${JSON.stringify(synced).slice(0, 80)}…)`);

  // 2. A webhook endpoint that verifies before it trusts.
  const orders: Order[] = [];
  let secret = "";
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", async () => {
      const check = verifyMerchantWebhook(raw, req.headers["x-acard-signature"] as string | undefined, secret);
      if (!check.valid) {
        log(`Rejected a delivery: ${check.reason}`);
        res.writeHead(401).end();
        return;
      }
      res.writeHead(200).end("ok"); // acknowledge fast, work after
      const event = JSON.parse(raw) as MerchantEvent<{ order: Order }>;
      log(`← ${event.type} ${event.data.order.id}: ${event.data.order.lines.map((l) => `${l.quantity} × ${l.name}`).join(", ")} (${money(event.data.order.totalCents)})`);
      if (event.type === "order.placed") await fulfil(event.data.order);
    });
  });
  await new Promise<void>((resolve) => server.listen(options.port ?? 0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const url = options.publicUrl ?? process.env.PUBLIC_WEBHOOK_URL ?? `http://127.0.0.1:${port}/acard`;
  ({ secret } = await shop.webhook.set(url, ["order.placed", "order.cancelled"]));
  log(`Listening for orders at ${url}`);

  // 3. Accept what we can fill, with a promise we intend to keep.
  async function fulfil(order: Order) {
    const canFill = order.lines.every((line) => (POS_STOCK_EXPORT.find((row) => row.sku === line.sku)?.onHand ?? 0) >= line.quantity);
    if (!canFill) {
      await shop.orders.advance(order.id, { status: "rejected", note: "Insufficient stock at the till" });
      log(`→ rejected ${order.id}: not enough stock`);
      return;
    }
    const promisedAt = new Date(Date.now() + 24 * 3_600_000).toISOString();
    const accepted = await shop.orders.advance(order.id, { status: "accepted", promised_at: promisedAt, note: "Docket printed" });
    // Keep our own stock file honest, and tell A-MERCHANT straight away.
    for (const line of order.lines) {
      const row = POS_STOCK_EXPORT.find((r) => r.sku === line.sku)!;
      row.onHand -= line.quantity;
      await shop.catalog.restate([{ sku: row.sku, availability: row.onHand < 50 ? "low_stock" : "in_stock", quantity_available: row.onHand }]);
    }
    orders.push(accepted);
    log(`→ accepted ${order.id}, promised by ${promisedAt.slice(0, 16).replace("T", " ")}`);
  }

  // Catch anything missed while we were offline: delivery is attempted once.
  for (const missed of await shop.orders.list({ status: "placed" })) await fulfil(missed);

  return {
    shop,
    orders,
    url,
    stop: async () => {
      await shop.webhook.clear().catch(() => undefined);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

runIfMain(import.meta.url, async () => {
  const pos = await startPos();
  process.on("SIGINT", () => void pos.stop().then(() => process.exit(0)));
});
