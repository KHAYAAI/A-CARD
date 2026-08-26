import { readFileSync } from "node:fs";
import { studio, make, titleCard, endCard, terminal, finish, seed, api, login, API } from "./lib.mjs";

const { scenes } = JSON.parse(readFileSync(new URL("./scenes.json", import.meta.url)));
const { browser, ctx, page } = await studio("ep05");
const ui = make(page);

await titleCard(page, {
  kicker: "Episode 5 of 9",
  title: "Human-in-the-loop approvals",
  sub: "The charge that isn't wrong — it's just big. How A-CARD holds it, routes it to a person, and lets exactly one retry through.",
  hold: 6500,
});

await page.setContent(`<!doctype html><meta charset="utf-8"><body style="margin:0;height:100vh;
  background:#05080d;color:#eef4fb;display:flex;align-items:center;justify-content:center;
  font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif">
  <div style="max-width:940px;padding:0 60px">
    <h2 style="font-size:32px;margin:0 0 26px;letter-spacing:-.8px">The problem with a hard limit</h2>
    <p style="font-size:21px;line-height:1.7;color:#c3d2e2;margin:0 0 22px">
      Set the cap too low and your agent is useless. Set it too high and one bad decision is expensive.</p>
    <p style="font-size:21px;line-height:1.7;color:#c3d2e2;margin:0">
      <code style="color:#a7f3d0;background:rgba(255,255,255,.09);padding:3px 8px;border-radius:5px">approval_threshold</code>
      is the third option: below it the agent is autonomous, above it
      <b style="color:#4ade80">a human decides</b> — before any money moves.</p>
  </div></body>`);
await page.waitForTimeout(12500);

// --- the API side --------------------------------------------------------------
await terminal(page, scenes.approve, { title: "bash — hold, approve, retry" });

await page.setContent(`<!doctype html><meta charset="utf-8"><body style="margin:0;height:100vh;
  background:#05080d;color:#eef4fb;display:flex;align-items:center;justify-content:center;
  font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif">
  <div style="max-width:980px;padding:0 60px;width:100%">
    <h2 style="font-size:31px;margin:0 0 28px;letter-spacing:-.8px">Follow the money</h2>
    <div style="font:16px/2.15 ui-monospace,Menlo,monospace;background:#0a1017;border:1px solid #1d2836;
      border-radius:13px;padding:26px 32px;color:#b3c3d4">
      Funded<span style="float:right;color:#eef4fb">R1,000.00</span><br>
      <span style="color:#4ade80">Approved</span> — Checkers, R80<span style="float:right;color:#f87171">− R80.00</span><br>
      <span style="color:#f87171">Declined</span> — Steam, wrong category<span style="float:right;color:#5f7488">R0.00</span><br>
      <span style="color:#f87171">Declined</span> — R300, over per-charge cap<span style="float:right;color:#5f7488">R0.00</span><br>
      <span style="color:#facc15">Held</span> — Makro, R220, awaiting a human<span style="float:right;color:#5f7488">R0.00</span><br>
      <span style="color:#4ade80">Approved by a human</span>, retried<span style="float:right;color:#f87171">− R220.00</span>
      <div style="border-top:1px solid #23303f;margin:14px 0 0;padding-top:14px;color:#eef4fb;font-weight:700">
        Final balance<span style="float:right;color:#4ade80">R700.00</span></div>
    </div>
    <p style="font-size:18px;color:#8fa3b8;margin:24px 0 0;line-height:1.6">
      Three refusals cost exactly nothing. The two approvals are the only movements on the ledger.</p>
  </div></body>`);
await page.waitForTimeout(17000);

// --- the human side, in the real dashboard --------------------------------------
const acct = await seed({ email: `ep5${Date.now()}@kasifoods.co.za`, name: "Kasi Foods" });
const T = acct.session_token;
await api("/v1/wallet/fund", T, { method: "POST", body: JSON.stringify({ amount: 300000 }) });
const { card } = await api("/v1/cards", T, {
  method: "POST",
  body: JSON.stringify({ label: "Procurement agent", single_use: false, approval_threshold: 20000 }),
});
for (const [amount, name] of [[45000, "Makro"], [28000, "Builders Warehouse"], [92000, "Game Stores"]]) {
  await fetch(`${API}/v1/simulate/purchase`, {
    method: "POST",
    headers: { authorization: `Bearer ${T}`, "content-type": "application/json" },
    body: JSON.stringify({ card_id: card.id, amount, currency: "ZAR", merchant: { name, category: "5411" } }),
  });
}

await login(page, ui, acct.email, acct.password);
await ui.badge("The queue");
await ui.click('.nav-item:has-text("Approvals")');
await ui.say("Three charges are waiting. Each one is <b>held, not failed</b> — the agent got a decline and can retry once approved.");
await ui.clear();

await ui.say("You see <b>what</b>, <b>where</b>, and <b>how much</b> — enough to decide without opening a ticket.");
await ui.clear();

await ui.badge("Approve");
await ui.click('.btn-approve');
await page.waitForTimeout(1700);
await ui.say("Approving mints a <b>one-time, amount-bounded grant</b> — good for that merchant, that amount, once.");
await ui.clear();

await ui.say("It is <b>not</b> a permanent raise. The next charge over the threshold stops here too.");
await ui.clear();

await ui.badge("Deny");
await ui.click('.btn-deny');
await page.waitForTimeout(1700);
await ui.say("Deny and the hold is released. The agent's retry is refused exactly like the first attempt.");
await ui.clear();

await ui.click('.nav-item:has-text("Track spending")');
await ui.say("Every decision — approved, declined, or held — is recorded with its reason.");
await ui.clear();

await page.setContent(`<!doctype html><meta charset="utf-8"><body style="margin:0;height:100vh;
  background:#05080d;color:#eef4fb;display:flex;align-items:center;justify-content:center;
  font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif">
  <div style="max-width:940px;padding:0 60px">
    <h2 style="font-size:31px;margin:0 0 26px;letter-spacing:-.8px">Why a one-time grant</h2>
    <p style="font-size:21px;line-height:1.7;color:#c3d2e2;margin:0 0 22px">
      The obvious implementation is to bump the card's limit and let the retry through.
      That leaves the card <b style="color:#f87171">permanently more powerful</b> than you intended.</p>
    <p style="font-size:21px;line-height:1.7;color:#c3d2e2;margin:0 0 22px">
      Instead, approval creates a grant bound to <b style="color:#4ade80">that merchant</b> and
      <b style="color:#4ade80">that amount</b>, consumed by the first matching retry.</p>
    <p style="font-size:21px;line-height:1.7;color:#c3d2e2;margin:0">
      You approved <i>one purchase</i> — not a new spending level.</p>
  </div></body>`);
await page.waitForTimeout(15000);

await endCard(page, {
  title: "Autonomy with a brake",
  lines: [
    "Under the threshold, the agent never waits on you",
    "Over it, nothing moves until a person says so",
    "Approval is a <b>single consumable grant</b>, not a permanent limit increase",
    "Optional Slack push means approving takes seconds, not a dashboard visit",
    "<b>Next:</b> teams, roles, and who is allowed to approve at all",
  ],
  hold: 7500,
});

console.log("VIDEO:", await finish(browser, ctx, page, "ep05"));
