/**
 * A-CARD decision hook for an Investec programmable card (PILOT).
 *
 * Paste this file into the card's code editor in Investec Programmable Banking
 * (or deploy it with their tooling) and put your values in env.json, using
 * env.example.json as the template. Every charge on the card is sent to A-CARD,
 * which applies the card's limits, merchant-category rules and approval
 * thresholds and answers approve or decline.
 *
 * What this does NOT do: it never moves money and holds no card number. It
 * places a hold in A-CARD's budget ledger before each charge and settles or
 * releases it afterwards. Investec still issues the card and settles the charge;
 * A-CARD only decides. It only works on cards on YOUR Investec account.
 *
 * ASSUMPTIONS TO CHECK in Investec's simulator before you rely on it (they come
 * from Investec's public programmable-card documentation as I understood it, not
 * from running against your account):
 *   - the hook is `beforeTransaction(authorization)` and returns true or false;
 *   - `authorization` has `card.id`, `centsAmount`, `currencyCode`, `reference`,
 *     and `merchant.{name, category.code, country.code}`;
 *   - `fetch` and `process.env` are available inside the card code.
 * If a field name differs, change `describe()` below: it is the only place that
 * reads the authorization object.
 */

const TIMEOUT_MS = 1200; // Investec gives card code about 2 seconds in total (per their docs), so stay well inside it

/** The only place that reads Investec's authorization object. */
function describe(authorization) {
  const merchant = authorization.merchant || {};
  const category = merchant.category || {};
  const country = merchant.country || {};
  return {
    authorization_id: String(authorization.reference || authorization.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
    card_id: String((authorization.card && authorization.card.id) || ""),
    amount: Math.round(Number(authorization.centsAmount)),
    currency: String(authorization.currencyCode || "").toUpperCase(),
    merchant: {
      name: String(merchant.name || "unknown").slice(0, 200),
      category: String(category.code || "0000").slice(0, 8),
      country: country.code ? String(country.code).slice(0, 3) : undefined,
    },
  };
}

const beforeTransaction = async (authorization) => {
  const env = process.env;
  const failOpen = env.ACARD_FAIL_OPEN === "true"; // default: if A-CARD can't answer, decline
  let body;
  try {
    body = describe(authorization);
  } catch (e) {
    console.log("a-card: could not read the authorization, " + (failOpen ? "approving (fail open)" : "declining"), String(e));
    return failOpen;
  }
  if (!body.card_id || !(body.amount > 0) || (body.currency !== "ZAR" && body.currency !== "USD")) {
    // A-CARD prices in ZAR and USD only. A foreign-currency charge is declined, never guessed at.
    console.log("a-card: declined, unsupported or unreadable charge", body.currency, body.amount);
    return false;
  }
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), TIMEOUT_MS) : null;
  try {
    const res = await fetch(String(env.ACARD_URL).replace(/\/$/, "") + "/webhooks/investec/authorize", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + env.ACARD_HOOK_SECRET },
      body: JSON.stringify(body),
      signal: controller ? controller.signal : undefined,
    });
    if (!res.ok) throw new Error("A-CARD answered " + res.status);
    const decision = await res.json();
    console.log("a-card: " + (decision.approved ? "approved" : "declined (" + decision.decline_reason + ")"), body.merchant.name, body.amount, body.currency);
    return decision.approved === true;
  } catch (e) {
    console.log("a-card: no decision (" + String(e && e.message ? e.message : e) + "), " + (failOpen ? "approving (fail open)" : "declining"));
    return failOpen;
  } finally {
    if (timer) clearTimeout(timer);
  }
};

// Follow-ups: settle the hold A-CARD placed when the charge goes through, release it if Investec declines
// after A-CARD approved. Without these the A-CARD budget would never reflect what was actually spent.
// ASSUMPTION TO CHECK: `transaction.reference` equals the `authorization.reference` seen in beforeTransaction.
async function followUp(kind, transaction) {
  const env = process.env;
  try {
    const payload = { authorization_id: String((transaction && (transaction.reference || transaction.id)) || "") };
    if (kind === "settle" && transaction && Number(transaction.centsAmount) > 0) payload.final_amount = Math.round(Number(transaction.centsAmount));
    if (!payload.authorization_id) return;
    const res = await fetch(String(env.ACARD_URL).replace(/\/$/, "") + "/webhooks/investec/" + kind, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + env.ACARD_HOOK_SECRET },
      body: JSON.stringify(payload),
    });
    console.log("a-card: " + kind, payload.authorization_id, res.status);
  } catch (e) {
    console.log("a-card: " + kind + " failed", String(e && e.message ? e.message : e));
  }
}
const afterTransaction = async (transaction) => followUp("settle", transaction);
const afterDecline = async (transaction) => followUp("release", transaction);

if (typeof module !== "undefined" && module.exports) module.exports = { beforeTransaction, afterTransaction, afterDecline, describe };
