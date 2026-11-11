import { serve } from "@hono/node-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSandbox } from "../src/app.js";
import { mockModel } from "../src/mock.js";
import type { Block, Model } from "../src/model.js";

/**
 * The sandbox end to end. Demo mode needs no model or key: the scripted agent
 * makes real calls to the platform. Live mode is covered with a stand-in model
 * that checks the visitor's key is passed through for that request only.
 */

let base: string;
let server: ReturnType<typeof serve>;
const liveKeysSeen: string[] = [];
const liveSteps: Block[][] = [];
const liveModel = (key: string): Model => async ({ messages }) => {
  liveKeysSeen.push(key);
  const last = messages[messages.length - 1]!;
  if (typeof last.content !== "string") return { content: [{ type: "text", text: "live done" }] };
  return { content: liveSteps.shift() ?? [{ type: "text", text: "live hello" }] };
};

beforeAll(async () => {
  const port = 18000 + Math.floor(Math.random() * 1000);
  base = `http://127.0.0.1:${port}`;
  const sb = await createSandbox({ baseUrl: base, mockModel, liveModel, maxTurnsPerSession: 30, maxSessionsPerIpPerHour: 1000 });
  await new Promise<void>((r) => (server = serve({ fetch: sb.app.fetch, port, hostname: "127.0.0.1" }, () => r())));
  await sb.init();
});
afterAll(() => server?.close());

async function session() {
  const s = (await (await fetch(`${base}/sandbox/session`, { method: "POST" })).json()) as any;
  const sid = s.session_id as string;
  const h = { "x-sandbox-session": sid, "content-type": "application/json" };
  const state = async (): Promise<any> => (await fetch(`${base}/sandbox/state`, { headers: h })).json();
  const chat = async (message: string, api_key?: string) => {
    const res = await fetch(`${base}/sandbox/chat`, { method: "POST", headers: h, body: JSON.stringify({ message, api_key }) });
    if (!res.ok) return { status: res.status, events: [] as any[], error: ((await res.json()) as any).error as string };
    const text = await res.text();
    const events = [...text.matchAll(/event: (\w+)\ndata: (.*)\n/g)].map((m) => ({ event: m[1]!, data: JSON.parse(m[2]!) }));
    return { status: res.status, events, error: undefined };
  };
  const approve = (kind: "card" | "wallet", id: string) => fetch(`${base}/sandbox/approve`, { method: "POST", headers: h, body: JSON.stringify({ kind, id, decision: "approve" }) });
  return { sid, tools: s.tools as string[], state, chat, approve };
}
const names = (events: any[]) => events.filter((e) => e.event === "tool_call").map((e) => e.data.name);
const results = (events: any[]) => events.filter((e) => e.event === "tool_result").map((e) => e.data);
const texts = (events: any[]) => events.filter((e) => e.event === "text").map((e) => e.data.text).join("\n");

describe("demo mode (no model, no key)", () => {
  it("gives every visitor an account and all 21 tools", async () => {
    const s = await session();
    expect(s.tools).toHaveLength(21);
    const st = await s.state();
    expect(st.chain.USDC).toBe("500000000");
  });

  it("finds supply and buys with a single-use scoped card", async () => {
    const s = await session();
    const { events } = await s.chat("Find 50 bags of cement near Johannesburg and buy the best offer with a card limited to building suppliers.");
    expect(events[0]).toMatchObject({ event: "mode", data: { mode: "demo" } });
    expect(names(events)).toEqual(["find_offers", "create_card", "pay_checkout"]);
    expect(results(events).every((r) => !r.is_error)).toBe(true);
    expect((await s.state()).transactions.transactions.length).toBeGreaterThan(0);
  });

  it("browses offers as results, then checks out exactly what was in the cart", async () => {
    const s = await session();
    const browse = await s.chat("Show me cement offers near Johannesburg.");
    expect(names(browse.events)).toEqual(["find_offers"]);
    const offers = JSON.parse(results(browse.events)[0]!.output).offers;
    expect(offers.length).toBeGreaterThan(1);
    expect(offers[0].merchant.name).toBeTruthy();
    // The cart's checkout message names the merchant, total and category; the agent pays on a card capped at that.
    const o = offers[0];
    const msg = `Checkout: buy ${o.quantity} × ${o.item.name} from ${o.merchant.name} for R${(o.totalCents / 100).toFixed(2)} (merchant category ${o.merchant.merchantCategoryCode}). Use a single-use card limited to that category.`;
    const buy = await s.chat(msg);
    expect(names(buy.events)).toEqual(["create_card", "pay_checkout"]);
    const card = JSON.parse(results(buy.events)[0]!.output);
    expect(card.singleUse).toBe(true);
    expect(card.limits.total).toBe(o.totalCents);
    expect(card.allowedMerchantCategories).toEqual([o.merchant.merchantCategoryCode]);
    expect(results(buy.events)[1]!.is_error).toBe(false);
    expect(texts(buy.events)).toMatch(/approved/);
  });

  it("a fuel card cannot buy a TV", async () => {
    const s = await session();
    const { events } = await s.chat("Make me a R1 000 fuel card, then try to buy a TV with it.");
    expect(names(events)).toEqual(["create_card", "pay_checkout"]);
    const pay = results(events)[1]!;
    expect(pay.is_error || /declin|not_allowed/i.test(pay.output)).toBe(true);
    expect(texts(events)).toMatch(/declin/i);
  });

  it("holds a charge for the human, then retries once after approval", async () => {
    const s = await session();
    const first = await s.chat("Create a card that needs my approval above R1 000 and spend R1 500 at Rand Build Supply.");
    expect(names(first.events)).toEqual(["create_card", "pay_checkout"]);
    const st = await s.state();
    expect(st.card_approvals).toHaveLength(1);
    expect((await s.approve("card", st.card_approvals[0].id)).status).toBe(200);
    const retry = await s.chat("I approved it, retry.");
    expect(names(retry.events)).toEqual(["pay_checkout"]);
    expect(results(retry.events)[0]!.is_error).toBe(false);
    expect((await s.state()).card_approvals).toHaveLength(0);
  });

  it("pays an x402 API from a card", async () => {
    const s = await session();
    const { events } = await s.chat("Pay for the weather API with x402 from a USD card. Max 1 cent.");
    expect(names(events)).toEqual(["create_card", "pay_x402"]);
    expect(results(events)[1]!.output).toContain("Johannesburg");
  });

  it("holds a 20 USDC wallet transfer, refuses 90, and executes after approval", async () => {
    const s = await session();
    const { events } = await s.chat("Send 20 USDC from the wallet to merchant-1, then try 90.");
    expect(names(events)).toEqual(["send_preview", "send_preview"]);
    const st = await s.state();
    expect(st.wallet_approvals).toHaveLength(1);
    expect(texts(events)).toMatch(/deny/i);
    await s.approve("wallet", st.wallet_approvals[0]);
    const done = await s.chat("I approved it");
    expect(names(done.events)).toEqual(["send_execute"]);
    expect(results(done.events)[0]!.is_error).toBe(false);
    expect((await s.state()).chain.USDC).toBe("480000000");
  });

  it("swaps USDC to ZARP", async () => {
    const s = await session();
    const { events } = await s.chat("Swap 5 USDC to ZARP and show my balances.");
    expect(names(events)).toEqual(["swap_quote", "swap_execute", "get_balances"]);
    expect((await s.state()).chain.ZARP).toBe("92500000");
  });

  it("says what it can do when it doesn't recognise the request", async () => {
    const s = await session();
    const { events } = await s.chat("what's the capital of France?");
    expect(names(events)).toEqual([]);
    expect(texts(events)).toContain("scripted demo agent");
  });
});

describe("console screens and restrictions", () => {
  it("serves the account's real records, and only the allowed endpoints", async () => {
    const s = await session();
    const h = { "x-sandbox-session": s.sid, "content-type": "application/json" };
    const get = async (p: string) => (await fetch(`${base}/sandbox/api${p}`, { headers: h })).json() as Promise<any>;
    expect((await get("/v1/policy")).policy.blocked_merchant_categories).toEqual(["7995", "6051"]);
    expect((await get("/v1/merchants")).merchants.length).toBeGreaterThan(3);
    expect((await get("/v1/auth/me")).account_holder.subscriptionTier).toBe("enterprise");
    // Not on the allow-list: keys, members, merchant creation, anything else.
    for (const [m, path] of [["GET", "/v1/keys"], ["POST", "/v1/keys"], ["POST", "/v1/merchants"], ["GET", "/v1/auth/members"], ["DELETE", "/v1/cards/x"]] as const) {
      expect((await fetch(`${base}/sandbox/api${path}`, { method: m, headers: h, body: m === "POST" ? "{}" : undefined })).status).toBe(404);
    }
    expect((await fetch(`${base}/sandbox/api/v1/wallet/fund`, { method: "POST", headers: h, body: JSON.stringify({ amount: 999_999_999, currency: "ZAR" }) })).status).toBe(400);
    expect((await fetch(`${base}/sandbox/state`)).status).toBe(401);
    expect((await fetch(`${base}/sandbox/api/v1/cards`)).status).toBe(401);
  });

  it("organisation policy beats the card, and editing the policy changes the outcome", async () => {
    const s = await session();
    const h = { "x-sandbox-session": s.sid, "content-type": "application/json" };
    const first = await s.chat("Try to spend R500 at an online casino on a general card.");
    expect(results(first.events)[1]!.output).toContain("merchant_category_blocked_by_policy");
    expect(texts(first.events)).toMatch(/Org policy beats card rules/);
    // Unblock gambling in Policies, and the same attempt now goes through.
    const put = await fetch(`${base}/sandbox/api/v1/policy`, { method: "PUT", headers: h, body: JSON.stringify({ blocked_merchant_categories: [] }) });
    expect(put.status).toBe(200);
    const second = await s.chat("Try to spend R500 at an online casino on a general card.");
    expect(texts(second.events)).toMatch(/Gambling isn't blocked/);
  });

  it("one visitor cannot see another's records", async () => {
    const a = await session(), b = await session();
    await a.chat("Make me a R1 000 fuel card, then try to buy a TV with it.");
    const read = async (sid: string) => ((await (await fetch(`${base}/sandbox/api/v1/cards`, { headers: { "x-sandbox-session": sid } })).json()) as any).cards;
    expect((await read(a.sid)).length).toBe(1);
    expect((await read(b.sid)).length).toBe(0);
  });
});

describe("live mode (visitor's own key)", () => {
  it("uses the visitor's key for that request and keeps nothing", async () => {
    const s = await session();
    const key = "sk-ant-test-0123456789abcdefghij";
    const { events } = await s.chat("hello", key);
    expect(events[0]).toMatchObject({ event: "mode", data: { mode: "live" } });
    expect(liveKeysSeen).toContain(key);
    // The next message without a key is back to the scripted agent.
    const after = await s.chat("hello");
    expect(after.events[0]).toMatchObject({ data: { mode: "demo" } });
    // The key is not in the session's stored history or in /sandbox/state.
    expect(JSON.stringify(await s.state())).not.toContain(key);
  });

  it("rejects something that isn't an Anthropic key", async () => {
    const s = await session();
    const r = await s.chat("hello", "not-a-key");
    expect(r.status).toBe(400);
  });
});

describe("limits", () => {
  it("rejects calls without a session", async () => {
    expect((await fetch(`${base}/sandbox/state`)).status).toBe(401);
  });
});
