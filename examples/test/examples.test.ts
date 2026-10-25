import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serve } from "@hono/node-server";
import { Platform } from "@acard/core";
import { Acard } from "@acard/sdk";
import { createApp } from "../../apps/api/src/app.js";
import { InMemoryMerchantAuth, InMemoryMerchantDirectory } from "../../apps/api/src/merchant/index.js";
import { seedDemoWorld, type DemoWorld } from "../seed-demo-world.js";
import { procure, approvePending } from "../03-procurement-agent.js";
import { startPos } from "../05-merchant-pos-sync.js";
import { fleetTools } from "../02-claude-fuel-agent.js";

/**
 * Every example, run for real against a live API over HTTP. The bash and
 * Python examples run as child processes exactly as a reader would run them.
 * The Claude example's tools are exercised directly — calling the model needs
 * Anthropic credentials this suite doesn't assume.
 */

const run = promisify(execFile);
const here = fileURLToPath(new URL("..", import.meta.url));

let api: ReturnType<typeof serve>;
let baseUrl: string;
let platform: Platform;
let world: DemoWorld;
const lines: string[] = [];
const log = (line: string) => lines.push(line);

beforeAll(async () => {
  platform = new Platform();
  const app = createApp({
    platform,
    issuerWebhookSecret: "whsec_examples",
    merchants: new InMemoryMerchantDirectory(platform.merchants),
    merchantAuth: new InMemoryMerchantAuth(platform.merchantAuth),
  });
  await new Promise<void>((resolve) => {
    api = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info) => {
      baseUrl = `http://127.0.0.1:${info.port}`;
      resolve();
    });
  });
  world = await seedDemoWorld({ baseUrl, log });
});

afterAll(() => api?.close());

describe("seed-demo-world", () => {
  it("creates the demo org, cards and a supply market agents can see", async () => {
    const acard = new Acard({ apiKey: world.apiKey, baseUrl });
    expect((await acard.cards.list()).map((c) => c.label).sort()).toEqual(["api-agent", "fleet-agent-07", "procurement-bot-03"]);
    const merchants = await acard.merchants.list();
    expect(merchants).toHaveLength(5);
    // Vaal Hardware is pending KYB, so search never returns it.
    const search = await acard.merchants.search({ q: "cement", quantity: 10 });
    expect(search.offers.map((o) => o.merchant.name)).not.toContain("Vaal Hardware");
  });
});

describe("01-curl-quickstart.sh", () => {
  it("runs end to end with curl and jq", async () => {
    const { stdout } = await run("bash", [`${here}/01-curl-quickstart.sh`], { env: { ...process.env, ACARD_API_URL: baseUrl } });
    expect(stdout).toContain('"approved": true');
    expect(stdout).toContain('"decline_reason": "merchant_category_not_allowed"');
    expect(stdout).toContain('"decline_reason": "per_transaction_limit_exceeded"');
  }, 30_000);
});

describe("02-claude-fuel-agent tools", () => {
  it("each tool returns what Claude needs, and limits hold", async () => {
    const acard = new Acard({ apiKey: world.apiKey, baseUrl });
    const [checkCard, findFuel, pay] = fleetTools(acard, world.cards.fleet);
    // Our tools always return a JSON string; the runner's type also allows content blocks.
    const parse = async (result: unknown) => JSON.parse(String(await result));
    const card = await parse(checkCard!.run({} as never));
    expect(card.allowedMerchantCategories).toEqual(["5541", "5542", "7538"]);

    const fuel = await parse(findFuel!.run({ litres: 180, lat: -26.2309, lng: 28.1772, radius_km: 40 } as never));
    expect(fuel.offers[0].merchant).toBe("Highveld Tyre & Fuel");
    expect(fuel.offers[0].total_cents).toBe(180 * 2_310);

    // 180 L fits the R5 000 per-fill limit; 300 L (R6 930) does not.
    const ok = await parse(pay!.run({ merchant_name: "Highveld Tyre & Fuel", merchant_category: "5541", amount_cents: 415_800 } as never));
    expect(ok.approved).toBe(true);
    const tooBig = await parse(pay!.run({ merchant_name: "Highveld Tyre & Fuel", merchant_category: "5541", amount_cents: 693_000 } as never));
    expect(tooBig).toMatchObject({ approved: false, decline_reason: "per_transaction_limit_exceeded" });
  });
});

describe("03-procurement-agent", () => {
  it("finds supply, waits for a human above the org threshold, pays and orders", async () => {
    const acard = new Acard({ apiKey: world.apiKey, baseUrl });
    // An automated "human" approves whatever lands in the queue.
    const approver = setInterval(() => void approvePending(acard), 100);
    try {
      const result = await procure({ baseUrl, apiKey: world.apiKey, log, approvalTimeoutMs: 10_000 });
      expect(result.outcome).toBe("ordered");
      if (result.outcome !== "ordered") return;
      expect(result.order.status).toBe("placed");
      expect(result.order.cardTransactionId).toBeDefined();
      // Single-use card closed itself after paying.
      expect(result.card.status).toBe("closed");
    } finally {
      clearInterval(approver);
    }
    const text = lines.join("\n");
    expect(text).toContain("skipped: only 120 bag available, 500 requested");
    expect(text).toContain("Chose Rand Build Supply");
    expect(text).toContain("Held for approval");
  }, 30_000);
});

describe("04-approval-aware-agent.py", () => {
  it("waits for approval and retries once on the grant; stops cleanly when denied", async () => {
    const acard = new Acard({ apiKey: world.apiKey, baseUrl });
    const env = { ...process.env, ACARD_API_URL: baseUrl, ACARD_API_KEY: world.apiKey, CARD_ID: world.cards.procurement, AMOUNT_CENTS: "1840000" };
    const approver = setInterval(() => void approvePending(acard), 200);
    let first: { stdout: string };
    try {
      first = await run("python3", [`${here}/04-approval-aware-agent.py`], { env });
    } finally {
      clearInterval(approver);
    }
    expect(first.stdout).toContain("Held for a human");
    expect(first.stdout).toContain("Retrying once on the grant");
    expect(first.stdout.trim().split("\n").pop()).toContain('"outcome": "paid"');

    // Denied path: a human says no.
    const denier = setInterval(async () => {
      for (const approval of await acard.approvals.list({ status: "pending" })) await acard.approvals.deny(approval.id);
    }, 200);
    try {
      const second = await run("python3", [`${here}/04-approval-aware-agent.py`], { env });
      expect(second.stdout).toContain('"outcome": "denied"');
    } finally {
      clearInterval(denier);
    }
  }, 60_000);
});

describe("05-merchant-pos-sync", () => {
  it("syncs stock, receives a verified order push, accepts it and restates stock", async () => {
    const { secret: merchantKey } = platform.merchantAuth.createApiKey(world.merchants.randBuild, {
      name: "Till 1",
      scope: "read_write",
      createdBy: "owner@randbuild.example",
    });
    const pos = await startPos({ baseUrl, merchantKey, log });
    try {
      const acard = new Acard({ apiKey: world.apiKey, baseUrl });
      const offers = (await acard.merchants.search({ q: "sand", quantity: 4 })).offers;
      const sand = offers.find((o) => o.merchant.name === "Rand Build Supply")!;
      const order = await acard.merchants.placeOrder(sand.merchant.id, {
        lines: [{ item_id: sand.item.id, quantity: 4 }],
        fulfilment: { method: "collection" },
      });
      for (let i = 0; i < 100 && !pos.orders.some((o) => o.id === order.id); i++) await new Promise((r) => setTimeout(r, 20));
      expect(pos.orders.map((o) => o.id)).toContain(order.id);
      expect((await acard.orders.get(order.id)).status).toBe("accepted");
      const restated = (await pos.shop.catalog.list()).find((item) => item.sku === "SAND-PLS-1T")!;
      expect(restated.quantityAvailable).toBe(36);
      expect(lines.join("\n")).toContain("accepted");
      expect(lines.join("\n")).not.toContain("Rejected a delivery");
    } finally {
      await pos.stop();
    }
  }, 30_000);
});
