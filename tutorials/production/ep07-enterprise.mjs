import { studio, make, titleCard, endCard, finish, seed, api, login, resume, API } from "./lib.mjs";

const { browser, ctx, page } = await studio("ep07");
const ui = make(page);

await titleCard(page, {
  kicker: "Episode 7 of 9",
  title: "Enterprise: departments, policy, audit",
  sub: "One shared budget across many agents, rules the org can enforce over every card, and a record of why each decision went the way it did.",
  hold: 6800,
});

await page.setContent(`<!doctype html><meta charset="utf-8"><body style="margin:0;height:100vh;
  background:#05080d;color:#eef4fb;display:flex;align-items:center;justify-content:center;
  font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif">
  <div style="max-width:960px;padding:0 60px">
    <h2 style="font-size:32px;margin:0 0 26px;letter-spacing:-.8px">What changes at enterprise</h2>
    <p style="font-size:21px;line-height:1.7;color:#c3d2e2;margin:0 0 22px">
      Personal accounts are flat: a wallet, some cards, each card's own rules.</p>
    <p style="font-size:21px;line-height:1.7;color:#c3d2e2;margin:0 0 22px">
      Enterprise adds a layer <b style="color:#4ade80">above the cards</b> — controls that apply to
      every card in the org, whether or not the card asked for them.</p>
    <p style="font-size:21px;line-height:1.7;color:#c3d2e2;margin:0">
      A well-configured card cannot opt out of an org-wide block.</p>
  </div></body>`);
await page.waitForTimeout(13500);

// --- seed a realistic org ------------------------------------------------------
const acct = await seed({
  email: `ep7${Date.now()}@ubuntuconstruction.co.za`,
  name: "Ubuntu Construction",
  accountType: "enterprise",
});
const T = acct.session_token;
await api("/v1/wallet/fund", T, { method: "POST", body: JSON.stringify({ amount: 5000000 }) });

const proc = await api("/v1/departments", T, {
  method: "POST",
  body: JSON.stringify({ name: "Procurement", monthly_budget: 1500000, lead: "Naledi M." }),
});
const logi = await api("/v1/departments", T, {
  method: "POST",
  body: JSON.stringify({ name: "Logistics", monthly_budget: 600000, lead: "Sipho D." }),
});
const deptId = (d) => d.department?.id ?? d.id;

const c1 = await api("/v1/cards", T, {
  method: "POST",
  body: JSON.stringify({ label: "Materials agent", single_use: false, department_id: deptId(proc) }),
});
const c2 = await api("/v1/cards", T, {
  method: "POST",
  body: JSON.stringify({ label: "Fuel agent", single_use: false, department_id: deptId(logi) }),
});

for (const [card, amount, name, category] of [
  [c1.card.id, 240000, "Builders Warehouse", "5211"],
  [c1.card.id, 185000, "Cashbuild", "5211"],
  [c2.card.id, 92000, "Engen", "5541"],
  [c2.card.id, 61000, "Shell", "5541"],
]) {
  await fetch(`${API}/v1/simulate/purchase`, {
    method: "POST",
    headers: { authorization: `Bearer ${T}`, "content-type": "application/json" },
    body: JSON.stringify({ card_id: card, amount, currency: "ZAR", merchant: { name, category } }),
  });
}

await login(page, ui, acct.email, acct.password);

// --- departments ---------------------------------------------------------------
await ui.badge("Departments");
await ui.click('.nav-item:has-text("Departments")');
await ui.say("Two departments, each with a <b>monthly budget</b> shared by every agent inside it.");
await ui.clear();

await ui.say("Procurement has R15,000 a month. Its agents draw from that <b>same pool</b> — not one budget each.");
await ui.clear();

await ui.say("So a materials agent over-ordering doesn't just hit its own cap — it eats into what fuel procurement has left.");
await ui.clear();

// --- policy ---------------------------------------------------------------------
await ui.badge("Org policy");
await ui.click('.nav-item:has-text("Policies")');
await ui.say("Org policy sits <b>above every card</b>. Two controls, both absolute.");
await ui.clear();

await ui.type('input[placeholder="7995, 6051"]', "7995, 6051, 5816", { delay: 66 });
await ui.say("Blocked categories: gambling, crypto, games. Refused org-wide — <b>even for a card that explicitly allows them</b>.");
await ui.clear();

await ui.type('input[placeholder="10000000"]', "500000", { delay: 62 });
await ui.say("And an org approval threshold of R5,000 — a human signs off, regardless of what the card permits.");
await ui.clear();
await ui.click('button:has-text("Save policy")');
await page.waitForTimeout(1700);

// --- decision order -------------------------------------------------------------
await page.setContent(`<!doctype html><meta charset="utf-8"><body style="margin:0;height:100vh;
  background:#05080d;color:#eef4fb;display:flex;align-items:center;justify-content:center;
  font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif">
  <div style="max-width:1000px;padding:0 60px;width:100%">
    <h2 style="font-size:31px;margin:0 0 14px;letter-spacing:-.8px">The order a charge is judged in</h2>
    <p style="font-size:17px;color:#8fa3b8;margin:0 0 28px">
      This is the real sequence in <code style="color:#a7f3d0">Platform.authorize</code> — any one of them can stop the charge.</p>
    ${[
      ["1", "Org blocked category", "Checked first, before the card is even consulted. A blocked MCC dies here."],
      ["2", "The card's own rules", "Budget, per-transaction cap, its MCC allow-list, velocity."],
      ["3", "Org approval threshold", "Routes to a human even when the card itself set no threshold."],
      ["4", "Department budget", "The shared monthly pool. Exhausted means every card in that department declines."],
    ].map(([n, h, b]) => `<div style="display:flex;gap:20px;margin-bottom:16px;align-items:flex-start">
      <div style="flex:none;width:34px;height:34px;border-radius:50%;background:#22c55e;color:#04120a;
        display:flex;align-items:center;justify-content:center;font-weight:800;font-size:16px">${n}</div>
      <div><div style="font-size:18px;font-weight:700;margin-bottom:4px">${h}</div>
        <div style="color:#9db0c6;font-size:16.5px;line-height:1.55">${b}</div></div></div>`).join("")}
  </div></body>`);
await page.waitForTimeout(19000);

// --- audit -----------------------------------------------------------------------
await resume(page); // the slide above replaced the SPA; come back to the dashboard
await ui.badge("Audit");
await ui.click('.nav-item:has-text("Audit log")');
await ui.say("Every authorization — approved, declined, or held — with the <b>reason</b> and which layer decided it.");
await ui.clear();

await ui.say("This is what finance and compliance actually need: not just outcomes, but <b>why</b>.");
await ui.clear();

await ui.click('.nav-item:has-text("Home")');
await ui.say("And spend rolls up <b>by department</b>, so budget conversations happen against real numbers.");
await ui.clear();

await endCard(page, {
  title: "Personal vs enterprise, in one line",
  lines: [
    "<b>Personal:</b> wallet → card rules → approve or decline",
    "<b>Enterprise:</b> wallet → org policy → card rules → org threshold → department budget",
    "Departments turn a budget from a per-card number into a <b>shared, collectively enforced pool</b>",
    "The org can constrain any card without editing that card",
    "<b>Next:</b> connecting a real AI agent over MCP",
  ],
  hold: 8000,
});

console.log("VIDEO:", await finish(browser, ctx, page, "ep07"));
