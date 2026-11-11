/**
 * Live-mode smoke test against the REAL Anthropic API, with your own key.
 *
 *   ANTHROPIC_API_KEY=sk-ant-… npm run live-smoke -w @acard/sandbox
 *
 * It starts the sandbox, opens a session, and sends a handful of real requests
 * through Claude, checking that Claude calls the right A-CARD tools and that
 * the platform's controls hold. It costs a few cents. The key is read from the
 * environment, sent only to api.anthropic.com, and never printed.
 */
import { serve } from "@hono/node-server";
import { createSandbox } from "../src/app.js";
import { mockModel } from "../src/mock.js";
import { anthropicModel, checkAnthropicKey } from "../src/model.js";

const key = process.env.ANTHROPIC_API_KEY?.trim();
if (!key) { console.error("Set ANTHROPIC_API_KEY first (it is only sent to api.anthropic.com)."); process.exit(2); }
const model = process.env.SANDBOX_MODEL ?? "claude-sonnet-5-5";

const check = await checkAnthropicKey(key);
console.log(`key check: ${check.ok ? "ok" : "FAILED"} — ${check.message}`);
if (!check.ok) process.exit(1);

const port = 20000 + Math.floor(Math.random() * 2000);
const base = `http://127.0.0.1:${port}`;
const sb = await createSandbox({ baseUrl: base, mockModel, liveModel: (k) => anthropicModel({ apiKey: k, model }), maxTurnsPerSession: 40, maxSessionsPerIpPerHour: 100 });
const server = serve({ fetch: sb.app.fetch, port, hostname: "127.0.0.1" });
await sb.init();
const { session_id: sid } = (await (await fetch(`${base}/sandbox/session`, { method: "POST" })).json()) as any;

interface Turn { text: string; tools: string[]; results: Array<{ name: string; out: string; err: boolean }>; error?: string }
async function chat(message: string): Promise<Turn> {
  const res = await fetch(`${base}/sandbox/chat`, { method: "POST", headers: { "x-sandbox-session": sid, "content-type": "application/json" }, body: JSON.stringify({ message, api_key: key }) });
  const body = await res.text();
  const t: Turn = { text: "", tools: [], results: [] };
  for (const m of body.matchAll(/event: (\w+)\ndata: (.*)\n/g)) {
    const d = JSON.parse(m[2]!);
    if (m[1] === "text") t.text += d.text + "\n";
    if (m[1] === "tool_call") t.tools.push(d.name);
    if (m[1] === "tool_result") t.results.push({ name: d.name, out: d.output, err: !!d.is_error });
    if (m[1] === "error") t.error = d.message;
  }
  if (!res.ok) t.error = body.slice(0, 200);
  return t;
}

const cases: Array<{ say: string; expect: (t: Turn) => string | undefined }> = [
  { say: "What's my balance?", expect: (t) => (t.tools.some((x) => /get_wallet|get_balances|wallet_status/.test(x)) ? undefined : "did not look at a wallet") },
  { say: "Create a R500 single-use card for fuel only.", expect: (t) => (t.tools.includes("create_card") ? undefined : "did not create a card") },
  { say: "Show me milk and eggs offers.", expect: (t) => (t.tools.filter((x) => x === "find_offers").length >= 1 ? undefined : "did not search A-MERCHANT") },
  { say: "What crypto wallets do I have linked?", expect: (t) => (t.tools.includes("list_crypto_wallets") ? undefined : "did not call list_crypto_wallets") },
  { say: `How should I pay $5 to ${base}/demo/weather?`, expect: (t) => (t.tools.includes("quote_payment") ? undefined : "did not call quote_payment") },
  { say: "Send 7 USDC to supplier-1 from the wallet.", expect: (t) => (t.tools.includes("send_preview") ? undefined : "did not preview a transfer") },
  { say: "Try to spend R500 at Lucky Spin Online, an online casino, on a general card (category 7995).", expect: (t) => (t.results.some((r) => r.name === "pay_checkout" && /declin|blocked_by_policy|false/.test(r.out)) ? undefined : "the casino charge was not refused") },
  { say: "Buy 5 reams of A4 paper.", expect: (t) => (t.tools.includes("pay_checkout") ? undefined : "did not pay") },
];

let failed = 0;
for (const c of cases) {
  const t = await chat(c.say);
  const why = t.error ? `error: ${t.error}` : c.expect(t);
  if (why) failed++;
  console.log(`\n${why ? "FAIL" : "PASS"}  “${c.say}”${why ? `  → ${why}` : ""}\n  tools: ${t.tools.join(", ") || "(none)"}\n  agent: ${t.text.trim().replace(/\n/g, " ").slice(0, 220)}`);
}
console.log(`\n${failed ? `${failed} of ${cases.length} checks failed` : `all ${cases.length} checks passed`}`);
server.close();
process.exit(failed ? 1 : 0);
