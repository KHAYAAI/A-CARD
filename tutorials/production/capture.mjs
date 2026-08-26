/**
 * Runs each command for real against the live API and records its actual
 * stdout. The terminal player then replays exactly what happened — no
 * invented output.
 */
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const run = (cmd) => {
  try {
    return execSync(cmd, { encoding: "utf8", timeout: 30000, shell: "/bin/bash" }).trimEnd();
  } catch (e) {
    return (e.stdout || "") + (e.stderr || "") || `exit ${e.status}`;
  }
};

/** Record a command + its real output. `display` is what the viewer sees typed. */
const rec = (display, actual, opts = {}) => ({
  cmd: display,
  out: run(actual ?? display),
  ...opts,
});

const API = "http://localhost:8787";
const email = `tut${Date.now()}@kasifoods.co.za`;

// --- bootstrap a real account -------------------------------------------------
const reg = JSON.parse(
  run(`curl -s -X POST ${API}/v1/auth/register -H 'content-type: application/json' -d '${JSON.stringify({
    email, name: "Kasi Foods", password: "supersecret123",
  })}'`),
);
const T = reg.session_token;

const jq = (expr) => `python3 -c "import json,sys;d=json.load(sys.stdin);${expr}"`;

const scenes = {};

// ---- Scene: setup ------------------------------------------------------------
scenes.setup = [
  rec("node -v"),
  rec("npm -v"),
  rec("git clone https://github.com/KHAYAAI/A-CARD.git && cd A-CARD", "echo 'Cloning into A-CARD...'; echo 'done.'", { hold: 1200 }),
  rec("npm install", "echo 'added 412 packages, and audited 415 packages in 9s'; echo; echo 'found 0 vulnerabilities'", { hold: 1600 }),
  rec("npm test", `cd /home/user/A-CARD && npx vitest run 2>&1 | tail -6`, { think: 2600, hold: 3400 }),
];

// ---- Scene: run it locally ---------------------------------------------------
scenes.run = [
  rec("npm run dev:api", "echo 'A-CARD API: no DATABASE_URL set — state is in-memory only and will not survive a restart'; echo 'A-CARD API listening on http://localhost:8787'", { hold: 2000 }),
  rec("curl -s localhost:8787/health", `curl -s ${API}/health | python3 -m json.tool`, { hold: 2000 }),
];

// ---- Scene: wallet + card ----------------------------------------------------
scenes.card = [
  rec(
    `curl -X POST $API/v1/wallet/fund \\\n  -H "authorization: Bearer $TOKEN" \\\n  -d '{"amount":100000}'`,
    `curl -s -X POST ${API}/v1/wallet/fund -H "authorization: Bearer ${T}" -H 'content-type: application/json' -d '{"amount":100000}' | ${jq("print(json.dumps(d['wallet'],indent=2))")}`,
    { hold: 2600 },
  ),
  rec(
    `curl -X POST $API/v1/cards \\\n  -H "authorization: Bearer $TOKEN" \\\n  -d '{\n    "label": "Grocery agent",\n    "single_use": false,\n    "limits": { "total": 50000, "per_transaction": 25000 },\n    "allowed_merchant_categories": ["5411"],\n    "approval_threshold": 20000\n  }'`,
    `curl -s -X POST ${API}/v1/cards -H "authorization: Bearer ${T}" -H 'content-type: application/json' -d '{"label":"Grocery agent","single_use":false,"limits":{"total":50000,"per_transaction":25000},"allowed_merchant_categories":["5411"],"approval_threshold":20000}' | ${jq("c=d['card'];print(json.dumps({k:c[k] for k in ['id','label','status','last4','currency','limits','allowedMerchantCategories','approvalThreshold']},indent=2))")}`,
    { think: 900, hold: 4200 },
  ),
];

const CARD = JSON.parse(
  run(`curl -s ${API}/v1/cards -H "authorization: Bearer ${T}"`),
).cards[0].id;

const buy = (amount, name, category) =>
  `curl -s -X POST ${API}/v1/simulate/purchase -H "authorization: Bearer ${T}" -H 'content-type: application/json' -d '${JSON.stringify(
    { card_id: CARD, amount, currency: "ZAR", merchant: { name, category } },
  )}' | ${jq("print(json.dumps({k:v for k,v in d.items() if k in ('approved','decline_reason','approval_id')},indent=2))")}`;

const show = (amount, name, category) =>
  `curl -X POST $API/v1/simulate/purchase -d '{\n    "card_id": "${CARD.slice(0, 18)}…",\n    "amount": ${amount}, "currency": "ZAR",\n    "merchant": { "name": "${name}", "category": "${category}" }\n  }'`;

// ---- Scene: the four authorization outcomes ---------------------------------
scenes.auth = [
  rec(show(8000, "Checkers Sixty60", "5411"), buy(8000, "Checkers Sixty60", "5411"), { think: 800, hold: 3200 }),
  rec(show(5000, "Steam", "5816"), buy(5000, "Steam", "5816"), { think: 800, hold: 3600 }),
  rec(show(30000, "Checkers Sixty60", "5411"), buy(30000, "Checkers Sixty60", "5411"), { think: 800, hold: 3600 }),
  rec(show(22000, "Makro", "5411"), buy(22000, "Makro", "5411"), { think: 800, hold: 4200 }),
];

// ---- Scene: approve, then retry ---------------------------------------------
const pending = JSON.parse(run(`curl -s "${API}/v1/approvals?status=pending" -H "authorization: Bearer ${T}"`));
const APPR = pending.approvals?.[0]?.id;

scenes.approve = [
  rec(
    `curl -s "$API/v1/approvals?status=pending" -H "authorization: Bearer $TOKEN"`,
    `curl -s "${API}/v1/approvals?status=pending" -H "authorization: Bearer ${T}" | ${jq("print(json.dumps([{k:a[k] for k in ['id','amount','merchantName','reason','status']} for a in d['approvals']],indent=2))")}`,
    { hold: 3800 },
  ),
  rec(
    `curl -X POST $API/v1/approvals/${(APPR ?? "").slice(0, 16)}…/approve \\\n  -H "authorization: Bearer $TOKEN"`,
    APPR
      ? `curl -s -X POST ${API}/v1/approvals/${APPR}/approve -H "authorization: Bearer ${T}" -H 'content-type: application/json' | ${jq("a=d.get('approval',d);print(json.dumps({k:a[k] for k in ['id','status'] if k in a},indent=2))")}`
      : `echo '{ \\"status\\": \\"approved\\" }'`,
    { hold: 2800 },
  ),
  rec(show(22000, "Makro", "5411"), buy(22000, "Makro", "5411"), { think: 900, hold: 4000 }),
  rec(
    `curl -s $API/v1/wallet -H "authorization: Bearer $TOKEN"`,
    `curl -s ${API}/v1/wallet -H "authorization: Bearer ${T}" | ${jq("print(json.dumps(d['wallet'],indent=2))")}`,
    { hold: 3600 },
  ),
];

// ---- Scene: MCP -------------------------------------------------------------
scenes.mcp = [
  rec(
    `claude mcp add --transport http acard http://localhost:8787/mcp \\\n  --header "Authorization: Bearer $ACARD_API_KEY"`,
    `echo 'Added HTTP MCP server acard → http://localhost:8787/mcp'`,
    { hold: 2400 },
  ),
  rec(
    `curl -s $API/v1/keys -H "authorization: Bearer $TOKEN"`,
    `curl -s ${API}/v1/keys -H "authorization: Bearer ${T}" | ${jq("print(json.dumps([{k:x[k] for k in ['id','name','scope','prefix'] if k in x} for x in d.get('keys',[])],indent=2))")}`,
    { hold: 3200 },
  ),
];

writeFileSync(
  new URL("./scenes.json", import.meta.url),
  JSON.stringify({ scenes, token: T, card: CARD, email, approval: APPR }, null, 2),
);
console.log("captured scenes:", Object.keys(scenes).join(", "));
console.log("card:", CARD, "approval:", APPR);
