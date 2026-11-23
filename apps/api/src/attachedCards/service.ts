import { randomUUID } from "node:crypto";
import type { CardDisplay, CardVaultProvider, CheckoutTarget, ReleaseResult } from "./provider.js";
import { MemoryAttachedCardStore, type AttachedCardStore } from "./store.js";

export interface AttachedCard extends CardDisplay {
  id: string;
  accountHolderId: string;
  /** The provider's reference. Never a card number. Not returned by the API. */
  providerRef: string;
  label?: string;
  createdBy: string;
  createdAt: string;
}

export interface AttachedCardSettings {
  /** At or under this (minor units) no passkey is needed. 0 = always ask. */
  autoApproveUnder: number;
  /** Over this (minor units) a purchase is refused outright. */
  maxPerPurchase: number;
}

export type PurchaseStatus = "awaiting_approval" | "releasing" | "paid" | "declined" | "denied" | "failed";

export interface AttachedPurchase {
  id: string;
  accountHolderId: string;
  cardId: string;
  amount: number;
  currency: string;
  target: CheckoutTarget;
  status: PurchaseStatus;
  reason?: string;
  release?: ReleaseResult;
  requestedBy: string;
  approvedBy?: string;
  createdAt: string;
  decidedAt?: string;
}

export class AttachedCardError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409 | 502, readonly code: string, message: string) {
    super(message);
  }
}

const DEFAULTS: AttachedCardSettings = { autoApproveUnder: 0, maxPerPurchase: 500_000 };

/**
 * Rules and records for attached cards. Storage is a store (memory or Postgres);
 * the claim step makes approval single-winner even across API instances.
 */
export class AttachedCardService {
  constructor(
    readonly provider: CardVaultProvider,
    private readonly blockedCategories: (accountHolderId: string) => Promise<string[]>,
    readonly store: AttachedCardStore = new MemoryAttachedCardStore(),
  ) {}

  async attach(accountHolderId: string, providerRef: string, createdBy: string, label?: string): Promise<AttachedCard> {
    if (!/^[\w.:-]{6,200}$/.test(providerRef)) throw new AttachedCardError(400, "invalid_reference", "provider_ref must be the reference your card vault returned");
    let display: CardDisplay;
    try {
      display = await this.provider.describe(providerRef);
    } catch {
      throw new AttachedCardError(400, "invalid_reference", "the card vault does not recognise that reference");
    }
    const now = new Date();
    if (display.expYear < now.getUTCFullYear() || (display.expYear === now.getUTCFullYear() && display.expMonth < now.getUTCMonth() + 1)) {
      throw new AttachedCardError(400, "card_expired", "that card has expired");
    }
    if ((await this.store.listCards(accountHolderId)).length >= 10) throw new AttachedCardError(409, "too_many_cards", "an account can attach up to 10 cards");
    const card: AttachedCard = { id: `acd_${randomUUID()}`, accountHolderId, providerRef, ...display, label: label?.slice(0, 60), createdBy, createdAt: now.toISOString() };
    await this.store.insertCard(card);
    return card;
  }

  list(accountHolderId: string) {
    return this.store.listCards(accountHolderId);
  }

  async remove(accountHolderId: string, cardId: string) {
    const card = await this.store.getCard(cardId);
    if (!card || card.accountHolderId !== accountHolderId) throw new AttachedCardError(404, "not_found", "attached card not found");
    await this.provider.remove(card.providerRef);
    await this.store.deleteCard(cardId);
  }

  async getSettings(accountHolderId: string): Promise<AttachedCardSettings> {
    return (await this.store.getSettings(accountHolderId)) ?? { ...DEFAULTS };
  }

  async setSettings(accountHolderId: string, patch: Partial<AttachedCardSettings>) {
    const cur = await this.getSettings(accountHolderId);
    const next = { autoApproveUnder: patch.autoApproveUnder ?? cur.autoApproveUnder, maxPerPurchase: patch.maxPerPurchase ?? cur.maxPerPurchase };
    if (!Number.isSafeInteger(next.autoApproveUnder) || next.autoApproveUnder < 0) throw new AttachedCardError(400, "invalid_settings", "auto_approve_under must be zero or more");
    if (!Number.isSafeInteger(next.maxPerPurchase) || next.maxPerPurchase <= 0) throw new AttachedCardError(400, "invalid_settings", "max_per_purchase must be above zero");
    if (next.autoApproveUnder > next.maxPerPurchase) next.autoApproveUnder = next.maxPerPurchase;
    await this.store.putSettings(accountHolderId, next);
    return next;
  }

  /** An agent (or a person) asks to pay. Rules run before anything is released. */
  async request(accountHolderId: string, input: { cardId?: string; amount: number; currency: string; target: CheckoutTarget }, requestedBy: string): Promise<AttachedPurchase> {
    const cards = await this.store.listCards(accountHolderId);
    const card = input.cardId ? cards.find((c) => c.id === input.cardId) : cards[0];
    const p: AttachedPurchase = {
      id: `apu_${randomUUID()}`, accountHolderId, cardId: card?.id ?? "", amount: input.amount, currency: input.currency, target: input.target,
      status: "declined", requestedBy, createdAt: new Date().toISOString(),
    };
    const settings = await this.getSettings(accountHolderId);
    const reason = !card ? (input.cardId ? "card_not_found" : "no_card_attached")
      : !Number.isSafeInteger(p.amount) || p.amount <= 0 ? "invalid_amount"
      : (await this.blockedCategories(accountHolderId)).includes(p.target.merchantCategory) ? "merchant_category_blocked_by_policy"
      : p.amount > settings.maxPerPurchase ? "over_per_purchase_limit"
      : undefined;
    if (reason) { p.reason = reason; await this.store.insertPurchase(p); return p; }
    if (p.amount > settings.autoApproveUnder) { p.status = "awaiting_approval"; await this.store.insertPurchase(p); return p; }
    p.status = "releasing";
    p.approvedBy = "auto_approve_rule";
    p.decidedAt = p.createdAt;
    await this.store.insertPurchase(p);
    return this.releaseFor(p, card!);
  }

  async get(accountHolderId: string, purchaseId: string): Promise<AttachedPurchase> {
    const p = await this.store.getPurchase(purchaseId);
    if (!p || p.accountHolderId !== accountHolderId) throw new AttachedCardError(404, "not_found", "purchase not found");
    return p;
  }

  listPurchases(accountHolderId: string) {
    return this.store.listPurchases(accountHolderId);
  }

  /** Called only after a verified passkey assertion from a person (see routes). Single winner, even across instances. */
  async approve(accountHolderId: string, purchaseId: string, approvedBy: string): Promise<AttachedPurchase> {
    const before = await this.get(accountHolderId, purchaseId);
    if (!(await this.store.claim(purchaseId, "releasing", approvedBy, new Date().toISOString()))) {
      const now = await this.get(accountHolderId, purchaseId);
      throw new AttachedCardError(409, "not_pending", `purchase is ${now.status}`);
    }
    const p = await this.get(accountHolderId, before.id);
    const card = await this.store.getCard(p.cardId);
    if (!card) { p.status = "declined"; p.reason = "card_removed"; await this.store.updatePurchase(p); return p; }
    return this.releaseFor(p, card);
  }

  async deny(accountHolderId: string, purchaseId: string, by: string): Promise<AttachedPurchase> {
    await this.get(accountHolderId, purchaseId);
    if (!(await this.store.claim(purchaseId, "denied", by, new Date().toISOString()))) {
      const now = await this.get(accountHolderId, purchaseId);
      throw new AttachedCardError(409, "not_pending", `purchase is ${now.status}`);
    }
    const p = await this.get(accountHolderId, purchaseId);
    p.reason = "denied_by_card_holder";
    await this.store.updatePurchase(p);
    return p;
  }

  private async releaseFor(p: AttachedPurchase, card: AttachedCard): Promise<AttachedPurchase> {
    try {
      const r = await this.provider.release({ providerRef: card.providerRef, purchaseId: p.id, amount: p.amount, currency: p.currency, target: p.target });
      if (r.boundAmount !== p.amount || r.boundMerchant !== p.target.merchantName) {
        p.status = "failed";
        p.reason = "provider_bound_mismatch";
      } else {
        p.release = r;
        p.status = r.delivered ? "paid" : "failed";
        if (!r.delivered) p.reason = "not_delivered";
      }
    } catch {
      p.status = "failed";
      p.reason = "provider_error";
    }
    await this.store.updatePurchase(p);
    return p;
  }
}

/** What the API returns for a card: never the provider reference. */
export const publicCard = (c: AttachedCard) => ({ id: c.id, brand: c.brand, last4: c.last4, exp_month: c.expMonth, exp_year: c.expYear, label: c.label ?? null, created_at: c.createdAt });
export const publicPurchase = (p: AttachedPurchase) => ({
  id: p.id, card_id: p.cardId || null, amount: p.amount, currency: p.currency, merchant_name: p.target.merchantName, merchant_category: p.target.merchantCategory,
  checkout_method: p.target.method, status: p.status, reason: p.reason ?? null, approved_by: p.approvedBy ?? null,
  release: p.release ? { release_ref: p.release.releaseRef, charge_ref: p.release.chargeRef ?? null, bound_amount: p.release.boundAmount, bound_merchant: p.release.boundMerchant, expires_at: p.release.expiresAt } : null,
  created_at: p.createdAt, decided_at: p.decidedAt ?? null,
});
