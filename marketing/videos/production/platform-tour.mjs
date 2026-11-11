import { studio, slide, titleCard, make, finish, wait, FORMATS } from "./mlib.mjs";

/**
 * Platform tour for investors and buyers (1920×1080, ~6 min, captions, no voice-over).
 * Everything on screen is the real A-CARD sandbox (apps/sandbox) running locally:
 * its demo agent is rule-based (no AI model in the loop), money is test money,
 * card issuing is simulated. Slides say so. Needs the sandbox on :8080.
 *   node platform-tour.mjs
 */
const SB = process.env.SANDBOX_URL ?? "http://localhost:8080";
const { browser, ctx, page } = await studio("platform-tour", FORMATS.wide, { note: "Sandbox · scripted demo agent" });
const ui = make(page);
const big = (h, s = "") => `<div style="padding:0 140px"><h1 class="in" style="font-size:62px;line-height:1.12;margin:0 0 ${s ? 22 : 0}px;letter-spacing:-1.4px;font-weight:800">${h}</h1>${s ? `<p class="in d1" style="font-size:25px;line-height:1.5;color:#9fb2c8;margin:0;max-width:1300px">${s}</p>` : ""}</div>`;
const G = (t) => `<span style="color:#4ade80">${t}</span>`;
const row = (items) => `<div style="display:grid;grid-template-columns:repeat(${items.length},1fr);gap:22px;padding:0 90px;width:100%;box-sizing:border-box">${items.map(([h, b]) => `<div class="in" style="background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.12);border-radius:16px;padding:26px 24px"><div style="font:700 25px ui-sans-serif,system-ui;margin-bottom:10px;color:#4ade80">${h}</div><div style="font-size:19px;line-height:1.45;color:#c9d6e4">${b}</div></div>`).join("")}</div>`;
const idle = () => page.waitForFunction(() => !document.querySelector("#send").disabled, null, { timeout: 40000 });
const ask = async (text) => { await ui.type("#q", text, { delay: 38, post: 500 }); await page.keyboard.press("Enter"); await idle(); await wait(900); };
const view = async (v, say, hold) => { if (!(await page.locator(".nav-item").first().isVisible())) await ui.click("#consolebtn", { post: 900 }); await ui.click(`.nav-item[data-v="${v}"]`, { post: 1000 }); if (say) await ui.say(say, hold); };

// ───────────────────────── Why ─────────────────────────
await titleCard(page, { kicker: "A‑CARD · platform tour", title: "Let AI agents spend money. Safely.", sub: "A walkthrough of every part of the platform, for investors and buyers.", hold: 4600 });
await slide(page, big(`Agents can now ${G("find")} and ${G("decide")}.<br>They still can't ${G("pay")} safely.`, "A shared card number is all-or-nothing: no per-task limit, no merchant rules, no audit trail, no human in the loop. Companies won't hand that to software."), 7600);
await slide(page, big(`A‑CARD is the ${G("control layer")} between an agent and money.`, "Every payment gets its own limits, rules and approvals, on whatever rail is cheapest and safest. Cards, wallets and stablecoins, one ledger."), 6800);
await slide(page, `<div style="width:100%"><h2 class="in" style="font-size:40px;margin:0 0 30px;text-align:center;font-weight:800;letter-spacing:-1px">The platform, in five parts</h2>${row([
  ["A‑CARD", "Virtual cards for agents. Spend limits, merchant-category rules, approvals, instant freeze, full audit."],
  ["A‑MERCHANT", "Supplier directory and offers. An agent searches, compares and gets a priced, payable offer."],
  ["AFP", "Agent Financial Platform. Routes each payment to card, x402 or stablecoin by cost, speed and finality."],
  ["Wallets", "Fiat (ZAR, USD) and crypto. Embedded wallets are created at signup; users can link their own."],
  ["Agent access", "MCP server, SDK, CLI and plugins for Claude Code, Codex and OpenClaw."],
])}</div>`, 9000);

// ───────────────────────── The sandbox ─────────────────────────
await page.goto(SB, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => document.querySelector("#turns")?.textContent, null, { timeout: 30000 });
await wait(1200);
await ui.say(`This is the <b>public sandbox</b>: the whole platform on test money. A chat on the left, the console behind it. Today's agent is scripted; a visitor can plug in their own Claude key.`, 7200);
await ui.clear();

// 1. Shopping, multiple suppliers
await ui.say(`<b>1 · Buying.</b> The agent searches A‑MERCHANT. Two products, possibly two suppliers, in one request.`, 4800);
await ask("I'd like to buy some milk and eggs");
await ui.say(`It returns real offers from the supplier directory, with price and supplier. The buyer picks what goes in the basket.`, 5200);
const adds = page.locator("[data-add]");
const n = await adds.count();
if (n) { await ui.click(adds.nth(0), { post: 700 }); }
if (n > 1) { await ui.click(adds.nth(n > 3 ? 3 : 1), { post: 900 }); }
await ui.say(`Fees are shown before paying: an order fee and a card-processing fee. This is how A‑CARD earns, per transaction.`, 6200);
if (await page.locator('[data-cart="checkout"]').count()) {
  if (!(await page.locator('[data-cart="checkout"]').isVisible())) await ui.click('[data-cart="toggle"]', { post: 800 });
  await ui.click('[data-cart="checkout"]', { post: 600 });
  await idle(); await wait(900);
  await ui.say(`One card is issued for the order, limited to just those merchant categories. It can't be used anywhere else.`, 6200);
}
await ui.clear();

// 2. Controls
await ui.say(`<b>2 · Controls.</b> The same agent, asked to do something it shouldn't.`, 3800);
await ask("Try to spend R500 at an online casino on a general card.");
await ui.say(`Blocked at authorization: the merchant category isn't allowed on this card. The decision and reason are logged.`, 6200);
await ask("Create a card that needs my approval above R1 000 and spend R1 500 at Rand Build Supply.");
await ui.say(`Above the threshold the payment <b>waits for a human</b>. The agent can't approve its own spend.`, 5200);
const dock = page.locator('#apdock [data-ap="approve"]').first();
if (await dock.count()) {
  await ui.spotlight("#apdock", 1800);
  await ui.click(dock, { post: 1400 });
  await ui.say(`Approved by the person, and the payment goes through.`, 3400);
}
await ui.clear();

// 3. Console
await ui.say(`<b>3 · The console.</b> What a finance or ops team sees. Same data the agent works on.`, 4200);
await view("cards", `<b>Cards.</b> Every card the agents made: limit, rules, status. One click to close.`, 5200);
await view("spending", `<b>Spending.</b> Every transaction, with merchant, category, amount and outcome. Declines included.`, 5200);
await view("approvals", `<b>Approvals.</b> The human-in-the-loop queue for cards and wallet transfers.`, 4800);
await view("policies", `<b>Policies.</b> Spend caps, category allow and deny lists, thresholds. Set once, enforced on every authorization.`, 6200);
await view("audit", `<b>Audit log.</b> Who or what did what, and when. The record a compliance team asks for.`, 5200);
await view("merchants", `<b>Merchants.</b> The A‑MERCHANT directory agents search. Suppliers list products here.`, 4800);
await ui.click("#msearch", { post: 1200 });
await ui.say(`Supply is a second marketplace side: more suppliers makes agents more useful, and more agents brings suppliers in.`, 6200);
await view("sell", `<b>Sell on A-CARD.</b> Any shop can list itself: tell us who you are, upload your products from a spreadsheet.`, 5600);
await ui.say(`In production a new store stays hidden until we verify the business (KYB). In the sandbox it's verified for you, but only <i>your</i> chat can see it.`, 7000);
await ui.type("#st-name", "Corner Dairy", { delay: 60 });
await ui.spotlight("#st-csv", 2600);
await ui.say(`Prices in rands, one row per product. Bad rows are reported by row number; good rows still go in.`, 5200);
await ui.click("#st-go", { post: 1800 });
await ui.say(`The store is live in your sandbox. Now an agent can buy from it.`, 4200);
await ui.click("[data-sellask]", { post: 800 });
await wait(600);
await ui.click("#send", { post: 500 }).catch(() => {});
await idle(); await wait(1000);
await ui.say(`The agent found the new store, bought from it with a one-time card, and the order is on the ledger. Supplier onboarding, end to end, in minutes.`, 7000);
await ui.clear();

// 4. Wallets
await view("wallet", `<b>4 · Wallets.</b> One place for fiat and crypto.`, 4000);
await ui.click('[data-wtab="fiat"]', { post: 900 });
await ui.say(`<b>Fiat:</b> ZAR and USD balances that fund the cards.`, 4600);
await ui.click('[data-wtab="crypto"]', { post: 900 });
await ui.say(`<b>Crypto:</b> an embedded wallet is created for every account at signup. Users can also link their own (MetaMask, WalletConnect, Coinbase, Solana).`, 7600);
await ui.click(".dd:has(#lk-chain) .dd-btn", { post: 900 });
await ui.say(`Pick the chain and the wallet app from a list with their marks. The platform checks the address format for the chain.`, 5200);
await ui.click('.dd:has(#lk-chain) .dd-opt:has-text("Solana")', { post: 700 });
await ui.click(".dd:has(#lk-conn) .dd-btn", { post: 900 });
await wait(2200);
await ui.click('.dd:has(#lk-conn) .dd-opt:has-text("WalletConnect")', { post: 900 });
await ui.click('[data-wtab="agent"]', { post: 900 });
await ui.say(`<b>Agent wallet:</b> a governed on-chain wallet with its own limits. Small payments go through; larger ones need a person; over the hard cap, refused.`, 7600);
await ui.click('[data-wtab="pay"]', { post: 900 });
await ui.say(`<b>AFP routing.</b> Tell it what you want to pay; it scores each rail on cost, speed and finality.`, 5200);
await ui.click(".dd:has(#rt-cp) .dd-btn", { post: 900 });
await ui.say(`Who are you paying? An API, a supplier's wallet, or a merchant on a card. The choice decides which rails can carry it.`, 5600);
await ui.click('.dd:has(#rt-cp) .dd-opt:has-text("supplier")', { post: 900 });
await ui.click("#rt-go", { post: 1200 });
await ui.say(`Cards are fast but reversible for months. Stablecoins settle instantly and finally. Each option shows its trade-off, and the buyer chooses.`, 7600);
if (await page.locator("[data-wpay]").count()) { await ui.click("[data-wpay]", { post: 1400 }); await ui.say(`One unified ledger across every rail, with settlement status.`, 4800); }
await ui.clear();

// 5. Agent payments in chat
await ui.click('.nav-item[data-v="agent"]', { post: 1000 });
await ui.say(`<b>5 · Machine payments.</b> Agents also pay APIs directly, per call, using the x402 standard.`, 4800);
await ask("Pay for the weather API with x402 from a USD card. Max 1 cent.");
await ui.say(`The agent sets its own ceiling. Anything above it is refused, and the payment is recorded like any other.`, 5800);
await ask("Send 20 USDC from the wallet to merchant-1, then try 90.");
await ui.say(`Wallet policy in action: 20 USDC needs approval; 90 is over the hard cap and refused outright.`, 5800);
await ui.clear();

// 6. Connect
await view("connect", `<b>6 · Connect your agent.</b> MCP server, TypeScript SDK, CLI, and a plugin for Claude Code, Codex and OpenClaw. 23 tools for agents.`, 7600);
await ui.clear();

// ───────────────────────── Business ─────────────────────────
await slide(page, big(`How it ${G("makes money")}.`, "Per-transaction fees on orders and card processing, interchange share with the issuing partner, a routing margin on crypto rails, and subscription tiers for teams. The sandbox shows illustrative fees, not final pricing."), 8600);
await slide(page, `<div style="width:100%"><h2 class="in" style="font-size:40px;margin:0 0 30px;text-align:center;font-weight:800;letter-spacing:-1px">Where it stands today</h2>${row([
  ["Built and tested", "REST API, dashboard, MCP server, SDK, CLI, plugins, AFP routing, x402, agent wallet, supplier directory. 548 automated tests pass."],
  ["Test networks only", "A self-hosted embedded-wallet provider sends testnet USDC. Verified against a simulated chain, not yet a live one. Unaudited."],
  ["Not live yet", "Card issuing is simulated until our issuing partner goes live. No real money moves today. No SOC 2 report yet."],
])}</div>`, 10000);
await slide(page, big(`The ask.`, "We are looking for an issuing partner, design customers and investors to take this from sandbox to live issuance. Try the sandbox yourself, then let's talk."), 7600);
await slide(page, `<div style="text-align:center;padding:0 80px">
  <div class="in" style="font:800 44px ui-sans-serif,system-ui,sans-serif;letter-spacing:1px;margin-bottom:22px">A‑CARD</div>
  <p class="in d1" style="font-size:28px;color:#9fb2c8;margin:0 0 34px">Cards and wallets for AI agents.</p>
  <p class="in d3" style="font-size:16px;color:#6b7f95;margin:0">Sandbox shown: scripted demo agent, test money, simulated card issuing.<br>Live issuance launches with our issuing partner.</p></div>`, 5200);

const path = await finish(browser, ctx, page);
console.log("VIDEO:", path);
