import { createServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { anthropicModel } from "../src/model.js";

/**
 * The live-mode adapter against a local stand-in for the documented Messages
 * API: it checks what we send (key header, version, tools, system prompt) and
 * how we read tool_use back. It cannot prove Anthropic's real service accepts
 * the request; that needs a real key.
 */
let url: string;
let server: ReturnType<typeof createServer>;
const seen: Array<{ headers: Record<string, any>; body: any }> = [];
let reply: { status: number; body: unknown } = { status: 200, body: {} };

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      seen.push({ headers: req.headers, body: JSON.parse(raw) });
      res.writeHead(reply.status, { "content-type": "application/json" }).end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as any).port}`;
});
afterAll(() => server.close());

const tools = [{ name: "create_card", description: "x", input_schema: { type: "object", properties: {} } }];

describe("anthropicModel", () => {
  it("sends the key, version, system prompt and tools, and reads tool_use back", async () => {
    reply = { status: 200, body: { content: [{ type: "text", text: "On it." }, { type: "tool_use", id: "tu_1", name: "create_card", input: { label: "x" } }, { type: "thinking", thinking: "dropped" }] } };
    const out = await anthropicModel({ apiKey: "sk-ant-test-key-0123456789", model: "claude-sonnet-5-5", baseUrl: url })({ system: "SYS", messages: [{ role: "user", content: "hi" }], tools });
    expect(out.content).toEqual([{ type: "text", text: "On it." }, { type: "tool_use", id: "tu_1", name: "create_card", input: { label: "x" } }]);
    const r = seen.at(-1)!;
    expect(r.headers["x-api-key"]).toBe("sk-ant-test-key-0123456789");
    expect(r.headers["anthropic-version"]).toBe("2023-06-01");
    expect(r.headers["anthropic-dangerous-direct-browser-access"]).toBeUndefined();
    expect(r.body).toMatchObject({ model: "claude-sonnet-5-5", messages: [{ role: "user", content: "hi" }], tools });
    expect(JSON.stringify(r.body.system)).toContain("SYS");
  });

  it("adds the browser-direct header only for the standalone page", async () => {
    reply = { status: 200, body: { content: [] } };
    await anthropicModel({ apiKey: "sk-ant-test-key-0123456789", model: "m", baseUrl: url, browserDirect: true })({ system: "s", messages: [], tools: [] });
    expect(seen.at(-1)!.headers["anthropic-dangerous-direct-browser-access"]).toBe("true");
  });

  it("surfaces an API error without leaking the key", async () => {
    reply = { status: 401, body: { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } } };
    const key = "sk-ant-test-key-0123456789";
    const err = await anthropicModel({ apiKey: key, model: "m", baseUrl: url })({ system: "s", messages: [], tools: [] }).catch((e) => e as Error);
    expect((err as Error).message).toContain("401");
    expect((err as Error).message).not.toContain(key);
  });
});
