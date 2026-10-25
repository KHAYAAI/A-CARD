import { studio, make, slide, terminal, signedIn, finish, wait, FORMATS } from "./mlib.mjs";
import { cli, mcp, closeMcp, world, zar } from "./real.mjs";

/**
 * Three square social clips (1080×1080): approval, blocked purchase, A-MERCHANT
 * search. Run one at a time: `node clips.mjs approval|blocked|search`.
 * Each opens on a hook in the first two seconds and ends on the wordmark.
 */

const which = process.argv[2];
const w = world();

const hook = (text) =>
  `<div style="padding:0 60px;text-align:left"><h1 class="in" style="font-size:52px;line-height:1.12;margin:0;letter-spacing:-1.2px;font-weight:800">${text}</h1></div>`;
const mark = (line) =>
  `<div style="text-align:center;padding:0 50px">
    <div class="in" style="font:800 30px ui-sans-serif,system-ui,sans-serif;letter-spacing:1px;margin-bottom:18px">A‑CARD</div>
    <p class="in d1" style="font-size:24px;color:#9fb2c8;margin:0 0 30px">${line}</p>
    <p class="in d3" style="font-size:13px;color:#6b7f95;margin:0">Sandbox shown. Live issuance launches with our issuing partner.</p></div>`;
const takeaway = (html) => `<div style="padding:0 60px"><h2 class="in" style="font-size:44px;line-height:1.15;margin:0;letter-spacing:-1px;font-weight:800">${html}</h2></div>`;

async function approval() {
  const card = w.cards.procurement;
  const held = await cli(["simulate-purchase", card, "1840000", "Rand Build Supply", "--mcc", "5211"]);
  const { browser, ctx, page } = await studio("clip-approval", FORMATS.square);
  const ui = make(page);
  await slide(page, hook(`My AI agent tried to spend <span style="color:#facc15">R18 400</span>.`), 2300);
  await terminal(page, [{ cmd: `acard simulate-purchase … 1840000 "Rand Build Supply"`, out: held, color: "#fde68a", hold: 2000 }], { title: "procurement-bot-03", typeMs: 6 });
  await signedIn(page, w.session);
  await ui.nav("Approvals");
  await ui.click(page.locator(".btn-approve").first(), { post: 1200 });
  const retried = await cli(["simulate-purchase", card, "1840000", "Rand Build Supply", "--mcc", "5211"]);
  const again = await cli(["simulate-purchase", card, "1840000", "Rand Build Supply", "--mcc", "5211"]);
  await terminal(
    page,
    [
      { comment: "retry once, after approval", hold: 600 },
      { cmd: `acard simulate-purchase … 1840000 "Rand Build Supply"`, out: retried, color: "#86efac", hold: 1800 },
      { comment: "the same charge again", hold: 600 },
      { cmd: `acard simulate-purchase … 1840000 "Rand Build Supply"`, out: again, color: "#fde68a", hold: 2200 },
    ],
    { title: "procurement-bot-03", typeMs: 5 },
  );
  await slide(page, takeaway(`The approval was spent.<br><span style="color:#4ade80">One approval, one purchase.</span>`), 3000);
  await slide(page, mark("Agents can spend. They can't run away with it."), 2800);
  return finish(browser, ctx, page);
}

async function blocked() {
  const card = w.cards.fleet;
  const fuel = await cli(["simulate-purchase", card, "185000", "Highveld Tyre & Fuel", "--mcc", "5541"]);
  const tv = await cli(["simulate-purchase", card, "90000", "Game Electronics", "--mcc", "5732"]);
  const casino = await cli(["simulate-purchase", card, "50000", "Lucky Spin Online", "--mcc", "7995"]);
  const { browser, ctx, page } = await studio("clip-blocked", FORMATS.square);
  await slide(page, hook(`What happens when a <span style="color:#4ade80">fleet agent</span> goes shopping?`), 2600);
  await terminal(
    page,
    [
      { comment: "fuel", hold: 400 },
      { cmd: `acard simulate-purchase … 185000 "Highveld Tyre & Fuel" --mcc 5541`, out: fuel, color: "#86efac", hold: 1400 },
      { comment: "a TV", hold: 400 },
      { cmd: `acard simulate-purchase … 90000 "Game Electronics" --mcc 5732`, out: tv, color: "#fca5a5", hold: 1600 },
      { comment: "a casino", hold: 400 },
      { cmd: `acard simulate-purchase … 50000 "Lucky Spin Online" --mcc 7995`, out: casino, color: "#fca5a5", hold: 2000 },
    ],
    { title: "fleet-agent-07 · fuel card", typeMs: 7 },
  );
  await slide(page, takeaway(`A fuel card can't buy a TV.<br><span style="color:#4ade80">Org policy beats every card.</span>`), 3600);
  await slide(page, mark("Every decline tells the agent exactly why."), 3000);
  return finish(browser, ctx, page);
}

async function search() {
  const result = await mcp("find_offers", { query: "cement", quantity: 500, lat: -26.2309, lng: 28.1772, radius_km: 60, max_lead_time_days: 1 });
  await closeMcp();
  const best = result.offers[0];
  const { browser, ctx, page } = await studio("clip-search", FORMATS.square);
  await slide(page, hook(`Ask an AI for <span style="color:#4ade80">500 bags of cement</span> by tomorrow.`), 2800);
  await terminal(
    page,
    [
      {
        prompt: "mcp ›",
        cmd: `find_offers {"query":"cement","quantity":500,"max_lead_time_days":1}`,
        out:
          result.offers.map((o) => `${o.merchant.name}\n  ${zar(o.totalCents)} · ${o.distanceKm.toFixed(1)} km · lead ${o.leadTimeDays}d\n  stock ${o.freshness}, confirmed ${o.inventoryAgeHours.toFixed(1)}h ago`).join("\n") +
          "\n\nskipped:\n" +
          result.excluded.map((e) => `✗ ${e.reason}`).join("\n"),
        hold: 6500,
      },
    ],
    { title: "A-MERCHANT · find_offers", typeMs: 9 },
  );
  await slide(
    page,
    takeaway(`Verified suppliers.<br>Stock confirmed hours ago.<br><span style="color:#4ade80">Nobody paid to be ranked.</span>`),
    4200,
  );
  await slide(page, mark(`${best.merchant.name} won by having the stock, and saying so.`), 3200);
  return finish(browser, ctx, page);
}

const takes = { approval, blocked, search };
if (!takes[which]) throw new Error("usage: node clips.mjs approval|blocked|search");
console.log("VIDEO:", await takes[which]());
await wait(100);
process.exit(0);
