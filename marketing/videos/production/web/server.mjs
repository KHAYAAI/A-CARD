import { createServer } from "node:http";
import { createHmac, randomUUID } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The demo "web" for the agent-shopping videos, on :4400.
 *
 *   /console          the agent console (transcript + browser pane)
 *   /seek             a search engine (fictional)
 *   /grocery          online groceries          (MCC 5411)
 *   /market           online marketplace        (MCC 5399)
 *   /airline          an airline                (MCC 4511)
 *
 * Every store page takes `?set=public|private` (brands.js). `public` uses
 * fictional stores and is safe to publish. `private` renders illustrative
 * recreations of real South African retailers for private client demos only;
 * each such page carries a "not affiliated" strip. Payment is not simulated: POST /api/pay
 * plays the card network and issuer exactly as production would — it signs an
 * `authorization.request` with the issuer secret and sends it to A-CARD's
 * /webhooks/issuer, then captures on approval. Every approve, decline and
 * hold the stores display is A-CARD's live answer.
 *
 * A real issuer resolves a card from the PAN on its own books. This sandbox
 * stand-in learns that mapping from the recording script (POST /api/cards),
 * which knows both the PAN and A-CARD's card id from the same create_card call.
 */

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const ACARD = process.env.ACARD_API_URL ?? "http://localhost:8787";
const ISSUER_SECRET = process.env.ISSUER_WEBHOOK_SECRET ?? "whsec_demo_recording";
const PORT = Number(process.env.PORT ?? 4400);

const cardsByPan = new Map();
const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml" };

function sign(body) {
  const t = Math.floor(Date.now() / 1000);
  return `t=${t},v1=${createHmac("sha256", ISSUER_SECRET).update(`${t}.${body}`).digest("hex")}`;
}

async function issuerEvent(type, data) {
  const body = JSON.stringify({ id: `evt_${randomUUID()}`, type, data });
  const res = await fetch(`${ACARD}/webhooks/issuer`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-acard-signature": sign(body) },
    body,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const json = (res, status, value) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
};

const readBody = (req) =>
  new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => resolve(raw ? JSON.parse(raw) : {}));
  });

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === "POST" && url.pathname === "/api/cards") {
    const { pan, cardId } = await readBody(req);
    cardsByPan.set(String(pan).replace(/\s+/g, ""), cardId);
    return json(res, 201, { ok: true });
  }

  if (req.method === "POST" && url.pathname === "/api/pay") {
    const { pan, amount, merchant, category } = await readBody(req);
    const cardId = cardsByPan.get(String(pan ?? "").replace(/\s+/g, ""));
    if (!cardId) return json(res, 200, { approved: false, decline_reason: "card_not_found" });
    const authorizationId = `auth_${randomUUID()}`;
    const decision = await issuerEvent("authorization.request", {
      authorization_id: authorizationId,
      card_id: cardId,
      amount,
      currency: "ZAR",
      merchant: { name: merchant, category, country: "ZA" },
    });
    if (decision.body.approved) await issuerEvent("transaction.capture", { authorization_id: authorizationId });
    return json(res, 200, { authorization_id: authorizationId, ...decision.body });
  }

  const page = { "/": "console.html", "/console": "console.html", "/seek": "seek.html", "/grocery": "grocery.html", "/market": "market.html", "/airline": "airline.html" }[url.pathname];
  const file = page ? join(ROOT, page) : join(ROOT, url.pathname);
  if (!file.startsWith(ROOT) || !existsSync(file)) {
    res.writeHead(404);
    return res.end("not found");
  }
  res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
  res.end(readFileSync(file));
}).listen(PORT, () => console.log(`demo web on http://localhost:${PORT}`));
