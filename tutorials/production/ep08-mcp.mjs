import { studio, make, titleCard, endCard, terminal, finish, seed, api, login } from "./lib.mjs";

const { browser, ctx, page } = await studio("ep08");
const ui = make(page);

await titleCard(page, {
  kicker: "Episode 8 of 9",
  title: "Connecting a real AI agent",
  sub: "One MCP command and your agent has card tools — with exactly the same guardrails as every other client. Plus an honest look at what agents still can't do.",
  hold: 7000,
});

const acct = await seed({ email: `ep8${Date.now()}@kasifoods.co.za`, name: "Kasi Foods" });
await api("/v1/wallet/fund", acct.session_token, { method: "POST", body: JSON.stringify({ amount: 200000 }) });

await login(page, ui, acct.email, acct.password);
await ui.badge("Connect");
await ui.click('.nav-item:has-text("Connect agents")');
await ui.say("The dashboard hands you the exact command for your client — Claude, Codex, Cursor, or a raw config.");
await ui.clear();
await ui.say("One line. After that, the agent has <b>card tools</b> in its toolbox.");
await ui.clear();

await terminal(page, [
  {
    cmd: `claude mcp add --transport http acard \\\n  http://localhost:8787/mcp \\\n  --header "Authorization: Bearer ak_live_…"`,
    out: "Added HTTP MCP server acard → http://localhost:8787/mcp",
    hold: 2600,
  },
], { title: "bash — connecting an agent" });

// --- the tools ---------------------------------------------------------------
await page.setContent(`<!doctype html><meta charset="utf-8"><body style="margin:0;height:100vh;
  background:#05080d;color:#eef4fb;display:flex;align-items:center;justify-content:center;
  font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif">
  <div style="max-width:1000px;padding:0 60px;width:100%">
    <h2 style="font-size:31px;margin:0 0 12px;letter-spacing:-.8px">What the agent can now do</h2>
    <p style="font-size:17px;color:#8fa3b8;margin:0 0 28px">
      Seven tools, defined in <code style="color:#a7f3d0">apps/mcp/src/server.ts</code>.</p>
    <table style="width:100%;border-collapse:collapse;font-size:16.5px">
      ${[
        ["create_card", "Issue a card with limits, MCC allow-list, and an approval threshold."],
        ["get_card / list_cards", "Inspect its own cards — status, limits, spend to date."],
        ["pay_checkout", "Charge a card at a merchant. Returns an approval_id if a human is needed."],
        ["close_card", "Permanently close a card. Closed cards decline everything."],
        ["list_transactions", "Read back its own spend history."],
        ["get_wallet", "Check the balance before trying to spend it."],
      ].map(([a, b]) => `<tr>
        <td style="padding:13px 22px 13px 0;color:#4ade80;font:600 15px ui-monospace,Menlo,monospace;
          vertical-align:top;border-bottom:1px solid #17202c;white-space:nowrap">${a}</td>
        <td style="padding:13px 0;color:#b3c3d4;line-height:1.55;border-bottom:1px solid #17202c">${b}</td></tr>`).join("")}
    </table>
  </div></body>`);
await page.waitForTimeout(18000);

// --- no special agent mode -----------------------------------------------------
await page.setContent(`<!doctype html><meta charset="utf-8"><body style="margin:0;height:100vh;
  background:#05080d;color:#eef4fb;display:flex;align-items:center;justify-content:center;
  font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif">
  <div style="max-width:940px;padding:0 60px">
    <h2 style="font-size:31px;margin:0 0 26px;letter-spacing:-.8px">There is no "agent mode"</h2>
    <p style="font-size:21px;line-height:1.7;color:#c3d2e2;margin:0 0 22px">
      Every MCP tool is a thin call into the <b style="color:#4ade80">same REST API</b> the dashboard uses.
      Same authentication, same roles, same rules engine, same ledger.</p>
    <p style="font-size:21px;line-height:1.7;color:#c3d2e2;margin:0">
      An agent gets <b>no privileged path</b> and no relaxed limits. If a purchase would be refused
      for you, it's refused for the agent.</p>
  </div></body>`);
await page.waitForTimeout(13500);

// --- the honest gap ---------------------------------------------------------------
await page.setContent(`<!doctype html><meta charset="utf-8"><body style="margin:0;height:100vh;
  background:#05080d;color:#eef4fb;display:flex;align-items:center;justify-content:center;
  font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif">
  <div style="max-width:960px;padding:0 60px">
    <h2 style="font-size:31px;margin:0 0 22px;letter-spacing:-.8px">
      <span style="color:#facc15">⚠</span> Being straight about a limitation</h2>
    <p style="font-size:20px;line-height:1.68;color:#c3d2e2;margin:0 0 20px">
      In the sandbox, <code style="color:#a7f3d0;background:rgba(255,255,255,.09);padding:3px 8px;
      border-radius:5px">pay_checkout</code> calls the <b>purchase simulator</b> — it plays the role of the
      issuer's authorization callback. It does not open a real merchant's checkout page.</p>
    <p style="font-size:20px;line-height:1.68;color:#c3d2e2;margin:0 0 20px">
      A-CARD is the <b style="color:#4ade80">control plane</b>: it decides whether a charge is allowed,
      however that card was presented. Getting real card credentials in front of a real merchant is a
      separate problem — browser automation, a per-merchant API integration, or an emerging
      agent-payment protocol.</p>
    <p style="font-size:20px;line-height:1.68;color:#c3d2e2;margin:0">
      That layer is <b>not built here</b>, and a contracted card issuer is still required before any of
      this touches real money.</p>
  </div></body>`);
await page.waitForTimeout(19000);

await endCard(page, {
  title: "Ready for agents, honestly scoped",
  lines: [
    "One command connects any MCP-capable agent",
    "Seven tools, all riding the same guardrails as every other client",
    "Scoped API keys mean a reporting agent can be made <b>physically unable</b> to spend",
    "Real merchant checkout and a live card issuer remain open work",
    "<b>Next:</b> deploying the whole thing to AWS",
  ],
  hold: 7500,
});

console.log("VIDEO:", await finish(browser, ctx, page, "ep08"));
