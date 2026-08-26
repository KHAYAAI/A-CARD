import { studio, make, titleCard, endCard, seed, login, finish, api } from "./lib.mjs";

const { browser, ctx, page } = await studio("ep01");
const ui = make(page);

await titleCard(page, {
  kicker: "Episode 1 of 9",
  title: "What A-CARD actually is",
  sub: "Virtual cards for AI agents — scoped, budget-capped, and refused in real time when an agent goes outside its rules. Built ZAR-first for South Africa.",
  hold: 6000,
});

// --- the problem ------------------------------------------------------------
await page.setContent(`<!doctype html><meta charset="utf-8"><body style="margin:0;height:100vh;
  background:#05080d;color:#eef4fb;display:flex;align-items:center;justify-content:center;
  font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif">
  <div style="max-width:960px;padding:0 60px">
    <h2 style="font-size:35px;margin:0 0 34px;letter-spacing:-.8px">The problem</h2>
    <p style="font-size:23px;line-height:1.65;color:#c3d2e2;margin:0 0 26px">
      You want an AI agent to buy things for you. So you give it a card number.</p>
    <p style="font-size:23px;line-height:1.65;color:#c3d2e2;margin:0 0 26px">
      Now that agent can spend <b style="color:#f87171">your entire credit limit</b>,
      at <b style="color:#f87171">any merchant</b>, <b style="color:#f87171">any number of times</b>.</p>
    <p style="font-size:23px;line-height:1.65;color:#4ade80;margin:0">
      A hallucination, a prompt injection, or a retry loop is now a financial incident.</p>
  </div></body>`);
await page.waitForTimeout(9500);

// --- the shape of the answer ------------------------------------------------
await page.setContent(`<!doctype html><meta charset="utf-8"><body style="margin:0;height:100vh;
  background:#05080d;color:#eef4fb;display:flex;align-items:center;justify-content:center;
  font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif">
  <div style="max-width:1000px;padding:0 60px;width:100%">
    <h2 style="font-size:35px;margin:0 0 40px;letter-spacing:-.8px">A-CARD's answer</h2>
    <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:20px">
      ${[
        ["Prepaid wallet", "The agent spends from a balance you topped up — never from your credit line. It can only lose what you put in."],
        ["Per-card rules", "Total budget, per-transaction cap, merchant-category allow-list, velocity limits, single-use."],
        ["Real-time refusal", "Every charge is decided in the card network's ~2-second window. Outside the rules = declined at the network, not refunded later."],
        ["Human-in-the-loop", "Above a threshold you set, the charge is held and routed to a person before any money moves."],
      ].map(([h, p]) => `<div style="background:#0c131c;border:1px solid #1d2836;border-radius:14px;padding:26px 28px">
        <div style="color:#4ade80;font-size:19px;font-weight:700;margin-bottom:11px">${h}</div>
        <div style="color:#a9bacd;font-size:16.5px;line-height:1.6">${p}</div></div>`).join("")}
    </div>
  </div></body>`);
await page.waitForTimeout(15000);

// --- architecture -----------------------------------------------------------
await page.setContent(`<!doctype html><meta charset="utf-8"><body style="margin:0;height:100vh;
  background:#05080d;color:#eef4fb;display:flex;align-items:center;justify-content:center;
  font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif">
  <div style="max-width:1000px;padding:0 60px;width:100%">
    <h2 style="font-size:33px;margin:0 0 30px;letter-spacing:-.8px">How it's built</h2>
    <table style="width:100%;border-collapse:collapse;font-size:17px">
      ${[
        ["packages/core", "Pure domain logic — double-entry ledger, card lifecycle, rules engine, approvals, RBAC. No I/O, fully unit-tested."],
        ["apps/api", "Hono REST API. Two interchangeable backends: in-memory sandbox, or Postgres with per-wallet row locks for multi-instance safety."],
        ["apps/mcp", "MCP server — how an AI agent actually talks to the platform. A thin adapter over the same REST API."],
        ["apps/dashboard", "Next.js console for the humans: wallet, cards, approvals, team."],
        ["infra/cdk", "AWS: VPC, Multi-AZ Postgres, ALB + WAF, three Fargate services, CloudTrail, GuardDuty."],
      ].map(([a, b]) => `<tr>
        <td style="padding:15px 20px 15px 0;color:#4ade80;font:600 16px ui-monospace,Menlo,monospace;
          white-space:nowrap;vertical-align:top;border-bottom:1px solid #17202c">${a}</td>
        <td style="padding:15px 0;color:#b3c3d4;line-height:1.6;border-bottom:1px solid #17202c">${b}</td></tr>`).join("")}
    </table>
  </div></body>`);
await page.waitForTimeout(17000);

// --- the real product -------------------------------------------------------
const acct = await seed({ email: `tour${Date.now()}@kasifoods.co.za`, name: "Kasi Foods" });
await api("/v1/wallet/fund", acct.session_token, { method: "POST", body: JSON.stringify({ amount: 420000 }) });
await api("/v1/cards", acct.session_token, {
  method: "POST",
  body: JSON.stringify({ label: "Grocery agent", single_use: false, limits: { total: 50000, per_transaction: 25000 }, allowed_merchant_categories: ["5411"] }),
});
await api("/v1/cards", acct.session_token, {
  method: "POST",
  body: JSON.stringify({ label: "Infra agent", single_use: false, limits: { total: 120000 } }),
});

await login(page, ui, acct.email, acct.password);
await ui.badge("Live product");
await ui.say("This is the <b>real dashboard</b>, running against a real API — not a mockup.");
await ui.clear();

await ui.say("Home gives you the three numbers that matter: <b>balance</b>, <b>active cards</b>, and your <b>plan</b>.");
await ui.spotlight(".card-row, .stats, main", 2600).catch(() => {});
await ui.clear();

await ui.click('.nav-item:has-text("Manage cards")');
await ui.say("Each card is an <b>agent's spending identity</b> — its own budget, its own merchant rules, its own limits.");
await ui.clear();

await ui.click('.nav-item:has-text("Wallet")');
await ui.say("One prepaid wallet <b>per currency</b>. ZAR and USD sit side by side, fully independent — a USD card can never touch the ZAR balance.");
await ui.clear();

await ui.click('.nav-item:has-text("Approvals")');
await ui.say("Anything above a card's threshold lands here first. <b>The money hasn't moved yet</b> — it's waiting on a person.");
await ui.clear();

await ui.click('.nav-item:has-text("Connect agents")');
await ui.say("And this is how an AI agent connects — one <code>MCP</code> command, then the agent has card tools.");
await ui.clear();

await endCard(page, {
  title: "What's next",
  lines: [
    "<b>Episode 2</b> — Setup: clone, install, test, and run it locally",
    "<b>Episode 3</b> — Fund a wallet and create your first card",
    "<b>Episode 4</b> — The authorization engine: why charges get refused",
    "<b>Episode 5</b> — Human-in-the-loop approvals, end to end",
  ],
  hold: 7000,
});

console.log("VIDEO:", await finish(browser, ctx, page, "ep01"));
