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
