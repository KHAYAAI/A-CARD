import type { Model, ModelMessage } from "./model.js";
import { FEES } from "./fees.js";
import { checkout, freeform, HELP } from "./freeform.js";
import { call, earlier, last, lastUserText, parse as _parse, rands, resultsSinceLastUserMessage, say, verdict, type Step } from "./plan.js";

/**
 * Demo mode: a scripted agent. There is no model and no key. It reads the
 * visitor's message, picks one of a handful of scenarios, and makes the same
 * tool calls Claude would. Every call goes to the real sandbox platform, so
 * the cards, approvals, x402 payments and wallet movements are real (on test
 * money); only the agent's choices are scripted. The UI labels this.
 */

const weather = (base: string) => `${base}/demo/weather`;

const SCENARIOS: Array<{ match: RegExp; steps: Step[] }> = [
  {
    // Retry after approving: re-run whatever is waiting.
    match: /\b(approved|retry|try again|go ahead|i approved|execute)\b/i,
    steps: [
      (_r, { history }) => {
        const e = earlier(history);
        if (e.heldCharge) return [say("Retrying the held charge now that you've approved it."), call("pay_checkout", e.heldCharge)];
        if (e.heldTransfer) return [say("Executing the transfer you approved."), call("send_execute", { preview_id: e.heldTransfer })];
        return [say("Nothing is waiting for approval. Try one of the example prompts, such as the R1 500 charge on a card that needs your sign-off.")];
      },
      (r) => {
        const x = r[0]!;
        if (x.name === "pay_checkout") return [say(`A-CARD ${verdict(x)}. ${verdict(x) === "approved" ? "It went through exactly once, because you approved it." : ""}`.trim())];
        return [say(x.output?.status === "settled" || x.output?.tx_hash || x.output?.txHash ? "Done. The transfer settled on the mock chain after your approval." : `The wallet says: ${x.raw.slice(0, 160)}`)];
      },
    ],
  },
  {
    match: /\bthen buy\b|card (limited|that can only)/i,
    steps: [
      () => [
        say("I'll search A-MERCHANT for verified suppliers near Johannesburg who can deliver 50 bags by tomorrow."),
        call("find_offers", { query: "cement", quantity: 50, lat: -26.2309, lng: 28.1772, radius_km: 60, max_lead_time_days: 1, limit: 8 }),
      ],
      (r) => {
        const offers: any[] = last(r, "find_offers")?.output?.offers ?? [];
        const best = offers[0];
        if (!best) return [say("No supplier matched that search.")];
        const total = best.totalCents ?? best.total_cents ?? 0;
        const name = best.merchant?.name ?? "the top supplier";
        const mcc = best.merchant?.merchantCategoryCode ?? best.merchant?.merchant_category_code ?? "5211";
        return [
          say(`${offers.length} supplier${offers.length === 1 ? "" : "s"} matched. Best is ${name} at ${rands(total)}. I'll create a single-use card that can only be spent at building suppliers, capped at that price.`),
          call("create_card", { label: `Cement from ${name}`, single_use: true, total_limit: total, per_transaction_limit: total, allowed_merchant_categories: [mcc] }),
        ];
      },
      (r) => {
        const card = last(r, "create_card")?.output;
        const best = (last(r, "find_offers")?.output?.offers ?? [])[0];
        const total = best.totalCents ?? best.total_cents ?? 0;
        return [say("Card ready. Paying the supplier."), call("pay_checkout", { card_id: card.id, amount: total, merchant_name: best.merchant?.name ?? "Supplier", merchant_category: best.merchant?.merchantCategoryCode ?? best.merchant?.merchant_category_code ?? "5211" })];
      },
      (r) => [say(`A-CARD ${verdict(last(r, "pay_checkout"))}. The card was single-use, so it's now closed. Check the Cards and Transactions panels.`)],
    ],
  },
  {
    match: /casino.*general card|general card.*casino|lucky spin|org(anisation)? policy/i,
    steps: [
      () => [say("I'll create a general-purpose card with no category limits of its own, then try to spend R500 at an online casino."), call("create_card", { label: "General spend", single_use: false, total_limit: 100000 })],
      (r) => [say("Trying the charge."), call("pay_checkout", { card_id: last(r, "create_card")!.output.id, amount: 50000, merchant_name: "Lucky Spin Online", merchant_category: "7995" })],
      (r) => {
        const v = verdict(last(r, "pay_checkout"));
        return [say(`A-CARD ${v}. ${v.startsWith("declined") ? "The card itself would have allowed it, but your organisation's policy blocks gambling on every card. Org policy beats card rules. See Policies to change it." : "Gambling isn't blocked in your policy right now. Add 7995 under Policies and try again."}`)];
      },
    ],
  },
  {
    match: /(fuel|\btv\b|television).*\bthen try\b|\bthen try\b.*(\btv\b|television)/i,
    steps: [
      () => [say("I'll create a single-use R1 000 fuel card, which only works at fuel stations."), call("create_card", { label: "Fleet fuel", single_use: false, total_limit: 100000, per_transaction_limit: 100000, allowed_merchant_categories: ["5541"] })],
      (r) => [say("Now the test: trying to buy a TV with it."), call("pay_checkout", { card_id: last(r, "create_card")!.output.id, amount: 90000, merchant_name: "Game Electronics", merchant_category: "5732" })],
      (r) => [say(`A-CARD ${verdict(last(r, "pay_checkout"))}. A fuel card can't buy electronics, and I won't try another card to get around it.`)],
    ],
  },
  {
    match: /needs my approval.*\bspend\b/i,
    steps: [
      () => [say("I'll create a card that asks you to approve any charge of R1 000 or more."), call("create_card", { label: "Site tools", single_use: false, approval_threshold: 100000, allowed_merchant_categories: ["5211"] })],
      (r) => [say("Now a R1 500 charge at Rand Build Supply."), call("pay_checkout", { card_id: last(r, "create_card")!.output.id, amount: 150000, merchant_name: "Rand Build Supply", merchant_category: "5211" })],
      () => [say("A-CARD is holding the charge for your approval. I can't approve it myself. Click Approve in the panel on the right, then tell me \"I approved it\" and I'll retry once.")],
    ],
  },
  {
    match: /\bx402\b/i,
    steps: [
      (_r, { base }) => [
        say("I'll make a US dollar card limited to x402 payments, then pay a metered weather API with a 1 cent ceiling."),
        call("create_card", { label: "Weather API", currency: "USD", single_use: false, allowed_merchant_categories: ["x402"], x402_allowed_hosts: [new URL(base).hostname] }),
      ],
      (r, { base }) => [call("pay_x402", { card_id: last(r, "create_card")!.output.id, url: weather(base), max_usd: "0.01" })],
      (r) => [say(`The API asked 0.003 USDC; my ceiling was 1 cent. A-CARD ${verdict(last(r, "pay_x402"))}.`)],
    ],
  },
  {
    match: /\bthen try\b/i,
    steps: [
      () => [say("I'll preview a 20 USDC transfer. Nothing moves until the policy allows it."), call("send_preview", { wallet_id: "default", chain: "mock", asset: "USDC", to: "merchant-1", amount: "20000000" })],
      (r) => {
        const p = last(r, "send_preview")?.output;
        return [say(p?.decision === "require_approval" ? "20 USDC is above the auto-approve limit, so it's held for you. Now I'll test the hard limit with 90 USDC." : `Decision: ${p?.decision}. Now testing 90 USDC.`), call("send_preview", { wallet_id: "default", chain: "mock", asset: "USDC", to: "merchant-1", amount: "90000000" })];
      },
      (r) => {
        const sends = r.filter((x) => x.name === "send_preview");
        const big = sends[1]?.output;
        return [say(`90 USDC: ${big?.decision}${big?.reasons ? ` (${big.reasons.join(", ")})` : ""}. I won't split it into smaller transfers to get around the limit. The 20 USDC transfer is waiting for you in the panel; approve it and tell me "I approved it" and I'll execute it.`)];
      },
    ],
  },
];

export const mockModel: Model = async ({ messages, base }) => {
  const { results, turns } = resultsSinceLastUserMessage(messages);
  const text = lastUserText(messages);
  const ctx = { base: base ?? "", history: messages as ModelMessage[] };
  // The curated demonstrations first (their exact scenarios), then anything else in plain English.
  if (/^checkout:/i.test(text)) return { content: checkout(text, results) };
  const scenario = SCENARIOS.find((s) => s.match.test(text));
  if (scenario) {
    const step = scenario.steps[turns];
    return { content: step ? step(results, ctx) : [say("Done.")] };
  }
  return { content: freeform(text, results, ctx) };
};
export { HELP };
