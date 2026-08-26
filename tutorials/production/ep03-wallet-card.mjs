import { readFileSync } from "node:fs";
import { studio, make, titleCard, endCard, terminal, finish, seed, login, APP } from "./lib.mjs";

const { scenes } = JSON.parse(readFileSync(new URL("./scenes.json", import.meta.url)));
const { browser, ctx, page } = await studio("ep03");
const ui = make(page);

await titleCard(page, {
  kicker: "Episode 3 of 9",
  title: "Your first wallet and card",
  sub: "Sign up, top up a prepaid balance, and issue a card that is physically incapable of spending more than you allow.",
  hold: 6200,
});

// --- sign up in the real UI --------------------------------------------------
const email = `ep3${Date.now()}@kasifoods.co.za`;
await page.goto(APP, { waitUntil: "networkidle" });
await page.waitForTimeout(900);

await ui.badge("Sign up");
await ui.say("Start by creating a workspace. <b>Personal</b> is a wallet and cards for your own agents.");
await ui.click('button:has-text("Create account")');
await ui.clear();

await ui.say("Two workspace types. <b>Enterprise</b> adds departments, budgets, org-wide policy and an audit log — that's Episode 7.");
await ui.clear();

await ui.type('form input >> nth=0', "Kasi Foods", { delay: 62 });
await ui.type('input[type="email"]', email, { delay: 40 });
await ui.type('input[type="password"]', "supersecret123", { delay: 46 });
await ui.say("Passwords are <b>scrypt-hashed</b>. Session tokens and API key secrets are only ever stored as SHA-256 hashes.");
await ui.clear();
await ui.click('button[type="submit"]');
await page.waitForSelector(".nav-item", { timeout: 15000 });
await page.waitForTimeout(1500);

await ui.say("You're in. A workspace, an owner account, and an empty <b>ZAR wallet</b> were all created together.");
await ui.clear();

// --- fund --------------------------------------------------------------------
await ui.badge("Fund");
await ui.click('.nav-item:has-text("Wallet")');
await ui.say("The wallet is <b>prepaid</b>. An agent can only ever spend what's actually sitting here.");
await ui.clear();

await ui.click('button.btn-green:has-text("Add funds")');
await ui.say("Amounts are in <b>minor units</b> — cents. This is deliberate: no floating-point money, anywhere in the system.");
await ui.clear();
await ui.type('.modal input.mono', "250000", { delay: 78 });
await ui.say("250000 cents = <b>R2,500.00</b>. In production this is a settled PayFast pay-in; in the sandbox it credits instantly.");
await ui.clear();
await ui.click('.modal button:has-text("Add funds")');
await page.waitForTimeout(1800);

await ui.say("Credited. That top-up was a <b>balanced double-entry transaction</b> — not a number being incremented.");
await ui.clear();

// --- create a card in the UI --------------------------------------------------
await ui.badge("Issue a card");
await ui.click('.nav-item:has-text("Manage cards")');
await ui.click('button:has-text("Create card")');
await ui.type('.modal input:not(.mono)', "Grocery agent", { delay: 62 });
await ui.say("Name it after the <b>agent that will hold it</b> — that's how you'll read the transaction log later.");
await ui.clear();
await ui.click('.modal button:has-text("Create card")');
await page.waitForTimeout(1900);

await ui.say("Issued. In the sandbox that's a deterministic <code>4242…</code> test PAN — a real issuer would mint a real card here.");
await ui.clear();

// --- the honest bit: real limits come from the API ---------------------------
await page.setContent(`<!doctype html><meta charset="utf-8"><body style="margin:0;height:100vh;
  background:#05080d;color:#eef4fb;display:flex;align-items:center;justify-content:center;
  font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif">
  <div style="max-width:940px;padding:0 60px">
    <h2 style="font-size:32px;margin:0 0 26px;letter-spacing:-.8px">Where the real controls live</h2>
    <p style="font-size:21px;line-height:1.7;color:#c3d2e2;margin:0 0 22px">
      The dashboard's create-card dialog keeps it simple — name and currency.
      The <b style="color:#4ade80">full rule set</b> is set through the API, which is also
      how an agent would create its own cards.</p>
    <p style="font-size:21px;line-height:1.7;color:#c3d2e2;margin:0">
      Let's create the same card properly, with every guardrail switched on.</p>
  </div></body>`);
await page.waitForTimeout(11000);

await terminal(page, scenes.card, { title: "bash — wallet and card over the API" });

// --- explain each limit -------------------------------------------------------
await page.setContent(`<!doctype html><meta charset="utf-8"><body style="margin:0;height:100vh;
  background:#05080d;color:#eef4fb;display:flex;align-items:center;justify-content:center;
  font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif">
  <div style="max-width:1000px;padding:0 60px;width:100%">
    <h2 style="font-size:31px;margin:0 0 30px;letter-spacing:-.8px">Every knob on that card</h2>
    <table style="width:100%;border-collapse:collapse;font-size:17px">
      ${[
        ["total", "R500 lifetime. Once spent, the card is done — regardless of wallet balance."],
        ["per_transaction", "R250 max on any single charge. Caps blast radius on one bad decision."],
        ["allowed_merchant_categories", "MCC <code>5411</code> = grocery stores. Anything else is refused outright."],
        ["approval_threshold", "R200. At or above this, a human decides before money moves."],
        ["single_use", "Set false here. Set true and the card closes itself after one successful capture."],
        ["velocity", "Not set here — caps spend inside a rolling window, e.g. R100 per hour."],
      ].map(([a, b]) => `<tr>
        <td style="padding:14px 22px 14px 0;color:#4ade80;font:600 15px ui-monospace,Menlo,monospace;
          vertical-align:top;border-bottom:1px solid #17202c;white-space:nowrap">${a}</td>
        <td style="padding:14px 0;color:#b3c3d4;line-height:1.6;border-bottom:1px solid #17202c">${b}</td></tr>`).join("")}
    </table>
  </div></body>`);
await page.waitForTimeout(18000);

await endCard(page, {
  title: "One card, five independent guardrails",
  lines: [
    "The wallet caps <b>total exposure</b> — an agent can't spend money that isn't there",
    "<code>total</code> and <code>per_transaction</code> cap the card and each charge",
    "The MCC allow-list decides <b>where</b> it can be used at all",
    "<code>approval_threshold</code> puts a human in front of the big ones",
    "<b>Next:</b> watch the engine enforce every one of these, live",
  ],
  hold: 7200,
});

console.log("VIDEO:", await finish(browser, ctx, page, "ep03"));
