/**
 * High-resolution A-CARD dashboard stills for the launch videos.
 *
 * Captured at deviceScaleFactor 2 (2560x1440 effective) because the Fey and
 * 3D templates tilt and push into these screens hard — a 1x grab goes soft
 * the moment the camera dollies in.
 *
 * Demo data is deliberately on-brand: SA merchants, ZAR, and the exact
 * R372.50 sushi story from the site copy.
 */
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const API = "http://localhost:8787";
const APP = "http://localhost:3000";
const OUT = "/home/user/A-CARD/tutorials/stills";
mkdirSync(OUT, { recursive: true });

const api = async (path, token, init = {}) => {
  const r = await fetch(`${API}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) },
  });
  const b = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${path} → ${r.status} ${JSON.stringify(b)}`);
  return b;
};

// ---- seed a realistic account ------------------------------------------------
const email = `launch${Date.now()}@a-card.cc`;
const reg = await (
  await fetch(`${API}/v1/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, name: "Kasi Labs", password: "supersecret123" }),
  })
).json();
const T = reg.session_token;

await api("/v1/wallet/fund", T, { method: "POST", body: JSON.stringify({ amount: 1_250_000 }) });

const agents = [
  { label: "Grocery agent", limits: { total: 80_000, per_transaction: 40_000 }, allowed_merchant_categories: ["5411"], approval_threshold: 40_000 },
  { label: "Travel agent", limits: { total: 600_000, per_transaction: 300_000 }, approval_threshold: 250_000 },
  { label: "Infra agent", limits: { total: 200_000 } },
  { label: "Logistics agent", limits: { total: 150_000, per_transaction: 30_000 } },
];
const cards = [];
for (const a of agents) cards.push((await api("/v1/cards", T, { method: "POST", body: JSON.stringify({ single_use: false, ...a }) })).card);

// Real spend history — the story from the website copy.
const spend = [
  [0, 37_250, "Sushi Lab", "5812"],
  [0, 18_400, "Checkers Sixty60", "5411"],
  [2, 42_900, "AWS", "5734"],
  [2, 19_900, "OpenAI", "5734"],
  [3, 12_500, "Bolt", "4121"],
  [3, 8_800, "Taxi rank — Bree", "4121"],
  [1, 289_000, "FlySafair JHB", "4511"],
];
for (const [i, amount, name, category] of spend) {
  await fetch(`${API}/v1/simulate/purchase`, {
    method: "POST",
    headers: { authorization: `Bearer ${T}`, "content-type": "application/json" },
    body: JSON.stringify({ card_id: cards[i].id, amount, currency: "ZAR", merchant: { name, category } }),
  });
}
// Two pending approvals — the human-in-the-loop beat.
for (const [i, amount, name] of [[0, 46_000, "Makro"], [1, 312_000, "Airlink CPT"]]) {
  await fetch(`${API}/v1/simulate/purchase`, {
    method: "POST",
    headers: { authorization: `Bearer ${T}`, "content-type": "application/json" },
    body: JSON.stringify({ card_id: cards[i].id, amount, currency: "ZAR", merchant: { name, category: "5411" } }),
  });
}

// ---- capture -------------------------------------------------------------------
const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--no-sandbox", "--force-color-profile=srgb", "--font-render-hinting=none"],
});

async function shoot(theme, tag) {
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 2, // 2560x1600 output — survives a hard push-in
    colorScheme: theme,
  });
  const page = await ctx.newPage();
  await page.goto(APP, { waitUntil: "networkidle" });
  await page.waitForTimeout(700);
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill("supersecret123");
  await page.locator('button[type="submit"]').click();
  await page.waitForSelector(".nav-item", { timeout: 20000 });
  await page.waitForTimeout(2200);

  // Strip scrollbars so the screen edge is clean when tilted in 3D.
  await page.addStyleTag({ content: "::-webkit-scrollbar{display:none!important}" });

  const views = [
    ["overview", "Home"],
    ["cards", "Manage cards"],
    ["spending", "Track spending"],
    ["approvals", "Approvals"],
    ["wallet", "Wallet"],
    ["connect", "Connect agents"],
  ];
  for (const [slug, label] of views) {
    await page.locator(`.nav-item:has-text("${label}")`).first().click();
    await page.waitForTimeout(1400);
    await page.screenshot({ path: `${OUT}/${slug}-${tag}.png` });
    console.log("shot", `${slug}-${tag}.png`);
  }
  await ctx.close();
}

await shoot("dark", "dark");
await shoot("light", "light");
await browser.close();
console.log("\nstills written to", OUT);
