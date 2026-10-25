import { execFile, spawn } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { promisify } from "node:util";
import { performance } from "node:perf_hooks";

/**
 * Real actions against the running demo server. Every terminal block in the
 * videos shows the output of one of these, executed at record time — nothing
 * typed into the terminal player is invented.
 */

const run = promisify(execFile);
const REPO = "/home/user/A-CARD";
const HOME = "/tmp/acard-video-home";
mkdirSync(HOME, { recursive: true });

export const API = "http://localhost:8787";
export const world = () => JSON.parse(readFileSync(new URL("./world.json", import.meta.url), "utf8"));

const ANSI = /\u001b\[[0-9;?]*[ -\/]*[@-~]/g;

/** Run the real `acard` CLI. Returns its output with clack's box-drawing gutter removed. */
export async function cli(args) {
  const { stdout, stderr } = await run(`${REPO}/node_modules/.bin/tsx`, [`${REPO}/apps/cli/src/index.ts`, ...args], {
    cwd: REPO,
    env: { ...process.env, HOME, ACARD_API_URL: API, ACARD_API_KEY: world().agentKey, NO_COLOR: "1", FORCE_COLOR: "0" },
  }).catch((e) => e);
  return `${stdout ?? ""}${stderr ?? ""}`
    .replace(ANSI, "")
    .split("\n")
    .filter((l) => !/^npm notice/.test(l))
    .map((l) => l.replace(/^[│|◇◆●▲■✖✔x*o]\s{0,2}/u, "").trimEnd())
    .filter((l) => l.trim().length)
    .join("\n");
}

/** Call the REST API. Returns { status, body, ms }. */
export async function rest(method, path, body, key = world().agentKey) {
  const t0 = performance.now();
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json, ms: Math.round(performance.now() - t0) };
}

let mcpClient;
/** Call a tool on the real A-CARD MCP server over stdio, as Claude Desktop would. */
export async function mcp(name, args) {
  if (!mcpClient) {
    const { Client } = await import(`${REPO}/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js`);
    const { StdioClientTransport } = await import(`${REPO}/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js`);
    mcpClient = new Client({ name: "demo-recorder", version: "1.0.0" });
    await mcpClient.connect(
      new StdioClientTransport({
        command: `${REPO}/node_modules/.bin/tsx`,
        args: [`${REPO}/apps/mcp/src/index.ts`],
        env: { ...process.env, ACARD_API_URL: API, ACARD_API_KEY: world().agentKey },
        stderr: "ignore",
      }),
    );
  }
  const result = await mcpClient.callTool({ name, arguments: args });
  const text = result.content.map((c) => c.text ?? "").join("");
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function closeMcp() {
  await mcpClient?.close().catch(() => {});
  mcpClient = undefined;
}

/** The last message A-CARD's notifier posted to the Slack Incoming Webhook (captured by the local sink). */
export function slackLast() {
  const lines = readFileSync(process.env.SLACK_LOG ?? "/tmp/claude-0/-home-user-A-CARD/12752dbb-0d8d-5953-b406-38ef64f1dc47/scratchpad/slack.log", "utf8")
    .trim()
    .split("\n")
    .filter(Boolean);
  return lines.length ? JSON.parse(lines[lines.length - 1]).text : undefined;
}

/** Start the merchant POS example (examples/05) as a real process; returns its live log. */
export function startPos() {
  const lines = [];
  const child = spawn(`${REPO}/node_modules/.bin/tsx`, [`${REPO}/examples/05-merchant-pos-sync.ts`], {
    cwd: `${REPO}/examples`,
    env: { ...process.env, ACARD_API_URL: API, ACARD_MERCHANT_KEY: world().merchantKey },
  });
  child.stdout.on("data", (d) => lines.push(...String(d).split("\n").filter((l) => l.trim() && !/npm notice/.test(l))));
  return {
    lines,
    ready: async () => {
      for (let i = 0; i < 100 && !lines.some((l) => l.includes("Listening")); i++) await new Promise((r) => setTimeout(r, 100));
    },
    waitFor: async (text) => {
      for (let i = 0; i < 100 && !lines.some((l) => l.includes(text)); i++) await new Promise((r) => setTimeout(r, 100));
    },
    stop: () => child.kill("SIGINT"),
  };
}

/** Rands from cents, the way the dashboard prints them. */
export const zar = (c) => `R ${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const pretty = (v) => JSON.stringify(v, null, 2);
