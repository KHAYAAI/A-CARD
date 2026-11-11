import { readFileSync } from "node:fs";
import { serve } from "@hono/node-server";
import { Platform } from "@acard/core";
import { createApp } from "../src/app.js";
/**
 * Runs integrations/investec/main.js inside the community programmable-card emulator
 * (github.com/devinpearson/programmable-card-code-emulator, MIT, not vendored) against a live in-process A-CARD API.
 *   git clone https://github.com/devinpearson/programmable-card-code-emulator /tmp/emu && (cd /tmp/emu && npm install)
 *   EMULATOR_PATH=/tmp/emu/src/index.ts npx tsx apps/api/scripts/investec-emulator-check.ts
 * It is a community tool, not Investec's own: a pass here is evidence, not proof, that the card code matches Investec.
 */
const emulator = await import(process.env.EMULATOR_PATH ?? "/tmp/emu/src/index.ts");
const { createTransaction, run } = emulator as { createTransaction: (...a: any[]) => any; run: (...a: any[]) => Promise<any[]> };

const SECRET = "emulator-hook-secret-0123456789";
const cards: Record<string, string> = {};
const app = createApp({ platform: new Platform(), issuerWebhookSecret: "whsec_test", investecPilot: { secret: SECRET, cards } });
const server = serve({ fetch: app.fetch, port: 8791, hostname: "127.0.0.1" });
const j = async (r: Response) => (await r.json()) as any;
const key = (await j(await app.request("/v1/signup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "emu@example.co.za", name: "Emu", currency: "ZAR" }) }))).api_key;
const authed = (p: string, init: RequestInit = {}) => app.request(p, { ...init, headers: { authorization: `Bearer ${key}`, "content-type": "application/json" } });
await authed("/v1/wallet/fund", { method: "POST", body: JSON.stringify({ amount: 1_000_000 }) });
await authed("/v1/policy", { method: "PUT", body: JSON.stringify({ blocked_merchant_categories: ["7995"], approval_threshold: 20_000 }) });
const card = (await j(await authed("/v1/cards", { method: "POST", body: JSON.stringify({ single_use: false }) }))).card;
cards["2280000"] = card.id; // the emulator's fixed card id
const code = readFileSync(new URL("../../../integrations/investec/main.js", import.meta.url), "utf8");
const env = JSON.stringify({ ACARD_URL: "http://127.0.0.1:8791", ACARD_HOOK_SECRET: SECRET, ACARD_FAIL_OPEN: "false" });
const cases: [string, any][] = [
  ["grocery R50 (expect approve)", createTransaction("ZAR", 5000, "5411", "Fresh Basket", "Johannesburg", "ZAF")],
  ["gambling R500 (expect decline)", createTransaction("ZAR", 50000, "7995", "Lucky Spin", "Johannesburg", "ZAF")],
  ["grocery R300, over threshold (expect decline)", createTransaction("ZAR", 30000, "5411", "Fresh Basket", "Johannesburg", "ZAF")],
  ["euro charge (expect decline, not sent)", createTransaction("EUR", 5000, "5411", "Paris Cafe", "Paris", "FRA")],
];
let n = 0;
for (const [name, tx] of cases) {
  tx.reference = `sim-${++n}`;
  const t0 = Date.now();
  const ex = await run(tx, code, env);
  const b = ex.find((e: any) => e.type === "before_transaction") ?? ex[0];
  console.log(name, "=>", JSON.stringify({ approved: b.authorizationApproved, ms: Date.now() - t0, logs: (b.logs ?? []).map((l: any) => l.content).slice(0, 3), after: ex[1]?.type }));
}
const w = await authed("/v1/wallet");
console.log("wallet after:", JSON.stringify((await w.json() as any).wallet));
const reuse = createTransaction("ZAR", 50000, "7995", "Lucky Spin", "Johannesburg", "ZAF"); reuse.reference = "sim-1";
const rex = await run(reuse, code, env);
console.log("reused reference with different details =>", JSON.stringify({ approved: rex[0].authorizationApproved, logs: rex[0].logs.map((l: any) => l.content) }));
server.close();
process.exit(0);
