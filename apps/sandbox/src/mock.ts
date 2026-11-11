import type { Block, Model, ModelMessage } from "./model.js";
import { KEYWORDS } from "./catalogue.js";

/**
 * Demo mode: a scripted agent. There is no model and no key. It reads the
 * visitor's message, picks one of a handful of scenarios, and makes the same
 * tool calls Claude would. Every call goes to the real sandbox platform, so
 * the cards, approvals, x402 payments and wallet movements are real (on test
 * money); only the agent's choices are scripted. The UI labels this.
 */

type Results = Array<{ name: string; input: any; output: any; raw: string }>;
type Step = (r: Results, ctx: Ctx) => Block[];
interface Ctx {
  base: string;
  history: ModelMessage[];
}

let n = 0;
const id = () => `mock_${++n}_${Math.random().toString(36).slice(2, 8)}`;
const say = (text: string): Block => ({ type: "text", text });
const call = (name: string, input: unknown): Block => ({ type: "tool_use", id: id(), name, input });
const parse = (s: string) => {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
};
const last = (r: Results, name: string) => [...r].reverse().find((x) => x.name === name);
const rands = (cents: number) => `R${(cents / 100).toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).replace(/,/g, " ")}`;

/** Tool results since the visitor's latest message, paired with the call that made them. */
function resultsSinceLastUserMessage(history: ModelMessage[]): { results: Results; turns: number } {
  let start = history.length - 1;
  while (start >= 0 && !(history[start]!.role === "user" && typeof history[start]!.content === "string")) start--;
  const uses = new Map<string, { name: string; input: any }>();
  const results: Results = [];
  let turns = 0;
  for (const m of history.slice(start + 1)) {
    if (m.role === "assistant" && Array.isArray(m.content)) {
      turns++;
      for (const b of m.content) if (b.type === "tool_use") uses.set(b.id, { name: b.name, input: b.input });
    } else if (m.role === "user" && Array.isArray(m.content)) {
      for (const b of m.content) if (b.type === "tool_result") {
        const u = uses.get(b.tool_use_id);
        if (u) results.push({ ...u, raw: b.content, output: parse(b.content) });
      }
    }
  }
  return { results, turns };
}

/** The most recent thing of a kind from earlier in the conversation (a card id, a held preview). */
function earlier(history: ModelMessage[]) {
  const uses = new Map<string, { name: string; input: any }>();
  let card: string | undefined;
  let heldCharge: any;
  let heldTransfer: string | undefined;
  for (const m of history) {
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (b.type === "tool_use") uses.set(b.id, { name: b.name, input: b.input });
      if (b.type === "tool_result") {
        const u = uses.get(b.tool_use_id);
        const out = parse(b.content);
        if (u?.name === "create_card" && out?.id) card = out.id;
        if (u?.name === "pay_checkout") heldCharge = /pending_human_approval|pending_approval/.test(b.content) ? u.input : undefined;
        if (u?.name === "send_preview" && out?.decision === "require_approval") heldTransfer = out.preview_id;
        if (u?.name === "send_execute") heldTransfer = undefined;
      }
    }
  }
  return { card, heldCharge, heldTransfer };
}

/** One plain sentence for a pay_checkout / pay_x402 result. */
const verdict = (x?: { raw: string; output: any }) => {
  const o = x?.output;
  if (o && typeof o === "object") {
    if (o.approved === true) return "approved";
    if (o.approved === false) return `declined (${o.decline_reason ?? o.declineReason ?? "no reason given"})`;
    if (o.status === "paid") return `paid${o.body ? `. The API replied: ${typeof o.body === "string" ? o.body : JSON.stringify(o.body)}` : ""}`;
    if (o.status) return String(o.status);
  }
  return (x?.raw ?? "").replace(/^Error\s*—\s*/, "").replace(/\s+/g, " ").slice(0, 160);
};

const weather = (base: string) => `${base}/demo/weather`;

function parseCheckout(history: ModelMessage[]) {
  const t = String([...history].reverse().find((m) => m.role === "user" && typeof m.content === "string")?.content ?? "");
  const m = /buy (\d+) × (.+?) from (.+?) for R([\d.]+) \(merchant category (\w+)\)(?:, order fee R([\d.]+) and card processing R([\d.]+) \(fees category (\w+)\))?/i.exec(t);
  if (!m) return undefined;
  return { qty: m[1]!, item: m[2]!, merchant: m[3]!, items: Math.round(Number(m[4]) * 100), mcc: m[5]!, fees: Math.round((Number(m[6] ?? 0) + Number(m[7] ?? 0)) * 100), feeMcc: m[8] ?? "7399" };
}

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
    // The cart's "Checkout": pay the merchant, then the fees, on one card scoped to those two categories.
    match: /^checkout:/i,
    steps: [
      (_r, { history }) => {
        const c = parseCheckout(history);
        if (!c) return [say("I couldn't read that cart. Try adding the item again.")];
        return [
          say(`Checking out: ${c.qty} × ${c.item} from ${c.merchant}, ${rands(c.items)}${c.fees ? ` plus ${rands(c.fees)} in fees` : ""}. I'll create one card capped at exactly ${rands(c.items + c.fees)} and limited to the merchant's category${c.fees ? " and the fee category" : ""}.`),
          call("create_card", { label: `${c.item} · ${c.merchant}`, single_use: false, total_limit: c.items + c.fees, per_transaction_limit: c.items, allowed_merchant_categories: c.fees ? [c.mcc, c.feeMcc] : [c.mcc] }),
        ];
      },
      (r, { history }) => {
        const c = parseCheckout(history)!;
        return [call("pay_checkout", { card_id: last(r, "create_card")!.output.id, amount: c.items, merchant_name: c.merchant, merchant_category: c.mcc })];
      },
      (r, { history }) => {
        const c = parseCheckout(history)!;
        const id = last(r, "create_card")!.output.id;
        return c.fees ? [say(`The merchant is paid (${verdict(last(r, "pay_checkout"))}). Now the fees.`), call("pay_checkout", { card_id: id, amount: c.fees, merchant_name: "a·card fees", merchant_category: c.feeMcc })] : [call("close_card", { card_id: id })];
      },
      (r, { history }) => {
        const c = parseCheckout(history)!;
        const id = last(r, "create_card")!.output.id;
        return c.fees ? [call("close_card", { card_id: id })] : [say(`A-CARD ${verdict(last(r, "pay_checkout"))}. The card is closed. See Track spending for the record.`)];
      },
      (r) => {
        const pays = r.filter((x) => x.name === "pay_checkout");
        const ok = pays.length > 0 && pays.every((x) => verdict(x) === "approved");
        return [say(ok ? `Done. The merchant and the fees were both approved, and the card is closed. See Track spending for the record.` : `Something was refused: ${pays.map(verdict).join("; ")}. The card is closed, so nothing more can be charged.`)];
      },
    ],
  },
  {
    // Browse without buying: show ranked offers as cards.
    match: new RegExp(`^(?!.*\\b(buy|purchase|pay|checkout|swap|send|transfer|usdc|approval|approved)\\b)(?=.*(?:${KEYWORDS.map((k) => k.re.source).join("|")})).*\\b(show|browse|search|compare|options|offers|find|looking for|need)\\b`, "i"),
    steps: [
      (_r, { history }) => {
        const t = String([...history].reverse().find((m) => m.role === "user" && typeof m.content === "string")?.content ?? "");
        // The keyword that appears earliest in what the visitor wrote.
        const hits = KEYWORDS.map((x) => ({ x, at: t.search(x.re) })).filter((h) => h.at >= 0).sort((a, b) => a.at - b.at);
        const k = hits[0]?.x;
        if (!k) return [say(HELP)];
        const lat = -26.2309, lng = 28.1772;
        return [say(`Searching A-MERCHANT for verified suppliers of ${k.label} near Johannesburg.`), call("find_offers", { query: k.query, quantity: k.quantity, lat, lng, radius_km: 80, limit: 8 })];
      },
      (r) => {
        const n = (last(r, "find_offers")?.output?.offers ?? []).length;
        return [say(n ? `${n} verified supplier${n === 1 ? "" : "s"}, ranked by price, distance and how fresh their stock count is. Tap “Add” to put one in your cart, then check out and I'll pay with a card scoped to that purchase.` : "No verified supplier matched that. Try a simpler word, like bread, paper, gloves or cement.")];
      },
    ],
  },
  {
    match: /cement|supplier|find .*offers|a-merchant|building suppl/i,
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
    match: /casino|gambl|lucky spin|7995|org(anisation)? policy/i,
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
    match: /fuel|\btv\b|television/i,
    steps: [
      () => [say("I'll create a single-use R1 000 fuel card, which only works at fuel stations."), call("create_card", { label: "Fleet fuel", single_use: false, total_limit: 100000, per_transaction_limit: 100000, allowed_merchant_categories: ["5541"] })],
      (r) => [say("Now the test: trying to buy a TV with it."), call("pay_checkout", { card_id: last(r, "create_card")!.output.id, amount: 90000, merchant_name: "Game Electronics", merchant_category: "5732" })],
      (r) => [say(`A-CARD ${verdict(last(r, "pay_checkout"))}. A fuel card can't buy electronics, and I won't try another card to get around it.`)],
    ],
  },
  {
    match: /approval|sign.?off|approve|1 ?500/i,
    steps: [
      () => [say("I'll create a card that asks you to approve any charge of R1 000 or more."), call("create_card", { label: "Site tools", single_use: false, approval_threshold: 100000, allowed_merchant_categories: ["5211"] })],
      (r) => [say("Now a R1 500 charge at Rand Build Supply."), call("pay_checkout", { card_id: last(r, "create_card")!.output.id, amount: 150000, merchant_name: "Rand Build Supply", merchant_category: "5211" })],
      () => [say("A-CARD is holding the charge for your approval. I can't approve it myself. Click Approve in the panel on the right, then tell me \"I approved it\" and I'll retry once.")],
    ],
  },
  {
    match: /x402|weather|api call|pay.*api|per.?call/i,
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
    match: /swap|zarp|convert/i,
    steps: [
      () => [say("I'll quote a swap of 5 USDC to ZARP in the on-chain wallet."), call("swap_quote", { wallet_id: "default", chain: "mock", asset_in: "USDC", asset_out: "ZARP", amount_in: "5000000" })],
      (r) => [say("The quote is within policy. Executing it."), call("swap_execute", { preview_id: last(r, "swap_quote")!.output.preview_id })],
      () => [call("get_balances", { chain: "mock" })],
      (r) => {
        const b = last(r, "get_balances")?.output?.balances ?? {};
        const f = (v: string | undefined) => (Number(v ?? 0) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 2 });
        return [say(`Swapped at the sandbox's fixed rate. Wallet now holds ${f(b.USDC)} USDC and ${f(b.ZARP)} ZARP (mock chain, test funds).`)];
      },
    ],
  },
  {
    match: /send|transfer|usdc|wallet|on-?chain|\b90\b|\b20\b/i,
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

const HELP = `I'm the scripted demo agent: no AI model is running, but every action I take is a real call to the sandbox platform, on test money. I can show you:

• Browse supplier offers as cards, add one to your cart and check out ("show me bread", "find A4 paper", "hard hats", "laptop gear", "cleaning supplies", "cement"…)
• Find supplier offers and buy with a scoped card ("find cement near Johannesburg")
• A fuel card refusing a TV ("fuel card, then try to buy a TV")
• A charge held for your approval ("spend R1 500, needs my approval")
• A casino charge refused by organisation policy ("try a casino")
• Paying an API per call with x402
• A wallet transfer: 20 USDC held, 90 USDC refused
• A swap from USDC to ZARP

Tap an example prompt, or add your own Claude key (top right) for a live agent that can handle anything you ask.`;

export const mockModel: Model = async ({ messages, base }) => {
  const { results, turns } = resultsSinceLastUserMessage(messages);
  const lastUser = [...messages].reverse().find((m) => m.role === "user" && typeof m.content === "string");
  const text = String(lastUser?.content ?? "");
  const scenario = SCENARIOS.find((s) => s.match.test(text));
  if (!scenario) return { content: [say(HELP)] };
  const step = scenario.steps[turns];
  if (!step) return { content: [say("Done.")] };
  return { content: step(results, { base: base ?? "", history: messages }) };
};
