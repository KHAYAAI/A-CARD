import { randomBytes } from "node:crypto";

/**
 * "Attach your own card": a SANDBOX prototype of a card vault.
 *
 * The customer attaches a card they already have. The agent never sees it: it
 * asks A-CARD to pay, A-CARD's rules decide, the customer approves larger
 * purchases (a passkey or Face ID prompt in production), and only then does the
 * vault release a single-use stand-in credential bound to that merchant and
 * amount. The real card is swapped in at checkout.
 *
 * Safety in the sandbox: only published TEST card numbers are accepted, and the
 * full number is never stored, not even in memory: only brand and last four.
 * A production vault would hold card data with a PCI-certified vault provider
 * or use Visa / Mastercard agent network tokens; this file does neither.
 */
export type Brand = "visa" | "mastercard" | "amex";

/** Published test numbers from the card networks' and processors' documentation. Nothing else is accepted. */
const TEST_CARDS: Record<string, Brand> = {
  "4242424242424242": "visa",
  "4000056655665556": "visa",
  "4111111111111111": "visa",
  "5555555555554444": "mastercard",
  "2223003122003222": "mastercard",
  "5200828282828210": "mastercard",
  "378282246310005": "amex",
  "371449635398431": "amex",
};
export const EXAMPLE_TEST_CARD = "4242 4242 4242 4242";

export class VaultError extends Error {}

export interface VaultCard {
  id: string;
  brand: Brand;
  last4: string;
  expMonth: number;
  expYear: number;
  holder: string;
  addedAt: string;
}

export interface VaultSettings {
  /** Purchases at or under this are approved without a prompt (cents). 0 = always ask. */
  autoApproveCents: number;
  /** Purchases over this are refused outright (cents). */
  maxPerPurchaseCents: number;
}

export interface StandIn {
  /** Masked stand-in number: the only card number the merchant (and never the agent) sees. */
  masked: string;
  boundMerchant: string;
  boundAmountCents: number;
  expiresAt: string;
  used: boolean;
}

export interface VaultPurchase {
  id: string;
  cardId?: string;
  cardLabel?: string;
  merchant: string;
  category: string;
  amountCents: number;
  currency: "ZAR" | "USD";
  status: "paid" | "awaiting_approval" | "declined" | "denied";
  reason?: string;
  standIn?: StandIn;
  createdAt: string;
  decidedAt?: string;
}

const luhn = (n: string) => {
  let sum = 0;
  for (let i = 0; i < n.length; i++) {
    let d = Number(n[n.length - 1 - i]);
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
};
const id = (p: string) => `${p}_${randomBytes(6).toString("hex")}`;
const label = (c: VaultCard) => `${c.brand === "amex" ? "Amex" : c.brand === "visa" ? "Visa" : "Mastercard"} •••• ${c.last4}`;

export class SandboxVault {
  cards: VaultCard[] = [];
  purchases: VaultPurchase[] = [];
  settings: VaultSettings = { autoApproveCents: 20_000, maxPerPurchaseCents: 200_000 };

  attach(input: { number: string; exp: string; holder: string }): VaultCard {
    const number = String(input.number ?? "").replace(/[\s-]/g, "");
    if (!/^\d{13,19}$/.test(number) || !luhn(number)) throw new VaultError("That isn't a valid card number.");
    const brand = TEST_CARDS[number];
    if (!brand) throw new VaultError(`The sandbox only accepts published test card numbers, such as ${EXAMPLE_TEST_CARD}. Never enter a real card here.`);
    const m = /^(\d{1,2})\s*\/\s*(\d{2}|\d{4})$/.exec(String(input.exp ?? "").trim());
    if (!m) throw new VaultError("Expiry must look like MM/YY.");
    const expMonth = Number(m[1]), expYear = m[2]!.length === 2 ? 2000 + Number(m[2]) : Number(m[2]);
    const now = new Date();
    if (expMonth < 1 || expMonth > 12 || expYear < now.getUTCFullYear() || (expYear === now.getUTCFullYear() && expMonth < now.getUTCMonth() + 1)) throw new VaultError("That card has expired.");
    if (this.cards.length >= 3) throw new VaultError("The sandbox holds up to three cards.");
    const holder = String(input.holder ?? "").trim().slice(0, 60) || "Card holder";
    // The full number goes out of scope here: only brand and last four are kept.
    const card: VaultCard = { id: id("vcard"), brand, last4: number.slice(-4), expMonth, expYear, holder, addedAt: now.toISOString() };
    this.cards.push(card);
    return card;
  }

  remove(cardId: string) {
    const i = this.cards.findIndex((c) => c.id === cardId);
    if (i < 0) throw new VaultError("No such card.");
    this.cards.splice(i, 1);
  }

  setSettings(s: Partial<VaultSettings>) {
    const ok = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0;
    if (s.autoApproveCents !== undefined) { if (!ok(s.autoApproveCents)) throw new VaultError("Auto-approve must be zero or more."); this.settings.autoApproveCents = s.autoApproveCents; }
    if (s.maxPerPurchaseCents !== undefined) { if (!ok(s.maxPerPurchaseCents) || s.maxPerPurchaseCents === 0) throw new VaultError("The per-purchase limit must be above zero."); this.settings.maxPerPurchaseCents = s.maxPerPurchaseCents; }
    if (this.settings.autoApproveCents > this.settings.maxPerPurchaseCents) this.settings.autoApproveCents = this.settings.maxPerPurchaseCents;
  }

  /** The agent asks to pay. A-CARD's rules decide before any credential exists. */
  request(input: { cardId?: string; merchant: string; category: string; amountCents: number; currency?: "ZAR" | "USD"; blockedCategories: string[] }): VaultPurchase {
    const card = input.cardId ? this.cards.find((c) => c.id === input.cardId) : this.cards[0];
    const p: VaultPurchase = {
      id: id("vpur"), cardId: card?.id, cardLabel: card ? label(card) : undefined, merchant: input.merchant.slice(0, 80), category: input.category,
      amountCents: input.amountCents, currency: input.currency ?? "ZAR", status: "declined", createdAt: new Date().toISOString(),
    };
    this.purchases.unshift(p);
    if (!card) return this.decline(p, input.cardId ? "card_not_found" : "no_card_attached");
    if (!Number.isSafeInteger(p.amountCents) || p.amountCents <= 0) return this.decline(p, "invalid_amount");
    if (p.currency !== "ZAR") return this.decline(p, "currency_not_supported_in_sandbox");
    if (input.blockedCategories.includes(p.category)) return this.decline(p, "merchant_category_blocked_by_policy");
    if (p.amountCents > this.settings.maxPerPurchaseCents) return this.decline(p, "over_per_purchase_limit");
    if (p.amountCents > this.settings.autoApproveCents) { p.status = "awaiting_approval"; return p; }
    return this.complete(p);
  }

  pending() {
    return this.purchases.filter((p) => p.status === "awaiting_approval").map((p) => ({ id: p.id, merchant: p.merchant, amount: p.amountCents, currency: p.currency, card: p.cardLabel }));
  }

  /** The customer's decision (a passkey prompt in production). Only the customer can call this, never the agent. */
  decide(purchaseId: string, approve: boolean): VaultPurchase {
    const p = this.purchases.find((x) => x.id === purchaseId);
    if (!p || p.status !== "awaiting_approval") throw new VaultError("Not a purchase waiting for approval.");
    p.decidedAt = new Date().toISOString();
    if (!approve) { p.status = "denied"; p.reason = "denied_by_card_holder"; return p; }
    if (!this.cards.some((c) => c.id === p.cardId)) return this.decline(p, "card_removed");
    return this.complete(p);
  }

  /**
   * A merchant charges a stand-in. Single use, bound to one merchant and the approved amount, and short-lived.
   * Public so tests (and the sandbox) can show what happens when a merchant tries to charge more.
   */
  charge(purchaseId: string, merchant: string, amountCents: number): { ok: boolean; reason?: string } {
    const p = this.purchases.find((x) => x.id === purchaseId);
    const s = p?.standIn;
    if (!p || !s) return { ok: false, reason: "no_stand_in" };
    if (s.used) return { ok: false, reason: "stand_in_already_used" };
    if (Date.parse(s.expiresAt) < Date.now()) return { ok: false, reason: "stand_in_expired" };
    if (merchant !== s.boundMerchant) return { ok: false, reason: "stand_in_wrong_merchant" };
    if (amountCents > s.boundAmountCents) return { ok: false, reason: "stand_in_amount_too_high" };
    s.used = true;
    return { ok: true };
  }

  private complete(p: VaultPurchase): VaultPurchase {
    const tail = String(randomBytes(2).readUInt16BE(0) % 10_000).padStart(4, "0");
    p.standIn = { masked: `4000 00•• •••• ${tail}`, boundMerchant: p.merchant, boundAmountCents: p.amountCents, expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(), used: false };
    // Simulated checkout: the merchant charges the stand-in; the vault swaps in the real card behind it.
    const r = this.charge(p.id, p.merchant, p.amountCents);
    if (!r.ok) return this.decline(p, r.reason!);
    p.status = "paid";
    return p;
  }

  private decline(p: VaultPurchase, reason: string): VaultPurchase {
    p.status = "declined";
    p.reason = reason;
    return p;
  }
}
