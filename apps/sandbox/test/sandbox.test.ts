import { serve } from "@hono/node-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSandbox } from "../src/app.js";
import type { Block, Model } from "../src/model.js";

/**
 * The sandbox end to end with a scripted stand-in for Claude: each step is a
 * tool call the "model" makes; everything after that (MCP tools, the API,
 * approvals, x402, the wallet) is real.
 */

let base: string;
let server: ReturnType<typeof serve>;
const steps: Array<Block[]> = [];
const model: Model = async ({ messages }) => {
  const last = messages[messages.length - 1]!;
  if (typeof last.content !== "string") return { content: [{ type: "text", text: "done" }] };
  return { content: steps.shift() ?? [{ type: "text", text: "nothing to do" }] };
};

beforeAll(async () => {
  const port = 18000 + Math.floor(Math.random() * 1000);
  base = `http://127.0.0.1:${port}`;
  const sb = await createSandbox({ baseUrl: base, model, maxTurnsPerSession: 5 });
  await new Promise<void>((r) => (server = serve({ fetch: sb.app.fetch, port, hostname: "127.0.0.1" }, () => r())));
  await sb.init();
});
afterAll(() => server?.close());

async function chat(sid: string, message: string) {
  const res = await fetch(`${base}/sandbox/chat`, { method: "POST", headers: { "x-sandbox-session": sid, "content-type": "application/json" }, body: JSON.stringify({ message }) });
  const text = await res.text();
  return [...text.matchAll(/event: (\w+)\ndata: (.*)\n/g)].map((m) => ({ event: m[1], data: JSON.parse(m[2]!) }));
}
const tool = (name: string, input: unknown): Block[] => [{ type: "tool_use", id: `t_${Math.random().toString(36).slice(2)}`, name, input }];

describe("public sandbox", () => {
  it("gives each visitor an account, every tool, and a panel where the human approves", async () => {
    const s = (await (await fetch(`${base}/sandbox/session`, { method: "POST" })).json()) as any;
    expect(s.tools).toHaveLength(21);
    const sid = s.session_id as string;
    const state = async (): Promise<any> => (await fetch(`${base}/sandbox/state`, { headers: { "x-sandbox-session": sid } })).json();

    // A-MERCHANT supply is seeded.
    steps.push(tool("find_offers", { query: "cement", quantity: 50 }));
    let ev = await chat(sid, "find cement");
    expect(ev.find((e) => e.event === "tool_result")!.data.output).toContain("offers");

    // A card with an approval threshold; the charge above it is held for the human.
    steps.push(tool("create_card", { label: "tools", single_use: false, approval_threshold: 100000 }));
    ev = await chat(sid, "make a card");
    const card = JSON.parse(ev.find((e) => e.event === "tool_result")!.data.output);
    steps.push(tool("pay_checkout", { card_id: card.id, amount: 150000, merchant_name: "Rand Build Supply", merchant_category: "5211" }));
    ev = await chat(sid, "buy it");
    expect(ev.find((e) => e.event === "tool_result")!.data.output).toContain("pending_human_approval");
    const st = await state();
    expect(st.card_approvals).toHaveLength(1);
    const approved = await fetch(`${base}/sandbox/approve`, { method: "POST", headers: { "x-sandbox-session": sid, "content-type": "application/json" }, body: JSON.stringify({ kind: "card", id: st.card_approvals[0].id, decision: "approve" }) });
    expect(approved.status).toBe(200);

    // x402 from the on-chain wallet against the built-in paid API.
    steps.push(tool("x402_preview", { wallet_id: "default", url: `${base}/demo/weather`, max_amount: "10000" }));
    ev = await chat(sid, "weather");
    const xp = JSON.parse(ev.find((e) => e.event === "tool_result")!.data.output);
    expect(xp.decision).toBe("allow");

    // A held wallet transfer shows up in the panel.
    steps.push(tool("send_preview", { wallet_id: "default", chain: "mock", asset: "USDC", to: "merchant-1", amount: "20000000" }));
    await chat(sid, "send 20");
    expect((await state()).wallet_approvals).toHaveLength(1);

    // The per-session message cap.
    expect((await chat(sid, "one more")).length).toBe(0);
  });

  it("rejects calls without a session", async () => {
    expect((await fetch(`${base}/sandbox/state`)).status).toBe(401);
  });
});
