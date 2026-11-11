import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, rmSync } from "node:fs";
import { studio, slide, titleCard, terminal, finish, FORMATS } from "./mlib.mjs";
import { claudeCli } from "./real.mjs";

/**
 * Wallet + plugin demo (1920×1080). Every terminal block is real output,
 * captured at record time: the Claude Code plugin install, and the committed
 * plugin bundle (plugins/acard/server/acard-mcp.mjs) driven over stdio as an
 * MCP host drives it, with the sandbox wallet switched on.
 * The agent's tool calls are scripted (no model in the loop) and labelled so.
 *   node wallet-plugins.mjs
 */

const REPO = "/home/user/A-CARD";
const BUNDLE = `${REPO}/plugins/acard/server/acard-mcp.mjs`;
const HOME = "/tmp/acard-wallet-video-home";
rmSync(HOME, { recursive: true, force: true });
mkdirSync(HOME, { recursive: true });
const env = { PATH: process.env.PATH, HOME, ACARD_API_KEY: "ak_sandbox_video", ACARD_API_URL: "http://localhost:8787", ACARD_ENABLE_WALLET: "true", ACARD_WALLET_X402_ALLOW_PRIVATE_NETWORKS: "true" };

// A local paid API speaking x402 v2.
const b64 = (v) => Buffer.from(JSON.stringify(v)).toString("base64");
const requirement = { scheme: "exact", network: "eip155:84532", amount: "3000", asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", payTo: "0x1111111111111111111111111111111111111111", maxTimeoutSeconds: 60 };
const paidApi = createServer((req, res) => {
  if (!req.headers["payment-signature"]) {
    res.writeHead(402, { "payment-required": b64({ x402Version: 2, accepts: [requirement] }) });
    return res.end("{}");
  }
  res.writeHead(200, { "content-type": "text/plain", "payment-response": b64({ success: true, transaction: "0xbeef", network: requirement.network }) });
  res.end("weather: 24C, clear");
});
await new Promise((r) => paidApi.listen(4402, "127.0.0.1", r));
const url = "http://127.0.0.1:4402/weather";

// --- capture real output -------------------------------------------------
const addMp = await claudeCli(["plugin", "marketplace", "add", REPO]);
const install = await claudeCli(["plugin", "install", "acard@a-card"]);
const pluginList = await claudeCli(["plugin", "list"]);

const { Client } = await import(`${REPO}/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js`);
const { StdioClientTransport } = await import(`${REPO}/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js`);
const client = new Client({ name: "demo-recorder", version: "1.0.0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [BUNDLE], cwd: HOME, env, stderr: "ignore" }));
const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  const t = r.content.map((c) => c.text ?? "").join("");
  try { return JSON.parse(t); } catch { return t; }
};
const show = (v, keys) => JSON.stringify(keys ? Object.fromEntries(keys.filter((k) => k in v).map((k) => [k, v[k]])) : v, null, 2);
const op = (...a) => execFileSync(process.execPath, [BUNDLE, ...a], { env, encoding: "utf8" }).trim();

const tools = (await client.listTools()).tools.map((t) => t.name);
const walletTools = tools.filter((t) => /wallet_|balances|receive|send_|approval|x402_|swap_|defi/.test(t));
const status = await call("wallet_status", {});
const transfer = { wallet_id: "default", chain: "mock", asset: "USDC", to: "merchant-1" };
const small = await call("send_preview", { ...transfer, amount: "5000000" });
const smallExec = await call("send_execute", { preview_id: small.preview_id });
const large = await call("send_preview", { ...transfer, amount: "20000000" });
const largeTry = await call("send_execute", { preview_id: large.preview_id });
const pending = op("wallet-approvals");
const approved = op("wallet-approve", large.approval_id);
const largeExec = await call("send_execute", { preview_id: large.preview_id });
const refused = await call("send_preview", { ...transfer, amount: "90000000" });
const xp = await call("x402_preview", { wallet_id: "default", url, max_amount: "10000" });
const xpaid = await call("x402_pay", { preview_id: xp.preview_id });
const xdeny = await call("x402_preview", { wallet_id: "default", url, max_amount: "1000" });
const q = await call("swap_quote", { wallet_id: "default", chain: "mock", asset_in: "USDC", asset_out: "ZARP", amount_in: "2000000" });
const qx = await call("swap_execute", { preview_id: q.preview_id });
const bal = await call("get_balances", { chain: "mock" });
await client.close();
paidApi.close();
await claudeCli(["plugin", "uninstall", "acard@a-card"]);

// --- record ----------------------------------------------------------------
const { browser, ctx, page } = await studio("wallet-plugins", FORMATS.wide, { note: "Agent tool calls scripted · real outputs" });
const big = (h) => `<div style="padding:0 140px"><h1 class="in" style="font-size:68px;line-height:1.1;margin:0;letter-spacing:-1.5px;font-weight:800">${h}</h1></div>`;
const T = { typeMs: 8 };

await titleCard(page, { kicker: "A‑CARD · sandbox", title: "A wallet your agent can't run away with.", sub: "One plugin for Claude Code, Codex and OpenClaw. A governed on‑chain wallet inside it.", hold: 4200 });

await terminal(page, [
  { comment: "install the plugin into Claude Code", hold: 400 },
  { cmd: "claude plugin marketplace add ./A-CARD   # or khayaai/a-card", out: addMp, color: "#86efac", hold: 900 },
  { cmd: "claude plugin install acard@a-card", out: install, color: "#86efac", hold: 900 },
  { cmd: "claude plugin list", out: pluginList, color: "#e2e8f0", hold: 2200 },
], { title: "Claude Code", ...T });

await terminal(page, [
  { comment: "Codex and OpenClaw take the same folder", hold: 300 },
  { cmd: "codex plugin marketplace add khayaai/a-card && codex plugin add acard@a-card", out: "(verified with Codex CLI 0.166.0)", color: "#9fb2c8", hold: 700 },
  { cmd: "openclaw plugins install ./plugins/acard", out: "(verified with OpenClaw 2026.10.9)", color: "#9fb2c8", hold: 1800 },
], { title: "Codex · OpenClaw", ...T });

await terminal(page, [
  { comment: "ACARD_ENABLE_WALLET=true → the agent sees these tools", hold: 300 },
  { cmd: "tools/list", out: `${tools.length} tools. Wallet: ${walletTools.join(", ")}`, color: "#e2e8f0", hold: 1400 },
  { cmd: "wallet_status", out: show(status), color: "#e2e8f0", hold: 2400 },
], { title: "agent (scripted calls) · acard MCP", ...T });

await slide(page, big(`Under 10 USDC: <span style="color:#4ade80">goes through</span>.<br>Over 10: <span style="color:#facc15">a person approves</span>.<br>Over 50: <span style="color:#f87171">refused</span>.`), 3400);

await terminal(page, [
  { cmd: `send_preview  5 USDC → merchant-1`, out: show(small, ["decision", "preview_id"]), color: "#86efac", hold: 700 },
  { cmd: `send_execute  ${small.preview_id}`, out: show(smallExec, ["status", "tx_hash", "amount"]), color: "#86efac", hold: 1200 },
  { cmd: `send_preview  20 USDC → merchant-1`, out: show(large, ["decision", "approval_id"]), color: "#fde68a", hold: 700 },
  { cmd: `send_execute  ${large.preview_id}`, out: typeof largeTry === "string" ? largeTry : show(largeTry), color: "#fde68a", hold: 2000 },
], { title: "agent (scripted calls)", ...T });

await terminal(page, [
  { comment: "a separate terminal: the operator, not the agent", hold: 500 },
  { cmd: "acard-mcp wallet-approvals", out: pending, color: "#e2e8f0", hold: 1000 },
  { cmd: `acard-mcp wallet-approve ${large.approval_id}`, out: approved, color: "#86efac", hold: 1800 },
], { title: "operator", ...T });

await terminal(page, [
  { cmd: `send_execute  ${large.preview_id}`, out: show(largeExec, ["status", "tx_hash", "amount"]), color: "#86efac", hold: 1200 },
  { cmd: `send_preview  90 USDC → merchant-1`, out: show(refused, ["decision", "reasons"]), color: "#fca5a5", hold: 2400 },
], { title: "agent (scripted calls)", ...T });

await slide(page, big(`Pay per API call with <span style="color:#4ade80">x402</span>.<br>The agent sets its own ceiling.`), 2800);

await terminal(page, [
  { cmd: `x402_preview  ${url}  max 0.01 USDC`, out: show(xp, ["decision", "price", "preview_id"]), color: "#86efac", hold: 900 },
  { cmd: `x402_pay  ${xp.preview_id}`, out: show(xpaid, ["status", "body"]), color: "#86efac", hold: 1200 },
  { cmd: `x402_preview  ${url}  max 0.001 USDC`, out: show(xdeny, ["decision", "reasons"]), color: "#fca5a5", hold: 2200 },
], { title: "agent (scripted calls) · local x402 test API", ...T });

await terminal(page, [
  { comment: "swap at the sandbox's fixed rate", hold: 300 },
  { cmd: "swap_quote  2 USDC → ZARP", out: show(q, ["decision", "quote"]), color: "#86efac", hold: 900 },
  { cmd: `swap_execute  ${q.preview_id}`, out: show(qx), color: "#86efac", hold: 900 },
  { cmd: "get_balances", out: show(bal), color: "#e2e8f0", hold: 2400 },
], { title: "agent (scripted calls)", ...T });

await slide(page, big(`Every move: <span style="color:#4ade80">preview → policy → approval → settle</span>.<br>The agent gets capabilities, never keys.`), 3600);
await slide(page, `<div style="text-align:center;padding:0 80px">
  <div class="in" style="font:800 44px ui-sans-serif,system-ui,sans-serif;letter-spacing:1px;margin-bottom:22px">A‑CARD</div>
  <p class="in d1" style="font-size:28px;color:#9fb2c8;margin:0 0 34px">Cards and wallets for AI agents.</p>
  <p class="in d3" style="font-size:16px;color:#6b7f95;margin:0">Sandbox shown: mock chain, test funds, dev signer. Agent calls scripted; outputs are real.<br>Live card issuance launches with our issuing partner.</p></div>`, 4200);

await finish(browser, ctx, page);
