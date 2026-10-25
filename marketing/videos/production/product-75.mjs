import { studio, make, slide, terminal, signedIn, finish, wait, FORMATS } from "./mlib.mjs";
import { cli, mcp, rest, closeMcp, world, zar, pretty } from "./real.mjs";

/** The 75-second product video for the homepage and social. Real commands, real UI, fast cuts. */

const w = world();
// Do the real work first; the cut then plays it back at pace.
const created = await mcp("create_card", {
  label: "fleet-agent-12",
  single_use: false,
  per_transaction_limit: 500_000,
  total_limit: 4_000_000,
  allowed_merchant_categories: ["5541", "5542"],
});
const fuel = await rest("POST", "/v1/simulate/purchase", { card_id: created.id, amount: 185_000, merchant: { name: "Highveld Tyre & Fuel", category: "5541" } });
const tv = await cli(["simulate-purchase", created.id, "90000", "Game Electronics", "--mcc", "5732"]);
const search = await mcp("find_offers", { query: "cement", quantity: 500, lat: -26.2309, lng: 28.1772, radius_km: 60, max_lead_time_days: 1 });
await closeMcp();
const held = await cli(["simulate-purchase", w.cards.procurement, "1840000", "Rand Build Supply", "--mcc", "5211"]);

const { browser, ctx, page } = await studio("product-75", FORMATS.wide);
const ui = make(page);
const big = (html, sub = "") =>
  `<div style="max-width:1000px;padding:0 70px"><h1 class="in" style="font-size:54px;line-height:1.1;margin:0;letter-spacing:-1.4px;font-weight:800">${html}</h1>${sub ? `<p class="in d2" style="font-size:22px;color:#9fb2c8;margin:20px 0 0">${sub}</p>` : ""}</div>`;

// 0:00
await slide(page, big(`Your agents can buy.<br><span style="color:#4ade80">Can they be trusted to pay?</span>`), 5200);

// 0:05 one card per agent
await slide(page, big("Give each agent its own card…", "scoped to one job, issued in one tool call"), 3000);
await terminal(
  page,
  [{ prompt: "mcp ›", cmd: `create_card {"label":"fleet-agent-12","per_transaction_limit":500000,"total_limit":4000000,"allowed_merchant_categories":["5541","5542"]}`, out: pretty({ id: created.id, status: created.status, limits: created.limits, allowedMerchantCategories: created.allowedMerchantCategories }), hold: 2600 }],
  { title: "MCP client → acard", typeMs: 6 },
);

// 0:16 checked on every charge
await slide(
  page,
  `<div style="width:100%;max-width:980px;padding:0 70px">
    <h2 class="in" style="font-size:38px;margin:0 0 20px;letter-spacing:-.8px">…checked on every charge, before any money is held.</h2>
    <div style="font:17px/1.95 ui-monospace,Menlo,monospace;background:#0a1017;border:1px solid #1d2836;border-radius:13px;padding:16px 26px">
    ${["org policy", "card status", "currency", "merchant category", "per-transaction cap", "card total", "approval threshold", "atomic ledger hold"]
      .map((k, i) => `<div class="in" style="animation-delay:${0.1 + i * 0.16}s;display:flex;justify-content:space-between"><span style="color:#b3c3d4">${k}</span><span style="color:#4ade80">✓</span></div>`)
      .join("")}
    <div class="in" style="animation-delay:1.5s;border-top:1px dashed #2a3d45;margin-top:8px;padding-top:8px;display:flex;justify-content:space-between;color:#facc15;font-weight:700"><span>APPROVED · R1 850 diesel</span><span>${fuel.ms} ms</span></div>
    </div></div>`,
  7800,
);

// 0:24 wrong store
await terminal(
  page,
  [{ cmd: `acard simulate-purchase ${created.id} 90000 "Game Electronics" --mcc 5732`, out: tv, color: "#fca5a5", hold: 2600 }],
  { title: "Wrong store? Declined, with a reason.", typeMs: 8 },
);

// 0:31 a human decides
await terminal(
  page,
  [{ cmd: `acard simulate-purchase ${w.cards.procurement} 1840000 "Rand Build Supply" --mcc 5211`, out: held, color: "#fde68a", hold: 2200 }],
  { title: "Big purchase? A person decides.", typeMs: 8 },
);
await signedIn(page, w.session);
await ui.nav("Approvals");
await ui.say("One approval mints one single-use grant. One approval, one purchase.", 2600);
await ui.click(page.locator(".btn-approve").first(), { post: 1300 });
await ui.clear();

// 0:44 real supply
await terminal(
  page,
  [
    {
      prompt: "mcp ›",
      cmd: `find_offers {"query":"cement","quantity":500,"max_lead_time_days":1}`,
      out:
        search.offers.map((o) => `${o.merchant.name.padEnd(22)} ${zar(o.totalCents).padStart(14)}  ${o.freshness}  score ${o.score.toFixed(3)}`).join("\n") +
        "\n" +
        search.excluded.map((e) => `✗ ${e.reason}`).join("\n"),
      hold: 4200,
    },
  ],
  { title: "A-MERCHANT: verified supply, live stock, no paid placement", typeMs: 6 },
);

// 0:54 the ledger
await signedIn(page, w.session);
await ui.nav("Audit log");
await ui.say("Every rand and every dollar, on one ledger. Every decision, with its reason.", 4200);
await ui.clear();

// 1:03
await slide(
  page,
  `<div style="text-align:center;padding:0 60px">
    <div class="in" style="font:800 24px ui-sans-serif,system-ui,sans-serif;letter-spacing:1px;margin-bottom:22px">A‑CARD</div>
    <h1 class="in d1" style="font-size:58px;margin:0 0 34px;letter-spacing:-1.4px;font-weight:800">Give your agents a budget.</h1>
    <p class="in d4" style="font-size:14px;color:#6b7f95;margin:0">Sandbox shown. Live card issuance launches with our issuing partner.</p>
  </div>`,
  7500,
);
await wait(300);
console.log("VIDEO:", await finish(browser, ctx, page));
