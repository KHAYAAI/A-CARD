import type { Block } from "./model.js";
import { KEYWORDS } from "./catalogue.js";
import { FEES, feeFor } from "./fees.js";
import { all, call, held, last, lastUserText, rands, say, units6, usd, verdict, type Ctx, type Results } from "./plan.js";

/**
 * The demo agent's free-form mode: no model, no key. It reads ordinary
 * English, works out what the visitor wants from a fixed set of things the
 * platform can do, and makes the real tool calls for it, using the results
 * to decide the next call. It is a rule-based interpreter, not a language
 * model: anything outside the platform gets an honest "I can't do that here"
 * and a pointer to live Claude.
 */

/* ---------- reading amounts, categories and names out of a sentence ---------- */

const CATS: Array<[RegExp, string, string]> = [
  [/\b(fuel|petrol|diesel|garage)\b/i, "5541", "fuel"],
  [/\b(groceries|grocery|supermarket)\b/i, "5411", "groceries"],
  [/\b(pharmacy|medicine|chemist)\b/i, "5912", "pharmacy"],
  [/\b(electronics|gadgets?|tv|television)\b/i, "5732", "electronics"],
  [/\b(office|stationery)\b/i, "5943", "office supplies"],
  [/\b(workwear|safety gear|ppe)\b/i, "5699", "workwear"],
  [/\b(cleaning)\b/i, "5169", "cleaning supplies"],
  [/\b(car parts|auto parts|mechanic)\b/i, "5533", "auto parts"],
  [/\b(restaurants?|catering|takeaway)\b/i, "5812", "restaurants"],
  [/\b(building|construction|hardware|cement|bricks)\b/i, "5211", "building supplies"],
  [/\b(software|saas|subscriptions?)\b/i, "5734", "software"],
  [/\b(cloud|hosting)\b/i, "4816", "cloud"],
  [/\b(airline|flights?|airfare)\b/i, "4511", "airlines"],
  [/\b(advertising|ads)\b/i, "7311", "advertising"],
  [/\b(casino|gambling|betting)\b/i, "7995", "gambling"],
  [/\b(crypto|bitcoin)\b/i, "6051", "crypto"],
];
const MCC_NAME: Record<string, string> = Object.fromEntries(CATS.map(([, m, l]) => [m, l]));

const MONEY = /\bR\s?(\d{1,3}(?:[ ,]\d{3})+|\d+)(?:\.(\d{1,2}))?|(\d[\d ,]*)\s*(?:rand|zar)\b/gi;
const toCents = (m: RegExpMatchArray) => Math.round(parseFloat(((m[1] ?? m[3] ?? "0").replace(/[ ,]/g, "")) + "." + (m[2] ?? "0")) * 100);
const moneyAll = (t: string) => [...t.matchAll(MONEY)].map((m) => ({ cents: toCents(m), at: m.index ?? 0 }));
/** The first rand amount at or after the first match of `re`. */
const moneyAfter = (t: string, re: RegExp) => {
  const m = re.exec(t);
  if (!m) return undefined;
  return moneyAll(t.slice(m.index))[0]?.cents;
};
const usdCents = (t: string) => {
  const m = /\$\s?(\d+(?:\.\d{1,2})?)|(\d+(?:\.\d+)?)\s*(?:usd|dollars?)\b/i.exec(t);
  return m ? Math.round(parseFloat(m[1] ?? m[2]!) * 100) : undefined;
};
const asset6 = (t: string, asset: string) => {
  const m = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*${asset}\\b`, "i").exec(t);
  return m ? String(Math.round(parseFloat(m[1]!) * 1e6)) : undefined;
};
const merchantName = (t: string) => {
  const m = /\b(?:at|to|from|with)\s+((?:[A-Z][\w&'.-]*)(?:\s+(?:[A-Z&][\w&'.-]*|of|and|&))*)/.exec(t);
  return m?.[1]?.replace(/[.,]$/, "");
};
const catGuess = (t: string) => CATS.find(([re]) => re.test(t));
const quantity = (t: string) => {
  const m = /(?<![R$\d.,])\b(\d{1,5})\b(?![\d.,]*\s?(?:usdc|zarp|rand|zar|usd|%|am|pm|km|l\b))/i.exec(t.replace(/\bR\s?\d[\d ,.]*/gi, " "));
  return m ? Number(m[1]) : undefined;
};

/* ---------- what the visitor wants ---------- */

export type Intent =
  | { kind: "chat"; sub: "hi" | "thanks" | "help" }
  | { kind: "wallets" | "route" | "close" | "swap" | "send" | "create" | "pay" | "balance" | "approvals" | "spending" | "cards" | "refuse-approve" }
  | { kind: "shop"; buy: boolean }
  | { kind: "other" };

const STOP = new Set(("a an the of for to and or with from in on at my i we you me us can could would should please some any all best cheapest closest nearest fastest cheap " +
  "like want need get buy order find show browse search compare looking look price prices cost how much many is are do does have has got offer offers options option " +
  "supplier suppliers stock available availability deliver delivery delivered under below less than max maximum within budget up near around johannesburg jozi joburg gauteng " +
  "tomorrow today now asap this that these those it its be been will just also then so if when where what which who why there here yes no ok okay r zar rand").split(" "));

const singular = (w: string) =>
  /ies$/.test(w) ? w.slice(0, -3) + "y" : /(ss|us|is)$/.test(w) ? w : /(ches|shes|xes|zes|oes)$/.test(w) ? w.slice(0, -2) : /s$/.test(w) && w.length > 3 ? w.slice(0, -1) : w;
const noMoney = (t: string) => t.replace(/\bR\s?\d[\d ,.]*|\$\s?\d[\d,.]*|\d[\d ,]*\s*(?:rand|zar|usd|usdc|zarp)\b/gi, " ");
const tokens = (t: string) => [...new Set((noMoney(t).toLowerCase().match(/[a-z][a-z0-9'-]{2,}/g) ?? []).filter((w) => !STOP.has(w)).map(singular))];

export function classify(text: string): Intent {
  const t = text.trim();
  if (/^\s*(hi|hello|hey|howzit|yo|sawubona|good (morning|afternoon|evening))\b/i.test(t) && t.length < 40) return { kind: "chat", sub: "hi" };
  if (/^\s*(thanks|thank you|cheers|great|perfect|awesome|nice)\b/i.test(t)) return { kind: "chat", sub: "thanks" };
  if (/\b(help|what can you do|what do you do|how does this work|what can i ask|capabilities)\b/i.test(t)) return { kind: "chat", sub: "help" };
  if (/\b(close|cancel|delete|deactivate|freeze)\b.*\bcards?\b/i.test(t)) return { kind: "close" };
  if (/\b(swap|convert|exchange)\b/i.test(t) && /usdc|zarp/i.test(t)) return { kind: "swap" };
  if (/\b(send|transfer|pay|move)\b/i.test(t) && /usdc|crypto|on-?chain/i.test(t)) return { kind: "send" };
  if (/\b(how (should|can|do) i pay|which rail|best way to pay|cheapest way to pay|route|quote)\b/i.test(t) && (moneyAll(t).length > 0 || usdCents(t))) return { kind: "route" };
  if (/\b(pay|spend|charge|buy|purchase|put)\b/i.test(t) && moneyAll(t).length > 0 && (merchantName(t) || catGuess(t))) return { kind: "pay" };
  if (/\b(create|make|issue|open|set up|new|give me|get me)\b[^.?!]*\bcards?\b/i.test(t) || /\b(want|need|have)\b[^.?!]*\b(a|an|new)\b[^.?!]*\bcard\b/i.test(t)) return { kind: "create" };
  if (/\b(approve|authori[sz]e|confirm|allow)\b[^.?!]*\b(it|this|that|them|the (charge|payment|transfer|purchase))\b/i.test(t) && !/\b(i|i've|ive) (approved|authori[sz]ed)\b/i.test(t)) return { kind: "refuse-approve" };
  if (/\b(crypto|linked|embedded|external|metamask)\b[^.?!]*\bwallets?\b|\bwallets?\b[^.?!]*\b(linked|embedded|addresses|address)\b|\bmy wallets\b|\bwhich wallets\b|\bwallet addresses\b/i.test(t) && !/\b(send|transfer|swap|balance)\b/i.test(t)) return { kind: "wallets" };
  if (/\b(balance|how much (money|cash|usdc|zarp|crypto|zar|rand)|funds|what do i have|money left|left (in|on))\b/i.test(t)) return { kind: "balance" };
  if (/\b(pending|waiting|outstanding|any)\b[^.?!]*\bapprovals?\b|\bapprovals?\b[^.?!]*\b(pending|waiting)\b/i.test(t)) return { kind: "approvals" };
  if (/\b(spent|spending|spend so far|transactions?|history|recent (charges|payments|activity)|declined|where did (my )?money)\b|\bwhat (did|have) (i|we) (spend|buy|pay|purchase)\b|\bhow much (did|have) (i|we)\b/i.test(t)) return { kind: "spending" };
  if (/\b(list|show|see|what|which|how many|view|my)\b[^.?!]*\bcards?\b/i.test(t)) return { kind: "cards" };
  if (/\b(buy|get|order|purchase|find|show|browse|search|compare|need|want|looking for|where can i|how much|price|cheapest|do you have|have you got|is there|any)\b/i.test(t) && tokens(t).length > 0)
    return { kind: "shop", buy: /\b(buy|order|purchase|checkout|get me|i'?ll take)\b/i.test(t) };
  // A bare product mention ("gloves for my workers") is a search.
  if (KEYWORDS.some((k) => k.re.test(noMoney(t)))) return { kind: "shop", buy: false };
  return { kind: "other" };
}

/* ---------- texts ---------- */

export const HELP = `I'm the scripted demo agent: there's no AI model behind me, but I understand plain requests about this platform and every action I take is a real call to it, on test money. Try asking me to:

• Find or buy something from the catalogue: “find A4 paper”, “buy 10 hard hats”, “cheapest bread”, “gloves under R60”
• Make a card: “create a R500 card for fuel, single-use”, “a USD card for software with approval above $100”
• Pay a merchant: “spend R250 at Fresh Basket Market”, “pay R90 at a casino”
• Look at your account: “what are my crypto wallets?”, “how should I pay $5 to https://…”, “what's my balance?”, “show my cards”, “what have I spent?”, “any approvals waiting?”, “close my cards”
• Use the wallet: “send 8 USDC to supplier-1”, “swap 3 USDC to ZARP”
• Pay an API per call with x402

For open-ended requests, anything beyond this platform, add your own Claude key (top right) and a live agent takes over.`;

const OUT_OF_SCOPE = (t: string) =>
  `I'm the scripted demo agent, and I can't help with “${t.length > 80 ? t.slice(0, 77) + "…" : t}” here: I only handle shopping from the catalogue, cards and limits, payments and approvals, and the wallet. Add your own Claude key (top right) for a live agent that can take open-ended requests, or ask me for “help” to see what I can do.`;

/* ---------- the interpreter ---------- */

const LAT = -26.2309, LNG = 28.1772;
const money0 = (o: any, cur = "ZAR") => (cur === "USD" ? usd(Number(o ?? 0)) : rands(Number(o ?? 0)));

/** The things the visitor asked for, one per product ("milk and eggs" is two). */
interface Want { text: string; list: string[]; hit?: (typeof KEYWORDS)[number]; qty?: number }
function wants(t: string): Want[] {
  const pieces = t.split(/\s*(?:,|;|&|\bplus\b|\band\b|\bas well as\b)\s*/i).map((x) => x.trim()).filter((x) => tokens(x).length > 0);
  const segs = pieces.length > 1 ? pieces : [t];
  return segs.map((seg) => {
    const hit = KEYWORDS.map((x) => ({ x, at: seg.search(x.re) })).filter((h) => h.at >= 0).sort((a, b) => a.at - b.at)[0]?.x;
    const toks = tokens(seg);
    const bigrams = toks.slice(0, -1).map((w, i) => `${w} ${toks[i + 1]}`);
    const list = [toks.length > 1 ? toks.slice(0, 4).join(" ") : undefined, ...bigrams, ...[...toks].reverse(), hit?.query].filter((x): x is string => !!x);
    return { text: seg, list: [...new Set(list)].slice(0, 5), hit, qty: quantity(seg) };
  }).filter((w) => w.list.length > 0);
}

function chooseOffer(offers: any[], t: string) {
  if (/\bcheapest|lowest price|least expensive\b/i.test(t)) return [...offers].sort((a, b) => a.totalCents - b.totalCents)[0];
  if (/\b(closest|nearest)\b/i.test(t)) return [...offers].sort((a, b) => (a.distanceKm ?? 1e9) - (b.distanceKm ?? 1e9))[0];
  if (/\b(fastest|asap|today|same day)\b/i.test(t)) return [...offers].sort((a, b) => a.leadTimeDays - b.leadTimeDays)[0];
  return offers[0];
}

/** One order: what is bought from whom, then the fees. Paid from a single card. */
export interface Basket { groups: Array<{ desc: string; merchant: string; items: number; mcc: string }>; fees: number; feeMcc: string }

/** Pay a basket: one card for the whole order, each supplier, then the fees, then close it. Stops cleanly on a hold or a decline. */
function runBasket(b: Basket, r: Results, intro: string): Block[] {
  const items = b.groups.reduce((a, g) => a + g.items, 0);
  const cards = all(r, "create_card"), pays = all(r, "pay_checkout"), closes = all(r, "close_card");
  const cats = [...new Set([...b.groups.map((g) => g.mcc), ...(b.fees ? [b.feeMcc] : [])])];
  if (!cards.length)
    return [say(intro), call("create_card", { label: `${b.groups.map((g) => g.merchant).join(" + ")}`.slice(0, 40), single_use: false, total_limit: items + b.fees, per_transaction_limit: Math.max(...b.groups.map((g) => g.items)), allowed_merchant_categories: cats })];
  const id = cards[0]!.output?.id;
  if (!id) return [say(`The card wasn't created: ${cards[0]!.raw.replace(/^Error\s*—\s*/, "").slice(0, 160)}`)];
  const bad = pays.findIndex((p) => verdict(p) !== "approved");
  if (bad >= 0) {
    const what = bad < b.groups.length ? `${rands(b.groups[bad]!.items)} at ${b.groups[bad]!.merchant}` : `the ${rands(b.fees)} fees`;
    if (held(pays[bad])) return [say(`${what} is above a threshold, so A-CARD is holding it for your approval. I can't approve it myself. Approve it in the Approvals panel, then tell me “I approved it” and I'll retry once.${bad > 0 ? ` The earlier payment${bad > 1 ? "s were" : " was"} already approved.` : ""}`)];
    if (!closes.length) return [call("close_card", { card_id: id })];
    return [say(`A-CARD ${verdict(pays[bad])} for ${what}. I won't try another card to get around that. The card is closed, so nothing more can be charged.${bad > 0 ? ` ${bad} earlier payment${bad > 1 ? "s" : ""} went through.` : ""}`)];
  }
  if (pays.length < b.groups.length) { const g = b.groups[pays.length]!; return [call("pay_checkout", { card_id: id, amount: g.items, merchant_name: g.merchant, merchant_category: g.mcc })]; }
  if (b.fees > 0 && pays.length === b.groups.length) return [say(`${b.groups.length === 1 ? "The supplier is" : "All suppliers are"} paid. Now the fees.`), call("pay_checkout", { card_id: id, amount: b.fees, merchant_name: "a·card fees", merchant_category: b.feeMcc })];
  if (!closes.length) return [call("close_card", { card_id: id })];
  return [say(`Done. ${b.groups.map((g) => `${g.desc} from ${g.merchant}: ${rands(g.items)}`).join("; ")}${b.fees ? `; ${rands(b.fees)} in fees` : ""}. One card covered the order and it's now closed. See Track spending for the record.`)];
}

/** The cart's "Checkout:" message: one or more "buy … from … for R… (merchant category …)" groups, then the fees. */
export function checkout(text: string, r: Results): Block[] {
  const groups = [...text.matchAll(/buy (.+?) from (.+?) for R([\d.]+) \(merchant category (\w+)\)/gi)].map((m) => ({ desc: m[1]!, merchant: m[2]!, items: Math.round(Number(m[3]) * 100), mcc: m[4]! }));
  if (!groups.length) return [say("I couldn't read that cart. Try adding the item again.")];
  const f = /order fee R([\d.]+) and card processing R([\d.]+) \(fees category (\w+)\)/i.exec(text);
  const b: Basket = { groups, fees: f ? Math.round((Number(f[1]) + Number(f[2])) * 100) : 0, feeMcc: f?.[3] ?? FEES.mcc };
  const total = b.groups.reduce((a, g) => a + g.items, 0) + b.fees;
  return runBasket(b, r, `Checking out ${groups.length === 1 ? "" : `${groups.length} suppliers, `}${rands(total - b.fees)}${b.fees ? ` plus ${rands(b.fees)} in fees` : ""}. I'll create one card capped at exactly ${rands(total)} and limited to the merchants' categories${b.fees ? " and the fee category" : ""}.`);
}

function shop(t: string, r: Results, buy: boolean): Block[] {
  const ws = wants(t);
  if (!ws.length) return [say(`What would you like me to find? For example “find A4 paper”, “buy 10 hard hats” or “milk and eggs”.`)];
  const budget = moneyAfter(t, /\b(under|below|less than|max(?:imum)?|within|up to)\b/i);
  const lead = /\b(today|same day|now|asap)\b/i.test(t) ? 0 : /\b(tomorrow|next day)\b/i.test(t) ? 1 : undefined;
  const args = (w: Want, q: string) => ({ query: q, quantity: w.qty ?? (w.hit && (q.includes(w.hit.query.split(" ")[0]!) || w.hit.query.includes(q)) ? w.hit.quantity : 1), lat: LAT, lng: LNG, radius_km: 80, limit: 8, ...(budget ? { max_total_cents: budget } : {}), ...(lead !== undefined ? { max_lead_time_days: lead } : {}) });

  // Replay the searches so far, item by item, to see where each product stands and what to search next.
  const finds = all(r, "find_offers");
  let used = 0;
  const state = ws.map((w) => {
    let offers: any[] | undefined, query = "", tried = 0;
    while (!offers && tried < w.list.length && used < finds.length) {
      const f = finds[used++]!;
      tried++;
      const o: any[] = f.output?.offers ?? [];
      if (o.length) { offers = o; query = f.input.query; }
    }
    return { w, offers, query, tried };
  });
  const pending = state.find((x) => !x.offers && x.tried < x.w.list.length);
  if (pending) {
    const q = pending.w.list[pending.tried]!;
    const first = used === 0;
    const label = ws.length > 1 ? `“${pending.w.list[0]}”` : `“${q}”`;
    return [say(first ? `Searching A-MERCHANT near Johannesburg for ${ws.length > 1 ? ws.map((w) => `“${w.list[0]}”`).join(" and ") : `“${q}”`}${budget ? `, each under ${rands(budget)}` : ""}.` : pending.tried === 0 ? `Now ${label}.` : `Nothing for “${pending.w.list[pending.tried - 1]}”. Trying “${q}”.`), call("find_offers", args(pending.w, q))];
  }
  const foundItems = state.filter((x) => x.offers);
  const missing = state.filter((x) => !x.offers).map((x) => `“${x.w.list[0]}”`);
  if (!foundItems.length)
    return [say(`I couldn't find that from a verified supplier${budget ? ` under ${rands(budget)}` : ""}. The catalogue covers groceries, pharmacy, electronics, office supplies, workwear and safety, cleaning, auto parts, catering, building materials, fuel and tyres. Try simpler words, or add your own Claude key (top right) for a live agent.`)];
  const missNote = missing.length ? ` I couldn't find ${missing.join(" or ")}.` : "";
  if (!buy)
    return [say(`${foundItems.map((x) => `${x.offers!.length} supplier${x.offers!.length === 1 ? "" : "s"} for “${x.query}”`).join(", ")}, ranked by price, distance and how fresh their stock count is.${missNote} Tap “Add” to put what you want in your cart, then check out and I'll pay with one card scoped to the order.`)];

  const picks = foundItems.map((x) => { const o = chooseOffer(x.offers!, t); return { o, merchant: o.merchant?.name ?? "Supplier", mcc: o.merchant?.merchantCategoryCode ?? "5999", items: o.totalCents as number, desc: `${o.quantity} × ${o.item?.name}` }; });
  const byMerchant = new Map<string, { desc: string[]; merchant: string; items: number; mcc: string }>();
  for (const p of picks) { const g = byMerchant.get(p.merchant) ?? { desc: [] as string[], merchant: p.merchant, items: 0, mcc: p.mcc as string }; g.desc.push(p.desc); g.items += p.items; byMerchant.set(p.merchant, g); }
  const groups = [...byMerchant.values()].map((g) => ({ desc: g.desc.join(" and "), merchant: g.merchant, items: g.items, mcc: g.mcc }));
  const items = groups.reduce((a, g) => a + g.items, 0), f = feeFor(items);
  return runBasket({ groups, fees: f.total, feeMcc: FEES.mcc }, r, `${picks.length === 1 ? `${picks[0]!.desc} from ${picks[0]!.merchant} at ${rands(items)}` : `${picks.length} items from ${groups.length} supplier${groups.length === 1 ? "" : "s"} (${groups.map((g) => `${g.merchant} ${rands(g.items)}`).join(", ")})`}, plus ${rands(f.total)} in sandbox fees.${missNote} One card, capped at ${rands(items + f.total)} and limited to those merchants' categories and the fee category.`);
}

function createCard(t: string, r: Results): Block[] {
  const cards = all(r, "create_card");
  const usdCard = /\busd\b|\bdollars?\b|\$\s?\d/i.test(t);
  if (!cards.length) {
    const cents = usdCard ? usdCents(t) : moneyAfter(t, /\b(limit|up to|max(?:imum)?|budget|of|with)\b/i) ?? moneyAll(t)[0]?.cents;
    const perTx = moneyAfter(t, /\bper (charge|transaction|purchase|payment)\b/i);
    const threshold = (() => { const m = /approv\w*[^.?!]*?(?:above|over|from|at|of|for)\s*(?:R\s?|\$\s?)?(\d[\d ,.]*)/i.exec(t); return m ? Math.round(parseFloat(m[1]!.replace(/[ ,]/g, "")) * 100) : undefined; })();
    const cats = [...new Set(CATS.filter(([re]) => re.test(t)).map(([, m]) => m))];
    const label = (/\bfor\s+([a-z][\w &'-]{2,40}?)(?:,|\.| with| limited| that| and| using|$)/i.exec(t)?.[1] ?? "Agent card").replace(/\b(up to|with|limit|capped|max|needs|approval).*$/i, "").trim() || "Agent card";
    const reusable = /\b(reusable|recurring|monthly|multiple|several|many)\b/i.test(t);
    const input: any = { label: label.slice(0, 40), single_use: /\b(single.?use|one.?time|once|disposable)\b/i.test(t) || !reusable };
    if (usdCard) input.currency = "USD";
    if (cents) input.total_limit = cents;
    if (perTx) input.per_transaction_limit = perTx;
    if (threshold) input.approval_threshold = threshold;
    if (cats.length) input.allowed_merchant_categories = cats;
    return [say(`Creating the card: ${[input.single_use ? "single-use" : "reusable", usdCard ? "USD" : "ZAR", cents ? `${money0(cents, usdCard ? "USD" : "ZAR")} total` : "", threshold ? `approval from ${money0(threshold, usdCard ? "USD" : "ZAR")}` : "", cats.length ? `only ${cats.map((c) => MCC_NAME[c]).join(", ")}` : ""].filter(Boolean).join(", ")}.`), call("create_card", input)];
  }
  const o = cards[0]!.output;
  if (!o?.id) return [say(`The card wasn't created: ${cards[0]!.raw.replace(/^Error\s*—\s*/, "").slice(0, 160)}`)];
  const cur = o.currency ?? "ZAR";
  return [say(`Done. “${o.label}” •${o.last4} is ${o.status}: ${[o.singleUse ? "single-use" : "reusable", o.limits?.total ? `${money0(o.limits.total, cur)} total` : "", o.limits?.perTransaction ? `up to ${money0(o.limits.perTransaction, cur)} per charge` : "", o.approvalThreshold ? `you approve charges from ${money0(o.approvalThreshold, cur)}` : "", (o.allowedMerchantCategories ?? []).length ? `only ${o.allowedMerchantCategories.map((m: string) => MCC_NAME[m] ?? m).join(", ")}` : "any merchant category"].filter(Boolean).join(", ")}. It's in Manage cards.`)];
}

function payMerchant(t: string, r: Results): Block[] {
  const amount = moneyAfter(t, /\b(pay|spend|charge|buy|purchase|put)\b/i) ?? moneyAll(t)[0]!.cents;
  const name = merchantName(t) ?? (catGuess(t) ? `${catGuess(t)![2][0]!.toUpperCase()}${catGuess(t)![2].slice(1)} merchant` : "Merchant");
  const cat = catGuess(t);
  const mcc = cat?.[1] ?? "5999";
  const cards = all(r, "create_card"), pays = all(r, "pay_checkout");
  if (!cards.length) {
    const limit = moneyAfter(t, /\b(limit|up to|budget|capped)\b/i) ?? amount;
    return [say(`I'll create ${/\b(reusable|recurring)\b/i.test(t) ? "a reusable" : "a single-use"} card capped at ${rands(limit)}${cat ? `, limited to ${cat[2]}` : ""}, then pay ${rands(amount)} to ${name}.`), call("create_card", { label: `${name}`.slice(0, 40), single_use: !/\b(reusable|recurring)\b/i.test(t), total_limit: limit, per_transaction_limit: limit, ...(cat ? { allowed_merchant_categories: [mcc] } : {}) })];
  }
  const id = cards[0]!.output?.id;
  if (!pays.length) return [call("pay_checkout", { card_id: id, amount, merchant_name: name, merchant_category: mcc })];
  const p = pays[0]!;
  if (held(p)) return [say(`A-CARD is holding ${rands(amount)} at ${name} for your approval, and I can't approve it myself. Approve it in the Approvals panel, then tell me “I approved it” and I'll retry once.`)];
  const v = verdict(p);
  if (v === "approved") return [say(`Done. ${rands(amount)} paid to ${name}. See Track spending.`)];
  const why = /blocked_by_policy/.test(p.raw) ? " Your organisation's policy blocks that category on every card; you can change it under Policies." : /category_not_allowed/.test(p.raw) ? " The card is limited to a different category." : /limit/.test(p.raw) ? " That's over the card's limit." : "";
  return [say(`A-CARD ${v}.${why} I won't split the payment or try another card to get around it.`)];
}

function wallet(t: string, kind: "send" | "swap", r: Results): Block[] {
  if (kind === "send") {
    const amt = asset6(t, "usdc");
    if (!amt) return [say(`How much USDC should I send? For example “send 8 USDC to supplier-1”. Up to 10 USDC goes through, above that you approve, and above 50 is refused.`)];
    const to = /\bto\s+([\w.@:-]+)/i.exec(t)?.[1] ?? "recipient-1";
    const prev = last(r, "send_preview");
    if (!prev) return [say(`I'll preview sending ${units6(amt)} USDC to ${to}. Nothing moves until the policy allows it.`), call("send_preview", { wallet_id: "default", chain: "mock", asset: "USDC", to, amount: amt })];
    const p = prev.output;
    if (p?.decision === "allow") {
      if (!last(r, "send_execute")) return [call("send_execute", { preview_id: p.preview_id })];
      if (!last(r, "get_balances")) return [call("get_balances", { chain: "mock" })];
      return [say(`Sent ${units6(amt)} USDC to ${to}. Wallet now holds ${units6(last(r, "get_balances")!.output?.balances?.USDC)} USDC (mock chain, test funds).`)];
    }
    if (p?.decision === "require_approval") return [say(`${units6(amt)} USDC is above the auto-approve limit, so it's held for you (approval ${String(p.approval_id).slice(0, 8)}…). Approve it in the panel, then tell me “I approved it” and I'll execute it.`)];
    return [say(`The wallet refused ${units6(amt)} USDC: ${(p?.reasons ?? []).join(", ") || verdict(prev)}. I won't split it into smaller transfers to get around the limit.`)];
  }
  const rev = /zarp.*\b(to|into|for)\b.*usdc/i.test(t);
  const [assetIn, assetOut] = rev ? ["ZARP", "USDC"] : ["USDC", "ZARP"];
  const amt = asset6(t, assetIn);
  if (!amt) return [say(`How much ${assetIn} should I swap? For example “swap 3 USDC to ZARP”.`)];
  const q = last(r, "swap_quote");
  if (!q) return [say(`I'll quote a swap of ${units6(amt)} ${assetIn} to ${assetOut} in the on-chain wallet.`), call("swap_quote", { wallet_id: "default", chain: "mock", asset_in: assetIn, asset_out: assetOut, amount_in: amt })];
  if (q.output?.decision === "allow") {
    if (!last(r, "swap_execute")) return [say("The quote is within policy. Executing it."), call("swap_execute", { preview_id: q.output.preview_id })];
    if (!last(r, "get_balances")) return [call("get_balances", { chain: "mock" })];
    const b = last(r, "get_balances")!.output?.balances ?? {};
    return [say(`Swapped at the sandbox's fixed rate. Wallet now holds ${units6(b.USDC)} USDC and ${units6(b.ZARP)} ZARP (mock chain, test funds).`)];
  }
  if (q.output?.decision === "require_approval") return [say(`That swap needs your approval first. Approve it in the panel, then tell me “I approved it”.`)];
  const rs = (q.output?.reasons ?? []).join(", ") || verdict(q);
  return [say(`The wallet won't do that swap: ${rs}.${/asset_not_allowed/.test(rs) ? " The sandbox wallet only swaps USDC into ZARP." : /slippage/.test(rs) ? " That's beyond the 1% slippage limit." : ""}`)];
}

function account(kind: Intent["kind"], t: string, r: Results): Block[] {
  if (kind === "wallets") {
    const l = last(r, "list_crypto_wallets");
    if (!l) return [say("Looking at your linked crypto wallets."), call("list_crypto_wallets", {})];
    const ws: any[] = l.output?.wallets ?? [];
    if (!ws.length) return [say("No crypto wallets are linked yet.")];
    const line = (w: any) => `${w.chain[0].toUpperCase()}${w.chain.slice(1)} ${w.kind}${w.label ? ` “${w.label}”` : ""}${w.is_default ? " (default)" : ""} ${w.address.slice(0, 6)}…${w.address.slice(-4)}${w.usdc != null ? `, ${w.usdc} USDC` : ""}`;
    return [say(`You have ${ws.length} linked wallet${ws.length === 1 ? "" : "s"}: ${ws.map(line).join("; ")}. I can read these but not link, unlink or move them: that's yours to do on the Wallet screen. My own on-chain wallet is separate (ask “what's my balance?”).`)];
  }
  if (kind === "route") {
    const q = last(r, "quote_payment");
    const usd = usdCents(t), cents = usd ?? moneyAll(t)[0]?.cents;
    if (!cents) return [say("How much, and to whom? For example “how should I pay $5 to https://…/weather”.")];
    if (!q) {
      const url = /https?:\/\/\S+/.exec(t)?.[0], addr = /0x[0-9a-fA-F]{40}/.exec(t)?.[0];
      return [say(`I'll ask the payment rails what they'd do with ${usd ? usdCents(t) !== undefined ? `$${(cents / 100).toFixed(2)}` : "" : rands(cents)}. Quote only: nothing moves.`), call("quote_payment", { amount_cents: cents, currency: usd ? "USD" : "ZAR", purpose: "Payment", counterparty: url ?? addr ?? merchantName(t) ?? "Merchant" })];
    }
    const o = q.output;
    if (!o || typeof o !== "object" || !("scored" in o)) return [say(`The quote didn't come back: ${q.raw.replace(/^Error\s*—\s*/, "").slice(0, 160)}`)];
    const label: Record<string, string> = { card: "an A-CARD card", stablecoin: "a stablecoin transfer", x402: "an x402 payment" };
    if (!o.chosen_rail) return [say(`No rail can carry that as stated: ${o.rejected.map((x: any) => `${x.rail} (${x.reason})`).join("; ")}.`)];
    const best = o.scored[0];
    return [say(`Best is ${label[o.chosen_rail] ?? o.chosen_rail}: ${best.reasons.join(", ")}${best.finality?.kind === "reversal_window" ? `, reversible for ${best.finality.reversalWindowDays} days` : ""}.${o.scored.length > 1 ? ` Also possible: ${o.scored.slice(1).map((x: any) => label[x.rail] ?? x.rail).join(", ")}.` : ""}${o.rejected.length ? ` Not possible: ${o.rejected.map((x: any) => `${x.rail} (${x.reason})`).join("; ")}.` : ""} You can pay it from Wallet → Pay & routing.`)];
  }
  if (kind === "balance") {
    const w = last(r, "get_wallet"), b = last(r, "get_balances");
    if (!w) return [say("Checking your wallets."), call("get_wallet", {}), call("get_balances", { chain: "mock" })];
    const wl: any[] = Array.isArray(w.output) ? w.output : w.output?.wallets ?? (w.output?.wallet ? [w.output.wallet] : []);
    const fiat = wl.map((x) => `${money0(x.available, x.currency)} ${x.currency}${x.held ? ` (${money0(x.held, x.currency)} held)` : ""}`).join(" and ");
    const chain = b?.output?.balances ? Object.entries(b.output.balances).map(([a, v]) => `${units6(v as string)} ${a}`).join(" and ") : "";
    return [say(`Your fiat wallets hold ${fiat || "nothing yet"}${chain ? `, and the on-chain wallet holds ${chain} (mock chain, test funds)` : ""}. To top up fiat, use Add test funds on the Wallet screen.`)];
  }
  if (kind === "cards" || kind === "close") {
    const l = last(r, "list_cards");
    const asList = (o: any, key: string): any[] => (Array.isArray(o) ? o : o?.[key] ?? []);
    if (!l) return [say(kind === "close" ? "Let me see which cards are open." : "Here are your cards."), call("list_cards", {})];
    const cs: any[] = asList(l.output, "cards");
    if (kind === "cards") {
      if (!cs.length) return [say("You don't have any cards yet. Ask me to make one, for example “create a R500 card for fuel”.")];
      const open = cs.filter((c) => c.status === "active");
      return [say(`${cs.length} card${cs.length === 1 ? "" : "s"}, ${open.length} active. ${cs.slice(0, 6).map((c) => `“${c.label ?? "card"}” •${c.last4} (${c.status}${c.limits?.total ? `, ${money0(c.limits.total, c.currency)} total` : ""})`).join("; ")}${cs.length > 6 ? "; …" : ""}. Details are in Manage cards.`)];
    }
    const open = cs.filter((c) => c.status === "active");
    const GENERIC = new Set(["card", "cards", "agent", "payment", "single", "reusable"]);
    const named = open.filter((c) => String(c.label ?? "").toLowerCase().replace(/[^a-z0-9 ]/g, "").split(" ").some((w: string) => w.length > 3 && !GENERIC.has(w) && new RegExp(`\\b${w}`, "i").test(t)));
    const everyone = /\b(all|every|each|everything)\b|\bmy cards\b/i.test(t);
    const targets = everyone ? open : named;
    if (!open.length) return [say("There are no open cards to close.")];
    if (!targets.length) return [say(`Which card? You have ${open.map((c) => `“${c.label ?? "card"}” •${c.last4}`).join(", ")}. Say “close the ${open[0].label ?? "first"} card” or “close all my cards”.`)];
    const closed = new Set(all(r, "close_card").map((x) => x.input.card_id));
    const next = targets.find((c) => !closed.has(c.id));
    if (next) return [call("close_card", { card_id: next.id })];
    return [say(`Closed ${targets.length} card${targets.length === 1 ? "" : "s"}: ${targets.map((c) => `“${c.label ?? "card"}” •${c.last4}`).join(", ")}. Closed cards can't be charged again.`)];
  }
  const tx = last(r, "list_transactions");
  if (!tx) return [say(kind === "approvals" ? "Checking for charges waiting on you." : "Pulling up your transactions."), call("list_transactions", {})];
  const ts: any[] = Array.isArray(tx.output) ? tx.output : tx.output?.transactions ?? [];
  const wait = ts.filter((x) => /pending_human_approval|pending_approval/.test(String(x.declineReason ?? "")));
  if (kind === "approvals") return [say(wait.length ? `${wait.length} charge${wait.length === 1 ? " is" : "s are"} waiting for you: ${wait.map((x) => `${money0(x.amount, x.currency)} at ${x.merchantName}`).join("; ")}. Decide them on the Approvals screen.` : "Nothing is waiting for your approval.")];
  if (!ts.length) return [say("No transactions yet. Ask me to buy something or make a payment.")];
  const done = ts.filter((x) => x.status === "completed"), refused = ts.filter((x) => x.status === "declined" && !wait.includes(x));
  const total = done.reduce((a, x) => a + x.amount, 0);
  const reasons = [...new Set(refused.map((x) => x.declineReason))].filter(Boolean).slice(0, 3).join(", ");
  return [say(`${done.length} completed charge${done.length === 1 ? "" : "s"} totalling ${rands(total)}, ${wait.length} held for approval, ${refused.length} declined${reasons ? ` (${reasons})` : ""}. The full list, with reasons, is under Track spending.`)];
}

/** Returns the agent's next move for a free-form request, or undefined if the request isn't something it recognises. */
export function freeform(text: string, r: Results, _ctx: Ctx): Block[] {
  const it = classify(text);
  switch (it.kind) {
    case "chat":
      return [say(it.sub === "hi" ? `Hello! I'm the scripted demo agent. I can find and buy things from the catalogue, make cards with limits, pay merchants, and use the wallet, all on test money. Ask me for “help” for examples.` : it.sub === "thanks" ? "You're welcome. Ask me anything else about shopping, cards or the wallet." : HELP)];
    case "refuse-approve": return [say("Approvals are yours to decide, not mine: I can't approve my own charges or transfers. Open the Approvals screen (or the panel on the right), press Approve, then tell me “I approved it” and I'll retry exactly once.")];
    case "shop": return shop(text, r, it.buy);
    case "create": return createCard(text, r);
    case "pay": return payMerchant(text, r);
    case "send": return wallet(text, "send", r);
    case "swap": return wallet(text, "swap", r);
    case "wallets": case "route": case "balance": case "cards": case "close": case "spending": case "approvals": return account(it.kind, text, r);
    default: return [say(OUT_OF_SCOPE(text))];
  }
}
export { lastUserText };
