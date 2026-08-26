import { readFileSync } from "node:fs";
import { studio, make, titleCard, endCard, terminal, finish } from "./lib.mjs";

const { scenes } = JSON.parse(readFileSync(new URL("./scenes.json", import.meta.url)));
const { browser, ctx, page } = await studio("ep02");
const ui = make(page);

await titleCard(page, {
  kicker: "Episode 2 of 9",
  title: "Setup and first run",
  sub: "Clone it, install it, prove the test suite passes, and get the API answering on your own machine — with no database and no cloud account.",
  hold: 6200,
});

await page.setContent(`<!doctype html><meta charset="utf-8"><body style="margin:0;height:100vh;
  background:#05080d;color:#eef4fb;display:flex;align-items:center;justify-content:center;
  font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif">
  <div style="max-width:940px;padding:0 60px">
    <h2 style="font-size:33px;margin:0 0 30px;letter-spacing:-.8px">What you need</h2>
    <ul style="font-size:21px;line-height:2.1;color:#c3d2e2;margin:0;padding-left:26px">
      <li><b style="color:#4ade80">Node 20+</b> and npm — that's genuinely the whole list</li>
      <li><b style="color:#4ade80">No database.</b> Leave <code style="color:#a7f3d0">DATABASE_URL</code> unset and it runs fully in memory</li>
      <li><b style="color:#4ade80">No AWS account</b>, no card issuer, no payment provider</li>
      <li><b style="color:#4ade80">No PCI exposure</b> — the sandbox mints deterministic <code style="color:#a7f3d0">4242…</code> test PANs</li>
    </ul>
    <p style="font-size:18px;color:#7f93a9;margin:34px 0 0;line-height:1.6">
      Everything in this episode runs offline on a laptop.</p>
  </div></body>`);
await page.waitForTimeout(12500);

await terminal(page, scenes.setup, { title: "bash — installing A-CARD" });

await page.setContent(`<!doctype html><meta charset="utf-8"><body style="margin:0;height:100vh;
  background:#05080d;color:#eef4fb;display:flex;align-items:center;justify-content:center;
  font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif">
  <div style="max-width:900px;padding:0 60px">
    <h2 style="font-size:31px;margin:0 0 26px;letter-spacing:-.8px">That test run matters</h2>
    <p style="font-size:21px;line-height:1.7;color:#c3d2e2;margin:0 0 22px">
      Those tests aren't decoration. They cover the parts where a bug costs real money:
      <b style="color:#4ade80">ledger invariants</b>, <b style="color:#4ade80">the overspend guard under
      concurrency</b>, <b style="color:#4ade80">webhook signature verification</b>, and
      <b style="color:#4ade80">every authorization decision path</b>.</p>
    <p style="font-size:21px;line-height:1.7;color:#c3d2e2;margin:0">
      If they pass, the money-safety core is behaving.</p>
  </div></body>`);
await page.waitForTimeout(11000);

await terminal(page, scenes.run, { title: "bash — running the API" });

await page.setContent(`<!doctype html><meta charset="utf-8"><body style="margin:0;height:100vh;
  background:#05080d;color:#eef4fb;display:flex;align-items:center;justify-content:center;
  font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif">
  <div style="max-width:960px;padding:0 60px;width:100%">
    <h2 style="font-size:31px;margin:0 0 32px;letter-spacing:-.8px">Three persistence modes</h2>
    <table style="width:100%;border-collapse:collapse;font-size:17px">
      ${[
        ["no DATABASE_URL", "In-memory. Ephemeral, resets on restart. Perfect for local dev and this tutorial series."],
        ["DATABASE_URL set", "Postgres multi-writer — a row-level ledger with per-wallet <code>FOR UPDATE</code> locks. Several API instances share one database safely. This is the production default."],
        ["+ ACARD_PERSISTENCE=snapshot", "In-memory plus a single-writer JSONB snapshot. Correct only at one instance — kept for simplicity, not for scale."],
      ].map(([a, b]) => `<tr>
        <td style="padding:16px 22px 16px 0;color:#4ade80;font:600 15px ui-monospace,Menlo,monospace;
          vertical-align:top;border-bottom:1px solid #17202c;width:270px">${a}</td>
        <td style="padding:16px 0;color:#b3c3d4;line-height:1.62;border-bottom:1px solid #17202c">${b}</td></tr>`).join("")}
    </table>
  </div></body>`);
await page.waitForTimeout(16000);

await endCard(page, {
  title: "You now have a running platform",
  lines: [
    "The API is answering on <code>localhost:8787</code>",
    "The full test suite passes — the ledger core is sound",
    "State is in-memory, so you can experiment freely and restart to reset",
    "<b>Next:</b> fund a wallet and create your first card",
  ],
  hold: 7000,
});

console.log("VIDEO:", await finish(browser, ctx, page, "ep02"));
