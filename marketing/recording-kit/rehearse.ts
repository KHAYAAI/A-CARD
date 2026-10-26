import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/**
 * Pre-flight for a recording. Starts the MCP server exactly as Claude Desktop
 * does (the same command and args the kit installs, from a different working
 * directory, with a bare PATH) and talks to it over stdio.
 *
 *   npm run recording-kit:check            connect, list tools, read the wallet (changes nothing)
 *   npm run recording-kit:check -- --full  also play every scene in PROMPTS.md and check
 *                                          each outcome; it spends from the sandbox, so
 *                                          restart the kit afterwards for a clean take
 *
 * The full run is a stand-in for Claude: it makes the tool calls each prompt
 * should lead to. On the day, Claude decides for itself; this proves the
 * world is set up so that the expected outcome is what A-CARD will answer.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const { values: opts } = parseArgs({ options: { full: { type: "boolean", default: false } } });
const state = JSON.parse(readFileSync(join(HERE, ".kit", "state.json"), "utf8")) as {
  apiUrl: string;
  session: string;
  world: { cards: Record<string, string> };
};

const tsxCli = join(HERE, "..", "..", "node_modules", "tsx", "dist", "cli.mjs");
const client = new Client({ name: "recording-kit-check", version: "1.0.0" });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [tsxCli, join(HERE, "mcp-launcher.ts")],
    cwd: "/",
    env: { PATH: "/usr/bin:/bin" },
    stderr: "ignore",
  }),
);

async function call(name: string, args: Record<string, unknown> = {}) {
  const res = (await client.callTool({ name, arguments: args })) as { content: { text?: string }[]; isError?: boolean };
  const text = res.content.map((c) => c.text ?? "").join("");
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

let failures = 0;
function expect(label: string, ok: boolean, detail: unknown) {
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${label}${ok ? "" : `\n        got: ${JSON.stringify(detail).slice(0, 400)}`}`);
  if (!ok) failures++;
}
const rand = (c: number) => `R${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2 }).replace(/,/g, " ")}`;

console.log("Connection (as Claude Desktop launches it)");
const { tools } = await client.listTools();
expect(`${tools.length} tools: ${tools.map((t) => t.name).join(", ")}`, tools.some((t) => t.name === "pay_checkout"), tools);
const wallets = await call("get_wallet");
const zar = Array.isArray(wallets) ? wallets.find((w: { currency: string }) => w.currency === "ZAR") : undefined;
expect(`ZAR wallet ${zar ? rand(zar.available) : "?"} available`, !!zar && zar.available > 0, wallets);

if (opts.full) {
  console.log("\nScene 2 · cement for the Germiston site (held for approval, then paid)");
  const search = await call("find_offers", { query: "cement", quantity: 500, lat: -26.2309, lng: 28.1772, radius_km: 60, max_lead_time_days: 1 });
  const best = search.offers?.[0];
  expect(`best offer: ${best?.merchant?.name} · ${best && rand(best.totalCents)} · MCC ${best?.merchant?.merchantCategoryCode ?? best?.merchant?.mcc}`, !!best, search);
  const mcc = best.merchant.merchantCategoryCode ?? best.merchant.mcc ?? "5211";
  const card = await call("create_card", { label: "Germiston cement", single_use: true, total_limit: best.totalCents, allowed_merchant_categories: [mcc] });
  expect(`create_card ${card.id} (single-use, ${rand(best.totalCents)} total, MCC ${mcc})`, typeof card.id === "string", card);
  const pay = { card_id: card.id, amount: best.totalCents, currency: "ZAR", merchant_name: best.merchant.name, merchant_category: mcc };
  const held = await call("pay_checkout", pay);
  const approvalId = held.approval_id ?? held.approvalId;
  expect(`pay_checkout held: ${held.decline_reason ?? held.declineReason} (${approvalId})`, held.approved === false && !!approvalId, held);
  const approve = await fetch(`${state.apiUrl}/v1/approvals/${approvalId}/approve`, { method: "POST", headers: { authorization: `Bearer ${state.session}` } });
  expect("approved in A-CARD (what the dashboard's Approve button calls)", approve.ok, await approve.text());
  const paid = await call("pay_checkout", pay);
  expect("retry after approval: approved", paid.approved === true, paid);

  console.log("\nScene 3 · a fuel card that can't buy a speaker");
  const fuel = await call("create_card", { label: "Fleet diesel", single_use: false, per_transaction_limit: 200000, allowed_merchant_categories: ["5541"] });
  expect(`create_card ${fuel.id} (reusable, R2 000 per charge, MCC 5541)`, typeof fuel.id === "string", fuel);
  const diesel = await call("pay_checkout", { card_id: fuel.id, amount: 80 * 2310, currency: "ZAR", merchant_name: "Highveld Tyre & Fuel", merchant_category: "5541" });
  expect(`80 L diesel at Highveld Tyre & Fuel (${rand(80 * 2310)}): approved`, diesel.approved === true, diesel);
  const speaker = await call("pay_checkout", { card_id: fuel.id, amount: 149900, currency: "ZAR", merchant_name: "Game", merchant_category: "5732" });
  expect(`R1 499 speaker at an electronics store: declined ${speaker.decline_reason ?? speaker.declineReason}`, speaker.approved === false, speaker);

  console.log("\nScene 4 · what did we spend?");
  const txns = await call("list_transactions");
  expect(`list_transactions: ${Array.isArray(txns) ? txns.length : 0} rows`, Array.isArray(txns) && txns.length >= 2, txns);
  console.log("\nThe full run spent sandbox money. Restart the kit (Ctrl+C, start again) before recording.");
}

await client.close();
console.log(failures ? `\n${failures} check(s) failed.` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
