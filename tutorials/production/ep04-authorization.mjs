import { readFileSync } from "node:fs";
import { studio, make, titleCard, endCard, terminal, finish } from "./lib.mjs";

const { scenes } = JSON.parse(readFileSync(new URL("./scenes.json", import.meta.url)));
const { browser, ctx, page } = await studio("ep04");

await titleCard(page, {
  kicker: "Episode 4 of 9",
  title: "The authorization engine",
  sub: "The two seconds that decide everything. Four purchases on one card — one approved, three refused, each for a different reason.",
  hold: 6500,
});

// --- the hot path -------------------------------------------------------------
await page.setContent(`<!doctype html><meta charset="utf-8"><body style="margin:0;height:100vh;
  background:#05080d;color:#eef4fb;display:flex;align-items:center;justify-content:center;
  font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif">
  <div style="max-width:980px;padding:0 60px;width:100%">
    <h2 style="font-size:32px;margin:0 0 18px;letter-spacing:-.8px">What happens at the till</h2>
    <p style="font-size:18.5px;color:#8fa3b8;margin:0 0 34px;line-height:1.6">
      When an agent's card is charged, the card network gives you roughly two seconds to answer.</p>
    <div style="font:15.5px/2.05 ui-monospace,SFMono-Regular,Menlo,monospace;color:#b3c3d4;
      background:#0a1017;border:1px solid #1d2836;border-radius:13px;padding:26px 32px">
      Merchant charges the card<br>
      &nbsp;&nbsp;<span style="color:#3d5266">↓</span><br>
      Issuer calls <span style="color:#4ade80">POST /webhooks/issuer</span> <span style="color:#5f7488">(HMAC-signed)</span><br>
      &nbsp;&nbsp;<span style="color:#3d5266">↓</span><br>
      A-CARD resolves the card <span style="color:#5f7488">— by our id, or the issuer's own reference</span><br>
      &nbsp;&nbsp;<span style="color:#3d5266">↓</span><br>
      <span style="color:#facc15">Org policy</span> → <span style="color:#facc15">card rules</span> → <span style="color:#facc15">approval threshold</span> → <span style="color:#facc15">department budget</span><br>
      &nbsp;&nbsp;<span style="color:#3d5266">↓</span><br>
      <span style="color:#4ade80">approve + place a ledger hold</span> &nbsp;or&nbsp; <span style="color:#f87171">decline with a reason</span>
    </div>
  </div></body>`);
await page.waitForTimeout(17000);

await page.setContent(`<!doctype html><meta charset="utf-8"><body style="margin:0;height:100vh;
  background:#05080d;color:#eef4fb;display:flex;align-items:center;justify-content:center;
  font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif">
  <div style="max-width:920px;padding:0 60px">
    <h2 style="font-size:31px;margin:0 0 26px;letter-spacing:-.8px">The card we're testing</h2>
    <div style="font:16px/2.1 ui-monospace,Menlo,monospace;color:#b3c3d4;background:#0a1017;
      border:1px solid #1d2836;border-radius:13px;padding:24px 30px;margin-bottom:26px">
      total: <span style="color:#4ade80">R500.00</span><br>
      per_transaction: <span style="color:#4ade80">R250.00</span><br>
      allowed_merchant_categories: <span style="color:#4ade80">["5411"]</span> <span style="color:#5f7488">— groceries only</span><br>
      approval_threshold: <span style="color:#4ade80">R200.00</span>
    </div>
    <p style="font-size:20px;line-height:1.65;color:#c3d2e2;margin:0">
      Four purchases. Watch which one gets through — and why the other three don't.</p>
  </div></body>`);
await page.waitForTimeout(12500);

await terminal(page, scenes.auth, { title: "bash — four authorization attempts" });

// --- read the results back ----------------------------------------------------
await page.setContent(`<!doctype html><meta charset="utf-8"><body style="margin:0;height:100vh;
  background:#05080d;color:#eef4fb;display:flex;align-items:center;justify-content:center;
  font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif">
  <div style="max-width:1030px;padding:0 60px;width:100%">
    <h2 style="font-size:31px;margin:0 0 30px;letter-spacing:-.8px">What just happened</h2>
    ${[
      ["#22c55e", "R80 at Checkers · MCC 5411", "approved", "Inside every limit, correct category, under the R200 threshold. Money moves."],
      ["#f87171", "R50 at Steam · MCC 5816", "merchant_category_not_allowed", "Well under budget — and refused anyway. The card is scoped to groceries; a games store isn't groceries."],
      ["#f87171", "R300 at Checkers · MCC 5411", "per_transaction_limit_exceeded", "Right category, wallet has the money — but it breaches the R250 per-charge cap."],
      ["#facc15", "R220 at Makro · MCC 5411", "pending_human_approval", "Nothing is wrong with it. It's simply above R200, so a person decides. No money has moved."],
    ].map(([c, title, code, body]) => `
      <div style="display:flex;gap:20px;margin-bottom:19px;align-items:flex-start">
        <div style="width:5px;align-self:stretch;background:${c};border-radius:3px;flex:none"></div>
        <div style="flex:1">
          <div style="font-size:17.5px;font-weight:700;margin-bottom:5px">${title}
            <span style="color:${c};font:600 14px ui-monospace,Menlo,monospace;margin-left:10px">${code}</span></div>
          <div style="color:#9db0c6;font-size:16px;line-height:1.55">${body}</div>
        </div>
      </div>`).join("")}
  </div></body>`);
await page.waitForTimeout(21000);

// --- the point ----------------------------------------------------------------
await page.setContent(`<!doctype html><meta charset="utf-8"><body style="margin:0;height:100vh;
  background:#05080d;color:#eef4fb;display:flex;align-items:center;justify-content:center;
  font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif">
  <div style="max-width:920px;padding:0 60px">
    <h2 style="font-size:32px;margin:0 0 26px;letter-spacing:-.8px">Why this is refusal, not reporting</h2>
    <p style="font-size:21px;line-height:1.7;color:#c3d2e2;margin:0 0 22px">
      Most spend controls are <b style="color:#f87171">detective</b> — they tell you afterwards that
      something went wrong, and then you chase a refund.</p>
    <p style="font-size:21px;line-height:1.7;color:#c3d2e2;margin:0 0 22px">
      These four decisions happened <b style="color:#4ade80">inside the authorization window</b>.
      The declined charges were never funded. There is nothing to claw back, because nothing left.</p>
    <p style="font-size:21px;line-height:1.7;color:#c3d2e2;margin:0">
      An agent stuck in a retry loop hits the same wall on every attempt.</p>
  </div></body>`);
await page.waitForTimeout(15000);

await endCard(page, {
  title: "Four outcomes, one card, zero incidents",
  lines: [
    "Category, per-charge cap, and lifetime budget are each enforced independently",
    "Declines carry a <b>machine-readable reason</b> — your agent can react to it",
    "A held charge is not a failed charge — it's waiting on a human",
    "<b>Next:</b> approve that held charge and watch the retry succeed",
  ],
  hold: 7200,
});

console.log("VIDEO:", await finish(browser, ctx, page, "ep04"));
