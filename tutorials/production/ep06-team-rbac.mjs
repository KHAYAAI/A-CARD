import { studio, make, titleCard, endCard, finish, seed, api, login, resume } from "./lib.mjs";

const { browser, ctx, page } = await studio("ep06");
const ui = make(page);

await titleCard(page, {
  kicker: "Episode 6 of 9",
  title: "Team, roles and access",
  sub: "Four roles, one wallet. Who can create cards, who can approve spend, and who can only look — enforced on the server, not hidden in the UI.",
  hold: 6500,
});

await page.setContent(`<!doctype html><meta charset="utf-8"><body style="margin:0;height:100vh;
  background:#05080d;color:#eef4fb;display:flex;align-items:center;justify-content:center;
  font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif">
  <div style="max-width:1000px;padding:0 60px;width:100%">
    <h2 style="font-size:31px;margin:0 0 12px;letter-spacing:-.8px">The four roles</h2>
    <p style="font-size:17.5px;color:#8fa3b8;margin:0 0 30px">Strictly ranked: owner &gt; admin &gt; member &gt; viewer.</p>
    <table style="width:100%;border-collapse:collapse;font-size:17px">
      ${[
        ["owner", "Everything, including billing and transferring ownership."],
        ["admin", "Manage the team, set org policy, approve spend, start a subscription checkout."],
        ["member", "Fund the wallet, create cards, spend. The day-to-day operating role."],
        ["viewer", "Read-only. Sees wallet, cards and transactions — cannot create, fund, spend, or approve."],
      ].map(([a, b]) => `<tr>
        <td style="padding:16px 22px 16px 0;color:#4ade80;font:600 16px ui-monospace,Menlo,monospace;
          vertical-align:top;border-bottom:1px solid #17202c;width:130px">${a}</td>
        <td style="padding:16px 0;color:#b3c3d4;line-height:1.6;border-bottom:1px solid #17202c">${b}</td></tr>`).join("")}
    </table>
  </div></body>`);
await page.waitForTimeout(15500);

const acct = await seed({ email: `ep6${Date.now()}@kasifoods.co.za`, name: "Kasi Foods" });
const T = acct.session_token;
await api("/v1/wallet/fund", T, { method: "POST", body: JSON.stringify({ amount: 180000 }) });
await api("/v1/cards", T, { method: "POST", body: JSON.stringify({ label: "Grocery agent", single_use: false }) });

await login(page, ui, acct.email, acct.password);
await ui.badge("Team");
await ui.click('.nav-item:has-text("Team")');
await ui.say("You signed up as <b>owner</b>. Everyone else is invited with an explicit role.");
await ui.clear();

const mate = `ops${Date.now()}@kasifoods.co.za`;
await ui.type('input[placeholder="teammate email"]', mate, { delay: 34 });
await ui.type('input[placeholder="starting password"]', "temp-password-123", { delay: 40 });
await ui.say("Pick the role deliberately. <b>Member</b> is the right default for someone running agents day to day.");
await ui.clear();
await ui.click('button.btn-green:has-text("Add")');
await page.waitForTimeout(1900);
await ui.say("Added. They can sign in immediately and are expected to change that starting password.");
await ui.clear();

// --- prove enforcement is server-side -------------------------------------------
await page.setContent(`<!doctype html><meta charset="utf-8"><body style="margin:0;height:100vh;
  background:#05080d;color:#eef4fb;display:flex;align-items:center;justify-content:center;
  font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif">
  <div style="max-width:940px;padding:0 60px">
    <h2 style="font-size:31px;margin:0 0 26px;letter-spacing:-.8px">Hiding a button is not security</h2>
    <p style="font-size:21px;line-height:1.7;color:#c3d2e2;margin:0 0 22px">
      A viewer doesn't see the <b>Create card</b> button — but that's a courtesy, not the control.</p>
    <p style="font-size:21px;line-height:1.7;color:#c3d2e2;margin:0">
      Every write route is gated by <code style="color:#a7f3d0;background:rgba(255,255,255,.09);
      padding:3px 8px;border-radius:5px">requireRole</code> on the server. A viewer calling the API
      directly with their own token gets <b style="color:#f87171">403</b> — the UI is irrelevant.</p>
  </div></body>`);
await page.waitForTimeout(13000);

// --- API keys carry roles too ----------------------------------------------------
await resume(page); // the slide above replaced the SPA; come back to the dashboard
await ui.badge("API keys");
await ui.click('.nav-item:has-text("Connect agents")');
await ui.say("The same model covers <b>API keys</b>, which is what your agents actually authenticate with.");
await ui.clear();

await page.setContent(`<!doctype html><meta charset="utf-8"><body style="margin:0;height:100vh;
  background:#05080d;color:#eef4fb;display:flex;align-items:center;justify-content:center;
  font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif">
  <div style="max-width:1000px;padding:0 60px;width:100%">
    <h2 style="font-size:31px;margin:0 0 30px;letter-spacing:-.8px">Two ways to limit a key</h2>
    ${[
      ["scope: read_only", "Maps onto the viewer role. Perfect for a reporting or reconciliation agent that must never spend."],
      ["spendCapCents", "A cumulative ceiling on the <i>card budget</i> that key is allowed to provision. Even a full-access key can't quietly issue R1,000,000 of cards."],
    ].map(([a, b]) => `<div style="background:#0c131c;border:1px solid #1d2836;border-radius:14px;
      padding:24px 28px;margin-bottom:18px">
      <div style="color:#4ade80;font:600 17px ui-monospace,Menlo,monospace;margin-bottom:10px">${a}</div>
      <div style="color:#a9bacd;font-size:17px;line-height:1.6">${b}</div></div>`).join("")}
    <p style="font-size:17.5px;color:#8fa3b8;margin:22px 0 0;line-height:1.6">
      A leaked key is bounded by both — and can be revoked on its own without touching the others.</p>
  </div></body>`);
await page.waitForTimeout(16000);

await page.setContent(`<!doctype html><meta charset="utf-8"><body style="margin:0;height:100vh;
  background:#05080d;color:#eef4fb;display:flex;align-items:center;justify-content:center;
  font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif">
  <div style="max-width:960px;padding:0 60px;width:100%">
    <h2 style="font-size:31px;margin:0 0 30px;letter-spacing:-.8px">Protecting the humans</h2>
    <table style="width:100%;border-collapse:collapse;font-size:17px">
      ${[
        ["TOTP MFA", "Enrolled per user from the dashboard. A wrong code consumes the challenge, so it can't be brute-forced."],
        ["Recovery codes", "Single-use, stored only as hashes. Accepted once, then dead."],
        ["Per-account lockout", "5 failed logins in 15 minutes locks the account — shared across every API instance via Postgres, so rotating IPs doesn't help an attacker."],
        ["WAF rate limit", "A separate, tighter rule scoped to /v1/auth/login at the edge — 20 attempts per IP per 5 minutes."],
        ["WorkOS SSO", "Optional and purely additive. It never replaces password + MFA for accounts that don't use it."],
      ].map(([a, b]) => `<tr>
        <td style="padding:14px 22px 14px 0;color:#4ade80;font:600 15.5px ui-sans-serif,system-ui,sans-serif;
          vertical-align:top;border-bottom:1px solid #17202c;width:210px">${a}</td>
        <td style="padding:14px 0;color:#b3c3d4;line-height:1.6;border-bottom:1px solid #17202c">${b}</td></tr>`).join("")}
    </table>
  </div></body>`);
await page.waitForTimeout(19000);

await endCard(page, {
  title: "Access, controlled at both ends",
  lines: [
    "Four ranked roles, enforced server-side on every write route",
    "API keys carry the same model, plus their own spend ceiling",
    "MFA, lockout, and an edge rate limit protect the human login",
    "<b>Next:</b> enterprise — departments, org policy, and the audit log",
  ],
  hold: 7000,
});

console.log("VIDEO:", await finish(browser, ctx, page, "ep06"));
