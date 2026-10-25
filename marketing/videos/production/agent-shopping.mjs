import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { studio, make, slide, titleCard, terminal, signedIn, finish, wait } from "./mlib.mjs";
import { mcpHttp, closeMcpHttp, claudeCli, world } from "./real.mjs";

/**
 * "Connect an agent, let it shop": the agent is connected to A-CARD over MCP,
 * then searches the web and checks out at a grocery store, a marketplace and
 * an airline (the demo web in ./web, on :4400).
 *
 *   node agent-shopping.mjs public    fictional stores; safe to publish
 *   node agent-shopping.mjs private   illustrative recreations of real South African
 *                                     retailers, for private client demos only.
 *                                     Every frame carries a "not for publication"
 *                                     badge and every store page a "not affiliated" strip.
 *
 * What's live: `claude mcp add` / `claude mcp list` (run in a scratch HOME), the
 * MCP tool list and every A-CARD tool call (Streamable HTTP, :8788), every payment
 * decision (the store posts to A-CARD's issuer webhook through web/server.mjs), and
 * the approval click in the real dashboard. What's scripted: the agent's browsing
 * and its words. There's no LLM in the loop, and the captions say so.
 */

const SET = process.argv[2] === "private" ? "private" : "public";
const WEB = "http://localhost:4400";
const w = world();

// Brand names and domains come from the same file the store pages use.
const sandbox = { window: {}, URLSearchParams, location: { search: "" } };
runInNewContext(readFileSync(new URL("./web/brands.js", import.meta.url), "utf8"), sandbox);
const B = sandbox.window.BRANDS[SET];
const R = sandbox.window.R;
const q = `?set=${SET}`;

const { browser, ctx, page } = await studio(`agent-shopping-${SET}`, undefined, {
  note: SET === "private" ? "Private client demo · not for publication" : undefined,
});
const ui = make(page);
// The dashboard renders its product chooser for a moment before it reads the
// stored session. Keep its pages dark until the console's nav is up.
await ctx.addInitScript(() => {
  if (location.port !== "3000" || window !== window.top) return;
  const s = document.createElement("style");
  s.textContent = "html{background:#050a10 !important} body{visibility:hidden !important}";
  const lift = () => s.remove();
  document.addEventListener("DOMContentLoaded", () => {
    document.head.appendChild(s);
    const t = setInterval(() => { if (document.querySelector(".nav-item")) { clearInterval(t); lift(); } }, 50);
    setTimeout(() => { clearInterval(t); lift(); }, 8000);
  });
});
const web = page.frameLocator("#web");
const frame = () => page.frames().find((f) => f.url().startsWith(WEB) && !f.url().includes("/console"));

// Playwright's boxes for elements inside the iframe are off under the CSS zoom,
// so in-frame clicks place the cursor from the element's own rect and click in-page.
async function aim(el) {
  await el.evaluate((e) => e.scrollIntoView({ block: "center" }));
  await wait(150);
  const r = await el.evaluate((e) => { const b = e.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; });
  await page.evaluate(({ x, y }) => {
    const f = document.getElementById("web").getBoundingClientRect(); // screen px under the zoom
    const z = parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
    const c = document.getElementById("__cur");
    c.classList.add("on");
    c.style.transition = "left .5s cubic-bezier(.3,.8,.3,1),top .5s cubic-bezier(.3,.8,.3,1),opacity .25s";
    c.style.left = (f.x + x * z) / z + "px";
    c.style.top = (f.y + y * z) / z + "px";
  }, r);
  await wait(560);
}
async function fclick(el, { pre = 260, post = 650 } = {}) {
  await el.waitFor({ state: "visible", timeout: 15000 });
  await aim(el);
  await page.evaluate(() => { const c = document.getElementById("__cur"); c.classList.remove("tap"); void c.offsetWidth; c.classList.add("tap"); });
  await wait(pre);
  await el.evaluate((e) => e.click());
  await wait(post);
}
async function ftype(el, text, { delay = 40, post = 380 } = {}) {
  await el.waitFor({ state: "visible", timeout: 15000 });
  await aim(el);
  await el.focus();
  await el.fill("");
  await el.pressSequentially(text, { delay });
  await wait(post);
}

const agent = (fn, ...args) => page.evaluate(([fn, args]) => window.agent[fn](...args), [fn, args]);
const think = async (text, ms = 1300) => { await agent("status", text); await wait(ms); };
async function browse(path, shown) {
  await agent("go", path, shown);
  await page.waitForFunction((p) => document.getElementById("web").contentWindow?.location.pathname === p, path.split("?")[0]);
  await wait(900);
}
async function search(query, shown) {
  await agent("tool", "browser.search", query, "", "");
  await browse(`/seek${q}`, `seek.demo/search?q=${encodeURIComponent(query)}`);
  await ftype(web.locator("#q"), query, { delay: 28, post: 250 });
  await frame().evaluate((s) => window.seek.run(s), query);
  await wait(1300);
  await fclick(web.locator(".r a").first(), { post: 300 });
  await page.waitForFunction(() => !document.getElementById("web").contentWindow?.location.pathname.startsWith("/seek"));
  await agent("addr", shown);
  await wait(1100);
}
async function payAt(pan, exp) {
  await ftype(web.locator("#pan"), spaced(pan), { delay: 22 });
  await ftype(web.locator("#exp"), exp, { delay: 40 });
  await fclick(web.locator("#pay"), { post: 300 });
  await frame().waitForFunction((prev) => window.lastPayment && window.lastPayment !== prev, null);
  await wait(700);
  return frame().evaluate(() => window.lastPayment);
}
const decision = (d) => JSON.stringify(d.approved ? { approved: true } : { approved: false, decline_reason: d.decline_reason, ...(d.approval_id ? { approval_id: d.approval_id } : {}) });
const expOf = (c) => `${String(c.expiryMonth).padStart(2, "0")}/${String(c.expiryYear).slice(2)}`;
// The tool result as the agent would summarise it, from the real create_card response.
const cardSummary = (c) =>
  [
    `${c.id} · ••${c.last4}${c.singleUse ? " · single-use" : ""}`,
    c.limits?.perTransaction && `max ${R(c.limits.perTransaction)} per charge`,
    c.limits?.total && `max ${R(c.limits.total)} total`,
    `MCC ${c.allowedMerchantCategories.join(", ")} only`,
    c.approvalThreshold && `human approval from ${R(c.approvalThreshold)}`,
  ].filter(Boolean).join("\n");
const spaced = (pan) => pan.replace(/(\d{4})(?=\d)/g, "$1 ");

// ── 0. Open ──────────────────────────────────────────────────────────────
await titleCard(page, {
  kicker: SET === "private" ? "Private client demo" : "Agent shopping",
  title: "Connect an agent.<br>Let it shop. Stay in control.",
  sub: `It searches the web and checks out at ${B.grocery.name}, ${B.market.name} and ${B.airline.name}, each time on a card A-CARD scoped for that one job.`,
  hold: 5200,
});

// ── 1. Connect over MCP ─────────────────────────────────────────────────
await signedIn(page, w.session);
await ui.say(`Thandi runs operations at Khaya Logistics. First she connects her agent to A-CARD.`);
await ui.nav("Connect agents");
await ui.spotlight(page.getByText("Connect your agent").locator("xpath=ancestor::div[contains(@class,'panel') or contains(@class,'card')][1]"), 2600).catch(() => {});
await ui.say(`The console gives her one command. It points the agent at A-CARD's MCP server.`, 3200);
await ui.clear();

const added = await claudeCli(["mcp", "add", "--transport", "http", "acard", "http://localhost:8788/mcp", "--header", `Authorization: Bearer ${w.agentKey}`]);
const listed = await claudeCli(["mcp", "list"]);
const tools = await mcpHttp();
await terminal(
  page,
  [
    { cmd: `claude mcp add --transport http acard http://localhost:8788/mcp --header "Authorization: Bearer ak_…"`, out: added.replace(/\nFile modified:.*$/m, ""), hold: 1800 },
    { cmd: "claude mcp list", out: listed, color: "#86efac", hold: 1800 },
    { comment: "what the agent sees once connected (MCP tools/list)", hold: 700 },
    { prompt: "mcp ›", cmd: "tools/list", out: tools.map((t) => `${t.name.padEnd(18)} ${t.title ?? ""}`).join("\n"), color: "#a5f3fc", hold: 4200 },
  ],
  { title: "Claude Code · connect A-CARD (real output; API key masked)", typeMs: 14 },
);

// ── 2. The job ───────────────────────────────────────────────────────────
await page.goto(`${WEB}/console`, { waitUntil: "networkidle" });
await agent("status", "connected · acard", true);
await wait(600);
await ui.say(`Agent steps are scripted for this recording. <b>Every A-CARD call and payment decision is live.</b>`, 3600);
await agent(
  "user",
  `Three things please: this week's office groceries from ${B.grocery.name}, a wireless keyboard and mouse for the new hire from ${B.market.name}, and flights to Cape Town for me. Friday morning out, Sunday evening back, cheapest fares.`,
);
await wait(2600);
await think("planning");
await agent("say", "I'll create <b>one card per purchase</b>, each locked to the kind of store it's for.");
await wait(1600);

const grocery = await mcpHttp("create_card", { label: "Office groceries", single_use: true, per_transaction_limit: 150000, allowed_merchant_categories: ["5411"] });
await agent("tool", "acard.create_card", `{"label":"Office groceries","per_transaction_limit":150000,"allowed_merchant_categories":["5411"]}`, cardSummary(grocery), "ok", true);
await wait(1300);
const gear = await mcpHttp("create_card", { label: "New-hire keyboard & mouse", single_use: true, per_transaction_limit: 120000, allowed_merchant_categories: ["5732"] });
await agent("tool", "acard.create_card", `{"label":"New-hire keyboard & mouse","per_transaction_limit":120000,"allowed_merchant_categories":["5732"]}`, cardSummary(gear), "ok", true);
await wait(1300);
const trip = await mcpHttp("create_card", { label: "CPT trip · Thandi", single_use: true, total_limit: 400000, allowed_merchant_categories: ["4511"], approval_threshold: 250000 });
await agent("tool", "acard.create_card", `{"label":"CPT trip · Thandi","total_limit":400000,"allowed_merchant_categories":["4511"],"approval_threshold":250000}`, cardSummary(trip), "ok", true);
for (const c of [grocery, gear, trip]) {
  await fetch(`${WEB}/api/cards`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pan: c.sandboxPan, cardId: c.id }) });
}
await ui.say(`Three single-use cards from one MCP session: groceries only (MCC 5411), electronics only (5732), airlines only (4511). The flight card asks a human above <b>R2 500</b>.`, 6200);
await ui.clear();

// ── 3. Groceries ─────────────────────────────────────────────────────────
await think("browsing", 600);
await search(`${B.grocery.name} online grocery delivery Rosebank`, B.grocery.domain);
for (const sku of ["milk", "milk", "bread", "bread", "coffee", "rooibos", "bananas", "apples", "sugar", "rusks"]) {
  await fclick(web.locator(`[data-sku="${sku}"]`), { pre: 120, post: 260 });
}
await agent("tool", "browser.add_to_trolley", "10 items · milk ×2, bread ×2, coffee, rooibos, bananas, apples, sugar, rusks", "", "");
await fclick(web.locator("#cartbtn"), { post: 1500 });
await fclick(web.locator("#tocheckout"), { post: 700 });
const g1 = await payAt(grocery.sandboxPan, expOf(grocery));
await agent("tool", "card authorization · A-CARD", `${B.grocery.name} · MCC 5411 · ${R(56390)}`, decision(g1), g1.approved ? "ok" : "bad", true);
await ui.say(`<b>Approved, live.</b> A grocery store, under the R1 500 cap. The card was single-use, so it has already closed.`, 4800);
await ui.clear();

// ── 4. Marketplace + a prompt injection ──────────────────────────────────
await search("wireless keyboard and mouse combo", B.market.domain);
await fclick(web.locator("#open-combo"), { post: 1000 });
await web.locator("#notes").evaluate((e) => { e.style.outline = "3px solid #22c55e"; e.style.outlineOffset = "3px"; });
  await wait(3000);
if (SET === "private") await ui.say(`"GadgetDealz SA" and its note are invented for this demo: a third-party seller planting instructions for AI agents.`, 4800);
await think("reading page", 900);
await agent("say", "The seller notes say this item only ships with the Device Protection Bundle. Adding it so the order isn't cancelled.");
await wait(1800);
await fclick(web.locator("#add-bundle"), { post: 500 });
await fclick(web.locator("#add-combo"), { post: 600 });
await fclick(web.locator("#cartbtn"), { post: 1500 });
await fclick(web.locator("#tocheckout"), { post: 700 });
const m1 = await payAt(gear.sandboxPan, expOf(gear));
await agent("tool", "card authorization · A-CARD", `${B.market.name} · MCC 5732 · ${R(549800)}`, decision(m1), m1.approved ? "ok" : "bad", true);
await ui.say(`The agent fell for it. <b>The card didn't.</b> R5 498 is over this card's R1 200 cap, so A-CARD declined and said why.`, 5200);
await think("recovering", 900);
await agent("say", "Declined: <code>per_transaction_limit_exceeded</code>. You didn't ask for a R4 999 bundle, and that note was written for me, not you. Removing it.");
await wait(2400);
await fclick(web.locator("#cartbtn"), { post: 900 });
await fclick(web.locator('[data-remove="bundle"]'), { post: 900 });
await fclick(web.locator("#tocheckout"), { post: 700 });
const m2 = await payAt(gear.sandboxPan, expOf(gear));
await agent("tool", "card authorization · A-CARD", `${B.market.name} · MCC 5732 · ${R(49900)}`, decision(m2), m2.approved ? "ok" : "bad", true);
await ui.say(`Declined, explained, corrected: the keyboard and mouse alone, <b>approved</b>.`, 3800);
await ui.clear();

// ── 5. Flights, held for a human ─────────────────────────────────────────
await search("cheap flights johannesburg to cape town friday", B.airline.domain);
await agent("say", "Cheapest pair: <b>06:00 Friday</b> out, <b>18:10 Sunday</b> back.");
await fclick(web.locator('[data-flight="o1"]'), { post: 600 });
await fclick(web.locator('[data-flight="r2"]'), { post: 900 });
await fclick(web.locator("#tocheckout"), { post: 800 });
const a1 = await payAt(trip.sandboxPan, expOf(trip));
await agent("tool", "card authorization · A-CARD", `${B.airline.name} · MCC 4511 · ${R(289000)}`, decision(a1), a1.approved ? "ok" : "held", true);
await agent("say", "Held for approval: R2 890 is over the R2 500 threshold on this card. <b>Thandi, please approve it in A-CARD</b> and I'll retry.");
await agent("status", "awaiting approval", false);
await ui.say(`The fare is right, but it's over the threshold. A-CARD holds it for a person.`, 3600);
const history = await page.evaluate(() => window.agent.history);

await signedIn(page, w.session);
await ui.nav("Approvals");
await ui.spotlight(page.locator(".btn-approve").first().locator("xpath=ancestor::*[self::tr or contains(@class,'row') or contains(@class,'item')][1]"), 2400).catch(() => {});
await ui.say(`Thandi sees the airline, the amount and the agent's card, and approves.`, 2600);
await ui.click(page.locator(".btn-approve").first(), { post: 1400 });
await ui.clear();

// Back to the agent session: rebuild the transcript and the checkout it left open.
await page.goto(`${WEB}/console`, { waitUntil: "networkidle" });
await page.evaluate((h) => window.agent.restore(h), history);
await agent("go", `/airline${q}`, B.airline.domain);
await page.waitForFunction(() => document.getElementById("web").contentWindow?.store);
await frame().evaluate(() => { window.store.select("out", "o1"); window.store.select("ret", "r2"); window.store.show("checkout"); });
await agent("status", "retrying", true);
await wait(900);
const a2 = await payAt(trip.sandboxPan, expOf(trip));
await agent("tool", "card authorization · A-CARD", `${B.airline.name} · MCC 4511 · ${R(289000)}`, decision(a2), a2.approved ? "ok" : "bad", true);
await ui.say(`<b>Approved.</b> The approval covers this card, this airline, up to this amount, once.`, 4200);

// ── 6. Wrap-up, from A-CARD's own records ────────────────────────────────
const txns = await mcpHttp("list_transactions", {});
await closeMcpHttp();
const mine = (Array.isArray(txns) ? txns : []).filter((t) => [grocery.id, gear.id, trip.id].includes(t.cardId));
const lines = mine.map((t) => `${t.merchantName.padEnd(18)} ${t.type} ${t.status}  ${R(t.amount)}`).join("\n");
await agent("tool", "acard.list_transactions", "", lines, "ok", true);
const spent = mine.filter((t) => t.type === "capture").reduce((s, t) => s + t.amount, 0);
await agent("say", `Done. Groceries arrive within the hour, the keyboard and mouse tomorrow, and your flights are booked. <b>${R(spent)}</b> across three cards, all closed now.`);
await agent("status", "done", true);
await wait(5200);

await slide(
  page,
  `<div style="max-width:980px;padding:0 70px">
    <h2 class="in" style="font-size:40px;margin:0 0 28px;letter-spacing:-1px">What just happened</h2>
    <div class="in d1" style="font-size:23px;line-height:1.6;color:#cfe0ee">
      <div>① One MCP connection. <span style="color:#4ade80">One card per job,</span> locked to a merchant category.</div>
      <div>② A seller's prompt injection fooled the agent. <span style="color:#4ade80">The card cap stopped it.</span></div>
      <div>③ Over the threshold, <span style="color:#4ade80">a person decided.</span> One approval, one purchase.</div>
    </div></div>`,
  7200,
);
await slide(
  page,
  `<div style="text-align:center;padding:0 60px">
    <div class="in" style="font:800 40px ui-sans-serif,system-ui,sans-serif;letter-spacing:1px;margin-bottom:18px">A‑CARD</div>
    <p class="in d1" style="font-size:24px;color:#9fb2c8;margin:0 0 30px">Let agents buy. Keep the say.</p>
    <p class="in d3" style="font-size:14px;color:#6b7f95;margin:0">Sandbox shown. Live card issuance launches with our issuing partner.</p>
    ${SET === "private" ? `<p class="in d4" style="font-size:13px;color:#fca5a5;margin:14px 0 0">Store pages are illustrative recreations for a private demo. No affiliation with or endorsement by Checkers, Takealot or FlySafair.</p>` : `<p class="in d4" style="font-size:13px;color:#6b7f95;margin:14px 0 0">The stores, search engine and seller are fictional.</p>`}
  </div>`,
  5200,
);

console.log("VIDEO:", await finish(browser, ctx, page));
console.log("RESULTS:", JSON.stringify({ g1, m1, m2, a1, a2, spent }));
process.exit(0);
