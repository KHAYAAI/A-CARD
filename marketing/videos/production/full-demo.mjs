import { studio, make, slide, titleCard, terminal, login, resume, finish, wait, FORMATS } from "./mlib.mjs";
import { cli, mcp, rest, closeMcp, world, slackLast, startPos, zar, pretty } from "./real.mjs";

/**
 * The full product demo (~5:50). Every terminal block shows the output of a
 * command executed seconds earlier against the running demo server; every
 * dashboard moment is a live click. Captions carry the narration.
 */

const w = world();
const { browser, ctx, page } = await studio("full-demo", FORMATS.wide);
const ui = make(page);

// ---- 0:00 cold open -------------------------------------------------------------
await slide(
  page,
  `<div style="max-width:980px;padding:0 70px">
    <p class="in" style="font-size:24px;color:#9fb2c8;margin:0 0 26px">An agent has found the parts. It needs to pay.</p>
    <div class="in d2" style="font:600 30px/1.5 ui-monospace,Menlo,monospace;color:#e5edf5;background:#0b121a;border:1px solid #1d2836;border-radius:14px;padding:26px 32px;margin-bottom:28px">
      Here's the company card: <span style="color:#f87171">4242 •••• •••• 4242</span></div>
    <p class="in d4" style="font-size:40px;line-height:1.2;font-weight:800;letter-spacing:-1px;margin:0">
      You just handed it <span style="color:#f87171">the entire balance</span>,<br>every merchant, unlimited times.</p>
  </div>`,
  9000,
);
await slide(
  page,
  `<div style="max-width:960px;padding:0 70px">
    <p class="in" style="font-size:30px;line-height:1.45;color:#c3d2e2;margin:0 0 24px">Every payment system asks one question:<br><span style="color:#9fb2c8">can this card make this payment?</span></p>
    <p class="in d3" style="font-size:36px;line-height:1.35;font-weight:800;letter-spacing:-.6px;margin:0">None of them ask the one that matters:<br>
      <span style="color:#4ade80">is this agent allowed to make this purchase, for this organisation, under this budget, right now?</span></p>
  </div>`,
  10500,
);

// ---- 0:20 title + three layers --------------------------------------------------------
await titleCard(page, {
  kicker: "A-CARD",
  title: "Give your agents a wallet.<br>Keep control of the spend.",
  sub: "The permission layer for agent spending. Three questions, answered on every charge.",
  hold: 5200,
});
await slide(
  page,
  `<div style="width:100%;max-width:1040px;padding:0 70px">
    ${[
      ["Where can it buy?", "A-MERCHANT", "Verified suppliers, live stock, a freshness timestamp on every offer.", "#38bdf8"],
      ["May it spend?", "A-CARD", "Scoped cards, hard limits, human approvals, a double-entry ledger.", "#4ade80"],
      ["How does the money move?", "AFP", "Each payment routed to the rail that fits: cost, speed, finality.", "#facc15"],
    ]
      .map(
        ([q, name, body, c], i) => `<div class="in d${i * 2 + 1}" style="display:flex;gap:26px;align-items:center;margin-bottom:26px">
        <div style="width:6px;height:78px;border-radius:3px;background:${c};flex:none"></div>
        <div><div style="font:600 14px ui-monospace,Menlo,monospace;color:${c};margin-bottom:6px">${q}</div>
        <div style="font-size:30px;font-weight:800;letter-spacing:-.5px">${name}</div>
        <div style="font-size:18px;color:#9db0c6;margin-top:4px">${body}</div></div></div>`,
      )
      .join("")}
  </div>`,
  11000,
);

// ---- 0:45 the organisation ---------------------------------------------------------------
await login(page, ui, w.email, w.password);
await ui.say("This is <b>Khaya Logistics</b>, a fleet and construction-supply business in Johannesburg.", 3800);
await ui.spotlight(page.locator(".stats").first(), 2600).catch(() => {});
await ui.say("Two wallets, rands and dollars, on one double-entry ledger. Every amount is integer cents.", 4600);
await ui.say("Below: spend by department, against each department's monthly budget.", 3800);
await ui.nav("Departments");
await ui.say("Three departments, each with a monthly budget. It's enforced on every charge, not reconciled at month end.", 6000);
await ui.nav("Policies");
await ui.say("Org policy sits above every card. Gambling (<code>7995</code>) is blocked company-wide, and anything over <b>R25 000</b> needs a person.", 6800);
await ui.clear();

// ---- 1:30 issue a card over MCP --------------------------------------------------------------
const created = await mcp("create_card", {
  label: "fleet-agent-12",
  single_use: false,
  per_transaction_limit: 500_000,
  total_limit: 4_000_000,
  allowed_merchant_categories: ["5541", "5542", "7538"],
});
await slide(
  page,
  `<div style="max-width:960px;padding:0 70px">
    <p class="in" style="font-size:20px;color:#9fb2c8;margin:0 0 14px">An agent asks for a card</p>
    <p class="in d1" style="font-size:34px;line-height:1.35;font-weight:800;letter-spacing:-.5px;margin:0">“Create a fuel card for fleet-agent-12: R5 000 per fill, R40 000 total, fuel and service stations only.”</p>
    <p class="in d3" style="font-size:18px;color:#7d8fa6;margin:22px 0 0">Claude, or any MCP client, calls A-CARD's <code style="color:#a7f3d0">create_card</code> tool. Next: the real call and the real response.</p>
  </div>`,
  7500,
);
await terminal(
  page,
  [
    {
      prompt: "mcp ›",
      cmd: `create_card ${JSON.stringify({ label: "fleet-agent-12", single_use: false, per_transaction_limit: 500000, total_limit: 4000000, allowed_merchant_categories: ["5541", "5542", "7538"] })}`,
      out: pretty({
        id: created.id,
        status: created.status,
        currency: created.currency,
        singleUse: created.singleUse,
        limits: created.limits,
        allowedMerchantCategories: created.allowedMerchantCategories,
        last4: created.last4,
      }),
      hold: 5200,
    },
  ],
  { title: "MCP client → acard server (the same tool calls Claude makes)", typeMs: 14 },
);
await resume(page);
await ui.nav("Manage cards");
await ui.say(`The card is live in the console the moment the agent asks for it: <b>fleet-agent-12</b>, •••• ${created.last4}.`, 5200);
await ui.clear();

// ---- 2:10 a purchase, and the authorization path ------------------------------------------------
const fuel = await rest("POST", "/v1/simulate/purchase", { card_id: created.id, amount: 185_000, merchant: { name: "Highveld Tyre & Fuel", category: "5541" } });
const fuelCli = `Approved. Wallet available: ${zar(fuel.body.wallet.available)}`;
await terminal(
  page,
  [
    { comment: "the agent fills up: R1 850 of diesel", hold: 900 },
    { cmd: `acard simulate-purchase ${created.id} 185000 "Highveld Tyre & Fuel" --mcc 5541`, out: fuelCli, color: "#86efac", hold: 3000 },
  ],
  { title: "bash — the sandbox plays the card issuer, through the real authorization path" },
);
await slide(
  page,
  `<div style="width:100%;max-width:1000px;padding:0 70px">
    <div class="in" style="font:600 15px ui-monospace,Menlo,monospace;color:#7d8fa6;margin-bottom:16px">AUTH ${fuel.body.authorization_id.slice(0, 18)}… · ZAR 1 850.00 · fleet-agent-12</div>
    <div style="font:15.5px/2 ui-monospace,Menlo,monospace;background:#0a1017;border:1px solid #1d2836;border-radius:13px;padding:18px 28px">
    ${[
      ["exactly-once guard", "new authorization"],
      ["org policy", "MCC 5541 not blocked"],
      ["card status", "active"],
      ["currency", "ZAR = ZAR"],
      ["merchant category", "5541 on allow-list"],
      ["per-transaction cap", "1 850 ≤ 5 000"],
      ["card total", "1 850 of 40 000"],
      ["approval threshold", "below R25 000"],
      ["atomic hold", "placed against available"],
    ]
      .map(([k, v], i) => `<div class="in" style="animation-delay:${0.15 + i * 0.22}s;display:flex;justify-content:space-between"><span style="color:#b3c3d4">${k}</span><span style="color:#4ade80">✓ ${v}</span></div>`)
      .join("")}
    <div class="in" style="animation-delay:2.4s;border-top:1px dashed #2a3d45;margin-top:10px;padding-top:10px;display:flex;justify-content:space-between;color:#facc15;font-weight:700"><span>APPROVED</span><span>round trip ${fuel.ms} ms</span></div>
    </div>
    <p class="in" style="animation-delay:2.8s;font-size:19px;color:#9fb2c8;margin:22px 0 0">Every charge runs the same path, in the same order, for every client. The check and the ledger write are one atomic operation, so overspend can't happen.</p>
  </div>`,
  14500,
);

// ---- 2:50 blocked --------------------------------------------------------------------------------
const tv = await cli(["simulate-purchase", created.id, "90000", "Game Electronics", "--mcc", "5732"]);
const casino = await cli(["simulate-purchase", created.id, "50000", "Lucky Spin Online", "--mcc", "7995"]);
await terminal(
  page,
  [
    { comment: "same card, the wrong kind of merchant", hold: 800 },
    { cmd: `acard simulate-purchase ${created.id} 90000 "Game Electronics" --mcc 5732`, out: tv, color: "#fca5a5", hold: 2600 },
    { comment: "and somewhere no card in this company may go", hold: 800 },
    { cmd: `acard simulate-purchase ${created.id} 50000 "Lucky Spin Online" --mcc 7995`, out: casino, color: "#fca5a5", hold: 3200 },
  ],
  { title: "bash — declines come back as reasons, not shrugs" },
);
await slide(
  page,
  `<div style="max-width:980px;padding:0 70px">
    <h2 class="in" style="font-size:36px;margin:0 0 24px;letter-spacing:-.6px">A fuel card can't buy a TV.</h2>
    <p class="in d2" style="font-size:22px;line-height:1.6;color:#c3d2e2;margin:0 0 18px"><code style="color:#fca5a5">merchant_category_not_allowed</code>: the card's own allow-list said no.</p>
    <p class="in d3" style="font-size:22px;line-height:1.6;color:#c3d2e2;margin:0 0 18px"><code style="color:#fca5a5">merchant_category_blocked_by_policy</code>: org policy is checked <b>before</b> any card rule, so no card configuration can route around it.</p>
    <p class="in d5" style="font-size:20px;line-height:1.6;color:#9fb2c8;margin:0">Neither charge was funded. There's nothing to claw back, because nothing left.</p>
  </div>`,
  12000,
);

// ---- 3:20 A-MERCHANT -------------------------------------------------------------------------------
const search = await mcp("find_offers", { query: "cement", quantity: 500, lat: -26.2309, lng: 28.1772, radius_km: 60, max_lead_time_days: 1, max_total_cents: 6_000_000 });
await closeMcp();
const best = search.offers[0];
await terminal(
  page,
  [
    {
      prompt: "mcp ›",
      cmd: `find_offers {"query":"cement","quantity":500,"lat":-26.2309,"lng":28.1772,"radius_km":60,"max_lead_time_days":1,"max_total_cents":6000000}`,
      out:
        `offers:\n` +
        search.offers
          .map((o) => `  ${o.merchant.name.padEnd(22)} ${zar(o.totalCents).padStart(14)}  ${o.distanceKm.toFixed(1)} km  lead ${o.leadTimeDays}d  ${o.freshness}  score ${o.score.toFixed(3)}`)
          .join("\n") +
        `\nexcluded:\n` +
        search.excluded.map((e) => `  ✗ ${e.reason}`).join("\n"),
      hold: 7500,
    },
  ],
  { title: "MCP client → acard server: find_offers", typeMs: 12 },
);
await slide(
  page,
  `<div style="max-width:1000px;padding:0 70px">
    <h2 class="in" style="font-size:34px;margin:0 0 22px;letter-spacing:-.6px">Not a web search. A verified answer.</h2>
    <p class="in d1" style="font-size:21px;line-height:1.6;color:#c3d2e2;margin:0 0 16px">Only KYB-verified merchants are ever returned. Each offer says how recently its stock was confirmed: <b style="color:#4ade80">${best.freshness}</b>, ${best.inventoryAgeHours.toFixed(1)} hours ago.</p>
    <p class="in d2" style="font-size:21px;line-height:1.6;color:#c3d2e2;margin:0 0 16px">The cheaper suppliers lost for real reasons, and the agent can repeat them to the person who owns the budget.</p>
    <p class="in d4" style="font-size:24px;line-height:1.5;font-weight:800;margin:0">There is no paid placement. A supplier ranks higher by having the stock, confirming it, and delivering on time.</p>
  </div>`,
  13000,
);

await resume(page);
await ui.nav("Merchants");
await ui.say("Merchants are onboarded, not scraped. Each one passes KYB before an agent can see it.", 5000);
await ui.spotlight(page.locator("tr", { hasText: "Vaal Hardware" }).first(), 1200).catch(() => {});
await ui.say("<b>Vaal Hardware</b> is still pending KYB, so it never appears in a search, however cheap it is.", 5200);
await ui.clear();

// The merchant's own till, connected through its API, receives the order.
const pos = startPos();
await pos.ready();
const placed = await rest("POST", `/v1/merchants/${best.merchant.id}/orders`, {
  lines: [{ item_id: best.item.id, quantity: 500 }],
  fulfilment: { method: "delivery", address: "Khaya Logistics depot, 14 Refinery Rd, Germiston" },
});
await pos.waitFor("accepted");
await wait(400);
pos.stop();
const posLog = pos.lines.filter((l) => /^(←|→|Listening)/.test(l)).join("\n");
await terminal(
  page,
  [
    {
      cmd: `curl -X POST $API/v1/merchants/${best.merchant.id.slice(0, 12)}…/orders -d '{"lines":[{"item_id":"…","quantity":500}],"fulfilment":{"method":"delivery"}}'`,
      out: `{ "order": { "id": "${placed.body.order.id}", "status": "${placed.body.order.status}", "totalCents": ${placed.body.order.totalCents} } }`,
      hold: 2200,
    },
    { comment: `meanwhile, on ${best.merchant.name}'s till: examples/05-merchant-pos-sync.ts`, hold: 900 },
    { prompt: "pos ›", cmd: "tail -f till.log", out: posLog, color: "#86efac", hold: 6000 },
  ],
  { title: "bash — the order lands on the merchant's own system, signed and verified" },
);

// ---- 4:20 human approval ------------------------------------------------------------------------
const held = await cli(["simulate-purchase", w.cards.procurement, "1840000", "Rand Build Supply", "--mcc", "5211"]);
await wait(600);
const slackText = slackLast() ?? "(no Slack message captured)";
await terminal(
  page,
  [
    { comment: "procurement-bot-03 buys R18 400 of cement. Its card needs a human above R8 000", hold: 1000 },
    { cmd: `acard simulate-purchase ${w.cards.procurement} 1840000 "Rand Build Supply" --mcc 5211`, out: held, color: "#fde68a", hold: 3200 },
  ],
  { title: "bash — over the threshold, so it's held for a person" },
);
await slide(
  page,
  `<div style="max-width:900px;padding:0 70px;width:100%">
    <div class="in" style="font:600 13px ui-monospace,Menlo,monospace;color:#7d8fa6;margin-bottom:12px">posted to Slack by A-CARD's notifier: the actual message text, as Slack displays it</div>
    <div class="in d1" style="background:#1a1d21;border:1px solid #2b2f36;border-radius:12px;padding:20px 24px;display:flex;gap:16px">
      <div style="width:42px;height:42px;border-radius:9px;background:#22c55e;display:flex;align-items:center;justify-content:center;font-weight:800;color:#04120a;flex:none">A</div>
      <div style="flex:1"><div style="font-weight:700;margin-bottom:6px">A-CARD <span style="font-weight:400;color:#8b949e;font-size:13px">APP</span></div>
      <div style="white-space:pre-wrap;line-height:1.6;color:#d1d5db;font-size:17px">${slackText
        .replace(/<([^|>]+)\|([^>]+)>/g, "\u0001$2\u0002") // Slack link markup → its label
        .replace(/[<>]/g, (c) => (c === "<" ? "&lt;" : "&gt;"))
        .replace(/\u0001([^\u0002]+)\u0002/g, '<span style="color:#60a5fa;text-decoration:underline">$1</span>')
        .replace(/:bank:/g, "🏦")
        .replace(/\*([^*]+)\*/g, "<b>$1</b>")
        .replace(/`([^`]+)`/g, "<code>$1</code>")}</div></div>
    </div>
  </div>`,
  7500,
);
await resume(page);
await ui.nav("Approvals");
await ui.say("The approval queue. A human sees the agent, the merchant, the amount, and why it was held.", 4600);
await ui.clear();
await ui.click(page.locator(".btn-approve").first(), { post: 1400 });
await ui.say("Approving doesn't hand over the keys. It mints a <b>single-use grant</b> for this card and merchant, up to this amount.", 5600);
await ui.clear();
const retried = await cli(["simulate-purchase", w.cards.procurement, "1840000", "Rand Build Supply", "--mcc", "5211"]);
const again = await cli(["simulate-purchase", w.cards.procurement, "1840000", "Rand Build Supply", "--mcc", "5211"]);
await terminal(
  page,
  [
    { comment: "the agent retries the same charge, once", hold: 800 },
    { cmd: `acard simulate-purchase ${w.cards.procurement} 1840000 "Rand Build Supply" --mcc 5211`, out: retried, color: "#86efac", hold: 2400 },
    { comment: "and tries it a second time…", hold: 800 },
    { cmd: `acard simulate-purchase ${w.cards.procurement} 1840000 "Rand Build Supply" --mcc 5211`, out: again, color: "#fde68a", hold: 3000 },
    { comment: "the grant was spent. One approval, one purchase.", hold: 2600 },
  ],
  { title: "bash — the approval is consumed by exactly one charge" },
);

// ---- 5:05 audit ---------------------------------------------------------------------------------------
await resume(page);
await ui.nav("Audit log");
await ui.say("Every authorization: approved, declined or held, with the exact reason it went that way.", 5200);
await ui.say("When finance asks why an agent spent R40 000 in March, the answer is one query.", 4600);
await ui.nav("Home");
await ui.spotlight(page.locator(".panel", { hasText: "Spend by department" }).first(), 1200).catch(() => {});
await ui.say("And procurement-bot-03's R18 400 already counts against Procurement's monthly budget, live.", 5600);
await ui.clear();

// ---- 5:20 close -----------------------------------------------------------------------------------------
await slide(
  page,
  `<div style="max-width:980px;padding:0 70px">
    <div class="in" style="font:700 12px ${"ui-sans-serif,system-ui,sans-serif"};letter-spacing:2px;text-transform:uppercase;color:#facc15;margin-bottom:18px">Next: AFP</div>
    <h2 class="in d1" style="font-size:40px;line-height:1.15;margin:0 0 18px;letter-spacing:-.8px">One intent in. The right rail out.</h2>
    <p class="in d2" style="font-size:21px;line-height:1.6;color:#9fb2c8;margin:0">Card rails today. x402 and stablecoin rails are built and switch on as each is contracted and tested; bank and EFT rails come next. Each payment is routed by cost, speed and finality, and when a rail goes quiet, AFP never guesses where your money is.</p>
  </div>`,
  9500,
);
await slide(
  page,
  `<div style="text-align:center;padding:0 60px">
    <h1 class="in" style="font-size:56px;margin:0 0 14px;letter-spacing:-1.4px;font-weight:800">The agents are already here.</h1>
    <h1 class="in d1" style="font-size:56px;margin:0 0 30px;letter-spacing:-1.4px;font-weight:800;color:#4ade80">Give them a budget.</h1>
    <p class="in d3" style="font-size:20px;color:#9fb2c8;margin:0 0 40px">A-CARD · A-MERCHANT · AFP</p>
    <p class="in d5" style="font-size:14px;color:#6b7f95;margin:0">Sandbox shown. Live card issuance launches with our issuing partner.</p>
  </div>`,
  8000,
);

console.log("VIDEO:", await finish(browser, ctx, page));
