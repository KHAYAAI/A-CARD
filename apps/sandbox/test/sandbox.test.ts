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
/** The offers from the search that found something (the agent may try a few phrasings). */
const offersOf = (events: any[]): any[] => { for (const r of results(events)) { try { const o = JSON.parse(r.output); if (o.offers?.length) return o.offers; } catch {} } return []; };
const noFinds = (events: any[]) => names(events).filter((n) => n !== "find_offers");
const texts = (events: any[]) => events.filter((e) => e.event === "text").map((e) => e.data.text).join("\n");

describe("demo mode (no model, no key)", () => {
  it("gives every visitor an account and all 21 tools", async () => {
    const s = await session();
    expect(s.tools).toHaveLength(23);
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

  it("browses offers as results, then checks out the cart: merchant paid, then fees, one scoped card", async () => {
    const s = await session();
    const browse = await s.chat("Show me cement offers near Johannesburg.");
    expect(names(browse.events)).toEqual(["find_offers"]);
    const offers = JSON.parse(results(browse.events)[0]!.output).offers;
    expect(offers.length).toBeGreaterThan(1);
    const o = offers[0];
    const items = o.totalCents, order = 1500, proc = Math.round(items * 0.029);
    const msg = `Checkout: buy ${o.quantity} × ${o.item.name} from ${o.merchant.name} for R${(items / 100).toFixed(2)} (merchant category ${o.merchant.merchantCategoryCode}), order fee R${(order / 100).toFixed(2)} and card processing R${(proc / 100).toFixed(2)} (fees category 7399). Use one card limited to those two categories.`;
    const buy = await s.chat(msg);
    expect(names(buy.events)).toEqual(["create_card", "pay_checkout", "pay_checkout", "close_card"]);
    const card = JSON.parse(results(buy.events)[0]!.output);
    expect(card.limits.total).toBe(items + order + proc);
    expect(card.allowedMerchantCategories).toEqual([o.merchant.merchantCategoryCode, "7399"]);
    expect(results(buy.events).every((r) => !r.is_error)).toBe(true);
    expect(texts(buy.events)).toMatch(/One card covered the order/);
    // The ledger shows the merchant payment and the separate fee payment.
    const tx = ((await (await fetch(`${base}/sandbox/api/v1/transactions`, { headers: { "x-sandbox-session": s.sid } })).json()) as any).transactions;
    expect(tx.map((t: any) => [t.merchantName, t.amount, t.status]).sort()).toEqual([[o.merchant.name, items, "completed"], ["a·card fees", order + proc, "completed"]].sort());
    // The card is closed: nothing more can be charged.
    const cards = ((await (await fetch(`${base}/sandbox/api/v1/cards`, { headers: { "x-sandbox-session": s.sid } })).json()) as any).cards;
    expect(cards[0].status).toBe("closed");
  });

  it("the expanded catalogue answers across categories, and unverified suppliers stay hidden", async () => {
    const s = await session();
    const asks: Array<[string, RegExp]> = [
      ["Show me bread offers.", /bread/i], ["Find A4 paper for the office.", /paper/i], ["Show me hard hats.", /hard hat/i], ["I need laptop gear.", /laptop/i],
      ["I need laptop gear: a monitor.", /monitor|laptop|mouse/i], ["Find cleaning supplies.", /bleach|cleaner|dish/i],
      ["Show me engine oil and car parts.", /oil/i], ["Find gloves.", /glove/i], ["Show me bricks.", /brick/i], ["Find hand sanitiser.", /sanitiser/i],
    ];
    for (const [q, name] of asks) {
      const { events } = await s.chat(q);
      const offers = offersOf(events);
      expect(offers.length, q).toBeGreaterThan(0);
      expect(offers.some((o: any) => name.test(o.item.name)), q).toBe(true);
      expect(texts(events), q).not.toMatch(/No verified supplier/);   // the agent can read its own results back
    }
    // Same product, several suppliers, ranked: bread has at least two.
    const bread = offersOf((await s.chat("Show me bread offers.")).events);
    expect(new Set(bread.map((o: any) => o.merchant.name)).size).toBeGreaterThan(1);
    const hats = offersOf((await s.chat("Show me hard hats.")).events);
    expect(new Set(hats.map((o: any) => o.merchant.name)).size).toBeGreaterThan(1);
    // Pretoria Bulk Foods is unverified: never offered, even though it's cheapest on rice.
    const rice = offersOf((await s.chat("Show me rice offers.")).events);
    expect(rice.some((o: any) => o.merchant.name === "Pretoria Bulk Foods")).toBe(false);
    const dir = ((await (await fetch(`${base}/sandbox/api/v1/merchants`, { headers: { "x-sandbox-session": s.sid } })).json()) as any).merchants;
    expect(dir.length).toBeGreaterThanOrEqual(18);
    expect(new Set(dir.map((m: any) => m.merchantCategoryCode)).size).toBeGreaterThanOrEqual(9);
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

describe("free-form requests (no model, no key)", () => {
  const out = (events: any[], i = 0) => { const o = results(events)[i]!.output; try { return JSON.parse(o); } catch { return o; } };

  it("answers account questions from the real account", async () => {
    const s = await session();
    const bal = await s.chat("What's my balance?");
    expect(names(bal.events)).toEqual(["get_wallet", "get_balances"]);
    expect(texts(bal.events)).toMatch(/R20 000\.00 ZAR/);
    expect(texts(bal.events)).toMatch(/500 USDC/);
    expect(texts((await s.chat("show my cards")).events)).toMatch(/don't have any cards/);
    expect(texts((await s.chat("what have I spent?")).events)).toMatch(/No transactions yet/);
    expect(texts((await s.chat("Any approvals waiting?")).events)).toMatch(/Nothing is waiting/);
  });

  it("creates cards from plain descriptions, with the limits asked for", async () => {
    const s = await session();
    const a = await s.chat("Create a R500 card for fuel, single-use");
    expect(names(a.events)).toEqual(["create_card"]);
    const c = out(a.events);
    expect(c).toMatchObject({ singleUse: true, allowedMerchantCategories: ["5541"], currency: "ZAR" });
    expect(c.limits.total).toBe(50000);
    expect(texts(a.events)).toMatch(/single-use.*R500\.00 total.*fuel/s);
    const b = await s.chat("Make a USD card for software with approval above $100");
    expect(out(b.events)).toMatchObject({ currency: "USD", approvalThreshold: 10000, allowedMerchantCategories: ["5734"] });
    expect(texts((await s.chat("show my cards")).events)).toMatch(/2 cards, 2 active/);
  });

  it("closes cards by name or all at once", async () => {
    const s = await session();
    await s.chat("Create a R500 card for fuel");
    await s.chat("Create a R200 card for groceries");
    const one = await s.chat("close the fuel card");
    expect(names(one.events)).toEqual(["list_cards", "close_card"]);
    const all = await s.chat("close all my cards");
    expect(names(all.events).filter((n) => n === "close_card")).toHaveLength(1);
    expect(texts(all.events)).toMatch(/Closed 1 card/);
    const cards = ((await (await fetch(`${base}/sandbox/api/v1/cards`, { headers: { "x-sandbox-session": s.sid } })).json()) as any).cards;
    expect(cards.every((c: any) => c.status === "closed")).toBe(true);
    expect(texts((await s.chat("close my cards")).events)).toMatch(/no open cards/);
  });

  it("pays a merchant, and refuses over-limit and blocked-category payments with the reason", async () => {
    const s = await session();
    const ok = await s.chat("Spend R250 at Fresh Basket Market");
    expect(names(ok.events)).toEqual(["create_card", "pay_checkout"]);
    expect(texts(ok.events)).toMatch(/R250\.00 paid to Fresh Basket Market/);
    const over = await s.chat("Spend R300 at Fresh Basket Market on a card with a limit of R100");
    expect(texts(over.events)).toMatch(/declined/);
    expect(texts(over.events)).toMatch(/over the card's limit/);
    const casino = await s.chat("Pay R90 at a casino");
    expect(texts(casino.events)).toMatch(/organisation's policy blocks that category/);
    const tx = ((await (await fetch(`${base}/sandbox/api/v1/transactions`, { headers: { "x-sandbox-session": s.sid } })).json()) as any).transactions;
    expect(tx.filter((t: any) => t.status === "completed")).toHaveLength(1);
    expect(texts((await s.chat("what have I spent?")).events)).toMatch(/1 completed charge totalling R250\.00.*2 declined/);
  });

  it("uses the wallet for any amount: sends, holds for approval, refuses, swaps", async () => {
    const s = await session();
    const small = await s.chat("Send 7 USDC to supplier-1");
    expect(names(small.events)).toEqual(["send_preview", "send_execute", "get_balances"]);
    expect((await s.state()).chain.USDC).toBe("493000000");
    const mid = await s.chat("transfer 25 USDC to supplier-2");
    expect(names(mid.events)).toEqual(["send_preview"]);
    expect((await s.state()).wallet_approvals).toHaveLength(1);
    expect(texts((await s.chat("Any approvals waiting?")).events)).toMatch(/Nothing is waiting|waiting for you/);
    const big = await s.chat("Send 80 USDC to supplier-3");
    expect(texts(big.events)).toMatch(/refused 80 USDC.*exceeds_per_tx_limit/);
    expect(texts((await s.chat("send USDC to bob")).events)).toMatch(/How much USDC/);
    const sw = await s.chat("Swap 3 USDC to ZARP");
    expect(names(sw.events)).toEqual(["swap_quote", "swap_execute", "get_balances"]);
    expect((await s.state()).chain.ZARP).toBe("55500000");
  });

  it("shops for anything in the catalogue in plain words, and buys on request", async () => {
    const s = await session();
    const q = await s.chat("how much is a laptop stand?");
    expect(names(q.events)).toEqual(["find_offers"]);
    const cheap = await s.chat("cheapest white bread please");
    expect(names(cheap.events)[0]).toBe("find_offers");
    expect(texts(cheap.events)).toMatch(/suppliers? for “/);
    const buy = await s.chat("Buy 5 reams of A4 paper");
    expect(noFinds(buy.events)).toEqual(["create_card", "pay_checkout", "pay_checkout", "close_card"]);
    expect(texts(buy.events)).toMatch(/Done\. 5 × A4 paper/);
    const tx = ((await (await fetch(`${base}/sandbox/api/v1/transactions`, { headers: { "x-sandbox-session": s.sid } })).json()) as any).transactions;
    expect(tx.map((t: any) => t.merchantName)).toContain("a·card fees");
    // Closest / cheapest preferences choose differently from the default ranking.
    const cheapest = await s.chat("buy the cheapest 10 reams of A4 paper");
    const offers = offersOf(cheapest.events).map((o: any) => o.totalCents);
    expect(noFinds(cheapest.events)).toContain("pay_checkout");
    const card = JSON.parse(results(cheapest.events).find((r) => r.name === "create_card")!.output);
    expect(card.limits.perTransaction).toBe(Math.min(...offers));
  });

  it("works when nothing matches: tries simpler words, then says so honestly", async () => {
    const s = await session();
    const none = await s.chat("find unicorn saddles");
    expect(names(none.events).every((n) => n === "find_offers")).toBe(true);
    expect(names(none.events).length).toBeGreaterThan(1);
    expect(texts(none.events)).toMatch(/couldn't find that from a verified supplier/);
    const budget = await s.chat("show me gloves under R10");
    expect(texts(budget.events)).toMatch(/under R10\.00/);
  });

  it("handles the awkward phrasings that used to misroute", async () => {
    const s = await session();
    // "order 3 monitors": the 3 is a quantity, not a rand amount.
    const order = await s.chat("order 3 monitors");
    expect(results(order.events).find((r) => r.name === "create_card")!.output).toContain('"perTransaction"');
    expect(texts(order.events)).toMatch(/Done\. 3 × /);
    // "printer paper" is paper, not toner.
    expect(offersOf((await s.chat("do you have printer paper")).events).every((o: any) => /paper|ream/i.test(o.item.name))).toBe(true);
    // A bare product mention is a search.
    expect(offersOf((await s.chat("gloves for my workers")).events).length).toBeGreaterThan(0);
    // "my fuel card" closes the fuel card only.
    await s.chat("issue a reusable card for fuel up to R5000");
    await s.chat("create a card for team lunch with R2000 limit");
    const close = await s.chat("close my fuel card");
    expect(names(close.events).filter((n) => n === "close_card")).toHaveLength(1);
    expect(texts(close.events)).toMatch(/Closed 1 card: “fuel”/);
    const cards = ((await (await fetch(`${base}/sandbox/api/v1/cards`, { headers: { "x-sandbox-session": s.sid } })).json()) as any).cards;
    expect(cards.filter((c: any) => c.status === "active").map((c: any) => c.label)).toContain("team lunch");
    // A dollar card with an approval threshold in dollars.
    const usdc = await s.chat("I want a card for Google ads, $300, needs approval over $50");
    expect(out(usdc.events)).toMatchObject({ currency: "USD", approvalThreshold: 5000, allowedMerchantCategories: ["7311"] });
    expect(out(usdc.events).limits.total).toBe(30000);
    // Crypto balance questions are balance questions; approving is the visitor's job.
    expect(names((await s.chat("how much USDC do I have")).events)).toEqual(["get_wallet", "get_balances"]);
    const ap = await s.chat("approve it");
    expect(names(ap.events)).toEqual([]);
    expect(texts(ap.events)).toMatch(/Approvals are yours to decide/);
    expect(texts((await s.chat("swap 10 ZARP to USDC")).events)).toMatch(/only swaps USDC into ZARP/);
  });

  it("handles several products in one request: searches each, and buys the whole basket on one card", async () => {
    const s = await session();
    const browse = await s.chat("show me milk and eggs");
    const finds = results(browse.events).filter((r, i) => names(browse.events)[i] === "find_offers");
    const withOffers = finds.map((r) => { try { return JSON.parse(r.output).offers?.length ?? 0; } catch { return 0; } }).filter((n) => n > 0);
    expect(withOffers.length).toBe(2);                       // one result set per product
    expect(texts(browse.events)).toMatch(/for “milk”.*for “egg/s);
    // Two products from the same supplier: one payment to it, then the fees.
    const buy = await s.chat("I'd like to buy some milk and eggs");
    expect(noFinds(buy.events)).toEqual(["create_card", "pay_checkout", "pay_checkout", "close_card"]);
    // Two products that only different suppliers carry: one card, a payment to each, then the fees.
    const split = await s.chat("buy 2 hard hats and 3 hi-vis vests and 6 gloves and a bleach");
    const pays = results(split.events).filter((r, i) => names(split.events)[i] === "pay_checkout");
    expect(noFinds(split.events).filter((n) => n === "create_card")).toHaveLength(1);
    expect(pays.length).toBeGreaterThanOrEqual(3);          // at least two suppliers + the fees
    expect(texts(split.events)).toMatch(/One card covered the order/);
    const cards = ((await (await fetch(`${base}/sandbox/api/v1/cards`, { headers: { "x-sandbox-session": s.sid } })).json()) as any).cards;
    expect(cards.every((c: any) => c.status === "closed")).toBe(true);
    const tx = ((await (await fetch(`${base}/sandbox/api/v1/transactions`, { headers: { "x-sandbox-session": s.sid } })).json()) as any).transactions;
    expect(tx.filter((t: any) => t.merchantName === "a·card fees")).toHaveLength(2);   // one fee payment per order
    // Something in the list that isn't in the catalogue is reported, and the rest still goes through.
    const part = await s.chat("buy 5 reams of A4 paper and a unicorn");
    expect(texts(part.events)).toMatch(/couldn't find “unicorn”/);
    expect(texts(part.events)).toMatch(/One card covered the order/);
  });

  it("is honest about what it can't do, and points to live Claude", async () => {
    const s = await session();
    for (const q of ["Write me a poem about rain", "what is the capital of France?", "book me a flight to Cape Town"]) {
      const r = await s.chat(q);
      expect(names(r.events), q).toEqual([]);
      expect(texts(r.events), q).toMatch(/scripted demo agent/);
      expect(texts(r.events), q).toMatch(/Claude key/);
    }
    expect(texts((await s.chat("hello")).events)).toMatch(/Hello!/);
    expect(texts((await s.chat("help")).events)).toMatch(/Try asking me to/);
  });
});

describe("wallets: fiat, crypto, the agent's wallet, and routing", () => {
  const authed = (sid: string) => ({ "x-sandbox-session": sid, "content-type": "application/json" });
  const J = async (sid: string, method: string, path: string, body?: unknown, extra: Record<string, string> = {}) => {
    const r = await fetch(`${base}${path}`, { method, headers: { ...authed(sid), ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, j: (await r.json().catch(() => ({}))) as any };
  };

  it("gives every account an embedded wallet on each chain, and lets it link its own", async () => {
    const s = await session();
    const { j } = await J(s.sid, "GET", "/sandbox/crypto");
    expect(j.wallets.map((w: any) => w.chain).sort()).toEqual(["ethereum", "polygon", "solana"]);
    expect(j.wallets.every((w: any) => w.kind === "embedded" && Number(w.usdc) > 0)).toBe(true);
    expect(j.wallets.filter((w: any) => w.isDefault)).toHaveLength(1);
    expect(j.wallets.find((w: any) => w.chain === "ethereum").address).toMatch(/^0x[0-9a-f]{40}$/);
    // Distinct visitors get distinct addresses.
    const other = await J((await session()).sid, "GET", "/sandbox/crypto");
    expect(other.j.wallets[0].address).not.toBe(j.wallets[0].address);

    // The platform validates the address for the chain.
    const bad = await J(s.sid, "POST", "/sandbox/api/v1/wallets/crypto/link", { chain: "ethereum", address: "nope", connector: "metamask" });
    expect(bad.status).toBe(409);
    expect(bad.j.error.message).toMatch(/not a valid ethereum address/);
    const ok = await J(s.sid, "POST", "/sandbox/api/v1/wallets/crypto/link", { chain: "solana", address: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU", connector: "walletconnect", label: "Cold" });
    expect(ok.status).toBe(201);
    expect((await J(s.sid, "POST", "/sandbox/api/v1/wallets/crypto/link", { chain: "solana", address: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU", connector: "walletconnect" })).status).toBe(409); // duplicate
    // Make it the default, then unlink; the embedded wallet can never be unlinked.
    expect((await J(s.sid, "POST", `/sandbox/api/v1/wallets/crypto/${ok.j.wallet.id}/default`, {})).status).toBe(200);
    const embedded = j.wallets[0];
    const un = await J(s.sid, "DELETE", `/sandbox/api/v1/wallets/crypto/${embedded.id}`);
    expect(un.status).toBe(409);
    expect((await J(s.sid, "DELETE", `/sandbox/api/v1/wallets/crypto/${ok.j.wallet.id}`)).status).toBe(200);
    expect((await J(s.sid, "GET", "/sandbox/crypto")).j.wallets.filter((w: any) => w.isDefault)).toHaveLength(1);
    // Test funds: only embedded wallets, capped.
    expect((await J(s.sid, "POST", "/sandbox/crypto/fund", { id: embedded.id, usdc: 25 })).status).toBe(200);
    expect((await J(s.sid, "POST", "/sandbox/crypto/fund", { id: embedded.id, usdc: 5000 })).status).toBe(400);
    expect((await J(s.sid, "GET", "/sandbox/crypto")).j.wallets.find((w: any) => w.id === embedded.id).usdc).toBe(String(Number(embedded.usdc) + 25_000_000));
  });

  it("routes a payment over the rails that can carry it, explains why, and keeps one ledger", async () => {
    const s = await session();
    const intent = async (body: any) => (await J(s.sid, "POST", "/sandbox/api/v1/afp/intents", body)).j;
    // USD to an API: x402 and stablecoin can; a card can't because there is none yet.
    const api = await intent({ amount: 500, currency: "USD", purpose: "Weather", counterparty: `${base}/demo/weather` });
    expect(api.decision.chosenRail).toBe("x402");
    expect(api.decision.scored.map((x: any) => x.rail).sort()).toEqual(["stablecoin", "x402"]);
    expect(api.decision.rejected).toEqual([{ rail: "card", reason: "no active card in USD" }]);
    expect(api.decision.scored[0].matchReasons).toContain("lowest fee");
    // ZAR to a merchant: nothing can carry it until a card exists.
    const zar = await intent({ amount: 12000, currency: "ZAR", purpose: "Rand Build Supply", counterparty: "mch_1" });
    expect(zar.decision.chosenRail).toBeUndefined();
    expect(zar.decision.rejected.map((x: any) => x.reason).join(" ")).toMatch(/no active card in ZAR.*must be in USD/s);
    await s.chat("create a R5000 card");
    const zar2 = await intent({ amount: 12000, currency: "ZAR", purpose: "Rand Build Supply", counterparty: "mch_1" });
    expect(zar2.decision.chosenRail).toBe("card");

    // Execute: the card is final only after its 120-day window (posted), the others are instant (settled).
    const card = await J(s.sid, "POST", `/sandbox/api/v1/afp/intents/${zar2.intent.id}/execute`, {});
    expect(card.status).toBe(201);
    expect(card.j.transaction).toMatchObject({ rail: "card", status: "posted", finality: { kind: "reversal_window", reversalWindowDays: 120 } });
    const key = "k-" + Math.random();
    const x = await J(s.sid, "POST", `/sandbox/api/v1/afp/intents/${api.intent.id}/execute`, { rail: "x402" }, { "idempotency-key": key });
    expect(x.j.transaction).toMatchObject({ rail: "x402", status: "settled", finality: { kind: "instant" } });
    const again = await J(s.sid, "POST", `/sandbox/api/v1/afp/intents/${api.intent.id}/execute`, { rail: "x402" }, { "idempotency-key": key });
    expect(again.j.transaction.id).toBe(x.j.transaction.id);                    // a repeat is a lookup, never a second payment
    // Stablecoin: debits the embedded ethereum wallet by exactly the amount, and refuses what it can't cover.
    const before = Number((await J(s.sid, "GET", "/sandbox/crypto")).j.wallets.find((w: any) => w.chain === "ethereum").usdc);
    const sc = await intent({ amount: 1000, currency: "USD", purpose: "Supplier", counterparty: "0x" + "ab".repeat(20) });
    expect((await J(s.sid, "POST", `/sandbox/api/v1/afp/intents/${sc.intent.id}/execute`, { rail: "stablecoin" })).j.transaction.status).toBe("settled");
    expect(Number((await J(s.sid, "GET", "/sandbox/crypto")).j.wallets.find((w: any) => w.chain === "ethereum").usdc)).toBe(before - 10_000_000);
    const big = await intent({ amount: 5_000_000, currency: "USD", purpose: "Too much", counterparty: "0x" + "ab".repeat(20) });
    expect(big.decision.rejected.find((x: any) => x.rail === "stablecoin").reason).toMatch(/embedded wallet holds/);
    // One ledger, three rails.
    const tx = (await J(s.sid, "GET", "/sandbox/api/v1/afp/transactions")).j.transactions;
    expect(tx.map((t: any) => t.rail).sort()).toEqual(["card", "stablecoin", "x402"]);
  });

  it("keeps visitors apart, and agents away from outside addresses", async () => {
    const a = await session(), b = await session();
    const i = (await J(a.sid, "POST", "/sandbox/api/v1/afp/intents", { amount: 100, currency: "USD", purpose: "x", counterparty: `${base}/demo/weather` })).j.intent;
    // Another visitor can't execute, or even see, the first one's intent.
    expect((await J(b.sid, "POST", `/sandbox/api/v1/afp/intents/${i.id}/execute`, {})).status).toBe(404);
    expect((await J(b.sid, "GET", "/sandbox/api/v1/afp/transactions")).j.transactions).toEqual([]);
    // x402 aimed at an address outside the sandbox never leaves: the rail parks it instead of paying.
    const evil = (await J(a.sid, "POST", "/sandbox/api/v1/afp/intents", { amount: 100, currency: "USD", purpose: "x", counterparty: "http://169.254.169.254/latest/meta-data/" })).j.intent;
    const r = await J(a.sid, "POST", `/sandbox/api/v1/afp/intents/${evil.id}/execute`, { rail: "x402" });
    expect(r.j.transaction.status).toBe("reconciling");
    expect(JSON.stringify(r.j.transaction.history)).toMatch(/built-in demo API/);
    // Things a console user can't do aren't reachable here.
    expect((await J(a.sid, "POST", "/sandbox/api/v1/afp/x402/pay", {})).status).toBe(404);
    expect((await J(a.sid, "GET", "/sandbox/crypto")).status).toBe(200);
    expect((await fetch(`${base}/sandbox/crypto`)).status).toBe(401);
  });

  it("lets the agent read the linked crypto wallets and quote a payment, but not change anything", async () => {
    const s = await session();
    expect(s.tools).toEqual(expect.arrayContaining(["list_crypto_wallets", "quote_payment"]));
    expect(s.tools.filter((t) => /link|unlink|default/i.test(t))).toEqual([]);          // nothing that changes wallets
    const l = await s.chat("what are my crypto wallets?");
    expect(names(l.events)).toEqual(["list_crypto_wallets"]);
    expect(texts(l.events)).toMatch(/3 linked wallets.*Ethereum embedded \(default\).*USDC/s);
    expect(texts(l.events)).toMatch(/I can read these but not link, unlink or move them/);
    // It sees wallets the owner links, and not another visitor's.
    await J(s.sid, "POST", "/sandbox/api/v1/wallets/crypto/link", { chain: "ethereum", address: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e", connector: "metamask", label: "Treasury" });
    expect(texts((await s.chat("show my linked wallets")).events)).toMatch(/4 linked wallets.*“Treasury”/s);
    const o = await session();
    expect(texts((await o.chat("show my linked wallets")).events)).toMatch(/3 linked wallets/);
    // The quote explains the rails and moves nothing.
    const q = await s.chat(`how should I pay $5 to ${base}/demo/weather`);
    expect(names(q.events)).toEqual(["quote_payment"]);
    expect(texts(q.events)).toMatch(/x402 payment.*lowest fee/s);
    const before = Number((await J(s.sid, "GET", "/sandbox/crypto")).j.wallets.find((w: any) => w.chain === "ethereum").usdc);
    expect(before).toBe(250_000_000);
    expect((await J(s.sid, "GET", "/sandbox/api/v1/afp/transactions")).j.transactions).toEqual([]);
    const z = await s.chat("how should I pay R120 to Rand Build Supply");
    expect(texts(z.events)).toMatch(/No rail can carry that.*no active card in ZAR/s);
  });

  it("shows the agent wallet: balances, limits, what it has used, and what it did", async () => {
    const s = await session();
    await s.chat("send 7 USDC to supplier-1");
    await s.chat("transfer 25 USDC to supplier-2");
    const { j } = await J(s.sid, "GET", "/sandbox/agent-wallet");
    expect(j.balances.USDC).toBe("493000000");
    expect(j.policy.assets.USDC).toEqual({ perTx: "50000000", per24h: "200000000", approvalAbove: "10000000" });
    expect(j.spent24h).toBe("7000000");
    expect(j.pending).toHaveLength(1);
    expect(j.events.map((e: any) => e.type)).toEqual(expect.arrayContaining(["agent_wallet.transfer.previewed", "agent_wallet.transfer.executed"]));
    expect(j.address).toMatch(/^mock:/);
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

describe("sell on A-CARD: a visitor lists their own store", () => {
  const csv = "sku,name,price,quantity\nZ-1,Zebra Biltong 100g,39.50,12\nZ-2,Bad Row,abc,1\n";
  const post = (sid: string, body: unknown) => fetch(`${base}/sandbox/store`, { method: "POST", headers: { "x-sandbox-session": sid, "content-type": "application/json" }, body: JSON.stringify(body) });
  const seen = (sid: string) => fetch(`${base}/sandbox/api/v1/merchants/search?q=biltong&lat=-26.2&lng=28.04&radius_km=60`, { headers: { "x-sandbox-session": sid } }).then((r) => r.text());

  it("opens a store from a CSV, reports bad rows, and keeps it private to the session", async () => {
    const a = await session();
    const b = await session();
    expect((await post(a.sid, { name: "", csv })).status).toBe(400);
    expect((await post(a.sid, { name: "Biltong Bros", csv: "a,b\n1,2" })).status).toBe(400);
    const ok = await post(a.sid, { name: "Biltong Bros", csv });
    expect(ok.status).toBe(200);
    const out = (await ok.json()) as any;
    expect(out.store).toMatchObject({ name: "Biltong Bros", items: 1, first: "Zebra Biltong 100g" });
    expect(out.errors[0]).toMatchObject({ row: 3 });
    expect(await seen(a.sid)).toContain("Biltong Bros");
    expect(await seen(b.sid)).not.toContain("Biltong Bros");
    expect((await post(a.sid, { name: "Second", csv })).status).toBe(200);
    expect((await post(a.sid, { name: "Third", csv })).status).toBe(400);
  });
});
