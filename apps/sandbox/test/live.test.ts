import { createServer } from "node:http";
import { serve } from "@hono/node-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSandbox } from "../src/app.js";
import { mockModel } from "../src/mock.js";
import { anthropicModel } from "../src/model.js";

/**
 * Live mode against a STRICT stand-in for the Anthropic Messages API.
 *
 * The stand-in enforces the rules the real API documents for requests (valid
 * headers, a well-formed tools list, roles that alternate starting with the
 * user, every tool_use answered by tool_results in the very next user message,
 * no empty text blocks) and replies like a model would: tool_use blocks, then
 * text. If the sandbox's live path ever sent a malformed conversation, this is
 * where it would be rejected, the way the real API would reject it.
 *
 * It cannot prove Anthropic's service accepts these requests or how Claude
 * will behave: that needs a real key (`npm run live-smoke -w @acard/sandbox`).
 */
const KEY = "sk-ant-test-0123456789abcdefghij";
let apiUrl: string, upstream: ReturnType<typeof createServer>;
let base: string, app: ReturnType<typeof serve>;
const requests: any[] = [];
let toolsSeen: any[] = [];

const bad = (message: string) => ({ status: 400, body: { type: "error", error: { type: "invalid_request_error", message } } });
function validate(h: Record<string, any>, b: any): { status: number; body: any } | undefined {
  if (h["x-api-key"] !== KEY) return { status: 401, body: { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } } };
  if (h["anthropic-version"] !== "2023-06-01") return bad("anthropic-version header is required");
  if (typeof b.model !== "string" || !b.model) return bad("model: field required");
  if (!Number.isInteger(b.max_tokens) || b.max_tokens < 1) return bad("max_tokens: must be a positive integer");
  if (!Array.isArray(b.messages) || !b.messages.length) return bad("messages: at least one message is required");
  for (const t of b.tools ?? []) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(t.name)) return bad(`tools.name: invalid tool name ${t.name}`);
    if (!t.input_schema || t.input_schema.type !== "object") return bad(`tools.${t.name}.input_schema: type must be "object"`);
    if (typeof t.description !== "string" || !t.description) return bad(`tools.${t.name}.description: required`);
  }
  if (new Set((b.tools ?? []).map((t: any) => t.name)).size !== (b.tools ?? []).length) return bad("tools: names must be unique");
  const m = b.messages;
  if (m[0].role !== "user") return bad("messages.0.role: first message must be a user message");
  const seenIds = new Set<string>();
  for (let i = 0; i < m.length; i++) {
    const msg = m[i];
    if (i > 0 && msg.role === m[i - 1].role) return bad(`messages.${i}: roles must alternate`);
    if (!["user", "assistant"].includes(msg.role)) return bad(`messages.${i}.role: invalid`);
    const blocks = typeof msg.content === "string" ? [{ type: "text", text: msg.content }] : msg.content;
    if (!Array.isArray(blocks) || !blocks.length) return bad(`messages.${i}.content: must not be empty`);
    for (const blk of blocks) {
      if (!["text", "tool_use", "tool_result"].includes(blk.type)) return bad(`messages.${i}: unsupported block ${blk.type}`);
      if (blk.type === "text" && !String(blk.text).trim()) return bad(`messages.${i}: text content blocks must be non-empty`);
      if (blk.type === "tool_use") {
        if (msg.role !== "assistant") return bad(`messages.${i}: tool_use belongs in an assistant message`);
        if (!/^[a-zA-Z0-9_-]+$/.test(blk.id)) return bad(`messages.${i}: invalid tool_use id`);
        if (seenIds.has(blk.id)) return bad(`messages.${i}: duplicate tool_use id ${blk.id}`);
        seenIds.add(blk.id);
      }
      if (blk.type === "tool_result" && msg.role !== "user") return bad(`messages.${i}: tool_result belongs in a user message`);
    }
    // Every tool_use must be answered in the very next message, by exactly those ids.
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      const uses = msg.content.filter((x: any) => x.type === "tool_use").map((x: any) => x.id);
      if (uses.length) {
        const next = m[i + 1];
        if (!next) { if (i !== m.length - 1) return bad("tool_use without tool_result"); return bad("the conversation ends with an unanswered tool_use"); }
        const got = (Array.isArray(next.content) ? next.content : []).filter((x: any) => x.type === "tool_result").map((x: any) => x.tool_use_id).sort();
        if (JSON.stringify(got) !== JSON.stringify([...uses].sort())) return bad(`messages.${i + 1}: tool_result blocks must answer exactly the tool_use blocks above (${uses.join(",")})`);
        if ((next.content as any[]).some((x) => x.type !== "tool_result")) { /* text may follow tool_results; allowed */ }
      }
    }
  }
  if (m[m.length - 1].role !== "user") return bad("the last message must be a user message");
  return undefined;
}

/** A model-shaped reply: one or two tool calls, then, once results are in, a sentence. */
function reply(b: any) {
  const last = b.messages[b.messages.length - 1];
  if (Array.isArray(last.content)) return { content: [{ type: "text", text: "Done: I've checked that for you." }] };
  const ask = String(last.content).toLowerCase();
  const tid = () => `toolu_${Math.random().toString(36).slice(2, 12)}`;
  if (ask.includes("balance")) return { content: [{ type: "text", text: "Let me look." }, { type: "tool_use", id: tid(), name: "get_wallet", input: {} }, { type: "tool_use", id: tid(), name: "get_balances", input: { chain: "mock" } }] };
  if (ask.includes("crypto")) return { content: [{ type: "tool_use", id: tid(), name: "list_crypto_wallets", input: {} }] };
  if (ask.includes("card")) return { content: [{ type: "tool_use", id: tid(), name: "create_card", input: { label: "live test", single_use: true, total_limit: 50000 } }] };
  return { content: [{ type: "text", text: "Hello from the stand-in." }] };
}

beforeAll(async () => {
  upstream = createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      const body = JSON.parse(raw);
      requests.push(body);
      if (String(body.messages.at(-1)?.content).includes("explode")) { res.writeHead(529, { "content-type": "application/json" }).end(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } })); return; }
      const problem = validate(req.headers, body);
      const out = problem ?? { status: 200, body: { id: "msg_test", type: "message", role: "assistant", model: body.model, ...reply(body), stop_reason: "end_turn" } };
      if (!problem) toolsSeen = body.tools ?? [];
      res.writeHead(out.status, { "content-type": "application/json" }).end(JSON.stringify(out.body));
    });
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  apiUrl = `http://127.0.0.1:${(upstream.address() as any).port}`;
  const port = 21000 + Math.floor(Math.random() * 1000);
  base = `http://127.0.0.1:${port}`;
  const sb = await createSandbox({ baseUrl: base, mockModel, liveModel: (k) => anthropicModel({ apiKey: k, model: "claude-sonnet-5-5", baseUrl: apiUrl }), maxSessionsPerIpPerHour: 1000, maxTurnsPerSession: 50 });
  await new Promise<void>((r) => (app = serve({ fetch: sb.app.fetch, port, hostname: "127.0.0.1" }, () => r())));
  await sb.init();
});
afterAll(() => { app?.close(); upstream?.close(); });

async function session() {
  const s = (await (await fetch(`${base}/sandbox/session`, { method: "POST" })).json()) as any;
  const h = { "x-sandbox-session": s.session_id, "content-type": "application/json" };
  const chat = async (message: string, api_key?: string) => {
    const t = await (await fetch(`${base}/sandbox/chat`, { method: "POST", headers: h, body: JSON.stringify({ message, api_key }) })).text();
    return [...t.matchAll(/event: (\w+)\ndata: (.*)\n/g)].map((m) => ({ event: m[1]!, data: JSON.parse(m[2]!) }));
  };
  return { chat };
}

describe("live mode against a strict Messages API stand-in", () => {
  it("sends a request the API's rules accept, with every A-CARD tool, and runs the tool loop end to end", async () => {
    const s = await session();
    const ev = await s.chat("what is my balance?", KEY);
    expect(ev.find((e) => e.event === "error")).toBeUndefined();
    expect(ev[0]).toMatchObject({ event: "mode", data: { mode: "live" } });
    expect(ev.filter((e) => e.event === "tool_call").map((e) => e.data.name)).toEqual(["get_wallet", "get_balances"]);
    expect(ev.filter((e) => e.event === "tool_result").every((e) => !e.data.is_error)).toBe(true);
    expect(ev.filter((e) => e.event === "text").map((e) => e.data.text).join(" ")).toMatch(/Done: I've checked that/);
    expect(toolsSeen).toHaveLength(23);
    expect(toolsSeen.map((t) => t.name)).toEqual(expect.arrayContaining(["create_card", "pay_checkout", "find_offers", "list_crypto_wallets", "quote_payment", "send_preview", "swap_quote", "x402_pay"]));
    const first = requests.find((r) => String(r.messages.at(-1).content).includes("balance"))!;
    expect(JSON.stringify(first.system)).toMatch(/Checkout:/);
    expect(JSON.stringify(first.system)).toMatch(/ONE card/);
  });

  it("keeps the conversation valid across several turns, and when the visitor switches between demo and live", async () => {
    const s = await session();
    // demo turn (scripted, blocks made by the demo agent), then live turns on the same history, then demo again
    expect((await s.chat("show me bread offers")).find((e) => e.event === "error")).toBeUndefined();
    for (const q of ["list my crypto wallets please", "create a test card", "what is my balance?"]) {
      const ev = await s.chat(q, KEY);
      expect(ev.find((e) => e.event === "error"), q).toBeUndefined();
      expect(ev.some((e) => e.event === "tool_call"), q).toBe(true);
    }
    const back = await s.chat("close my cards");
    expect(back.find((e) => e.event === "error")).toBeUndefined();
    expect(back[0]).toMatchObject({ data: { mode: "demo" } });
  });

  it("stays usable after the service fails mid-conversation (overloaded, dropped)", async () => {
    const s = await session();
    expect((await s.chat("what is my balance?", KEY)).find((e) => e.event === "error")).toBeUndefined();
    const boom = await s.chat("explode please", KEY);
    expect(boom.find((e) => e.event === "error")!.data.message).toMatch(/model error 529.*Overloaded/);
    // The next messages are still valid conversations, in live and demo mode.
    expect((await s.chat("list my crypto wallets", KEY)).find((e) => e.event === "error")).toBeUndefined();
    expect((await s.chat("what is my balance?")).find((e) => e.event === "error")).toBeUndefined();
  });

  it("surfaces the API's own error plainly, without echoing the key", async () => {
    const s = await session();
    const ev = await s.chat("hello", "sk-ant-test-WRONGKEY0123456789abc");
    const err = ev.find((e) => e.event === "error")!;
    expect(err.data.message).toMatch(/model error 401.*invalid x-api-key/);
    expect(JSON.stringify(ev)).not.toContain("WRONGKEY");
    // The session still works afterwards.
    expect((await s.chat("what is my balance?", KEY)).find((e) => e.event === "error")).toBeUndefined();
  });
});
