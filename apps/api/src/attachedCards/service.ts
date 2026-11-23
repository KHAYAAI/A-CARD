import { randomUUID } from "node:crypto";
import type { CardDisplay, CardVaultProvider, CheckoutTarget, ReleaseResult } from "./provider.js";

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

export type PurchaseStatus = "awaiting_approval" | "paid" | "declined" | "denied" | "failed";

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
 * Rules and records for attached cards. In memory for now; the store is small
 * and isolated so a Postgres version can replace it without touching the routes.
 */
export class AttachedCardService {
  private cards = new Map<string, AttachedCard>();
  private purchases = new Map<string, AttachedPurchase>();
  private settings = new Map<string, AttachedCardSettings>();

  constructor(
    readonly provider: CardVaultProvider,
    private readonly blockedCategories: (accountHolderId: string) => Promise<string[]>,
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
    if ([...this.cards.values()].filter((c) => c.accountHolderId === accountHolderId).length >= 10) {
      throw new AttachedCardError(409, "too_many_cards", "an account can attach up to 10 cards");
    }
    const card: AttachedCard = { id: `acd_${randomUUID()}`, accountHolderId, providerRef, ...display, label: label?.slice(0, 60), createdBy, createdAt: now.toISOString() };
    this.cards.set(card.id, card);
    return card;
  }

  list(accountHolderId: string) {
    return [...this.cards.values()].filter((c) => c.accountHolderId === accountHolderId);
  }

  async remove(accountHolderId: string, cardId: string) {
    const card = this.cards.get(cardId);
    if (!card || card.accountHolderId !== accountHolderId) throw new AttachedCardError(404, "not_found", "attached card not found");
    await this.provider.remove(card.providerRef);
    this.cards.delete(cardId);
  }

  getSettings(accountHolderId: string): AttachedCardSettings {
    return this.settings.get(accountHolderId) ?? { ...DEFAULTS };
  }

  setSettings(accountHolderId: string, patch: Partial<AttachedCardSettings>) {
    const next = { ...this.getSettings(accountHolderId), ...patch };
    if (!Number.isSafeInteger(next.autoApproveUnder) || next.autoApproveUnder < 0) throw new AttachedCardError(400, "invalid_settings", "auto_approve_under must be zero or more");
    if (!Number.isSafeInteger(next.maxPerPurchase) || next.maxPerPurchase <= 0) throw new AttachedCardError(400, "invalid_settings", "max_per_purchase must be above zero");
    if (next.autoApproveUnder > next.maxPerPurchase) next.autoApproveUnder = next.maxPerPurchase;
    this.settings.set(accountHolderId, next);
    return next;
  }

  /** An agent (or a person) asks to pay. Rules run before anything is released. */
  async request(accountHolderId: string, input: { cardId?: string; amount: number; currency: string; target: CheckoutTarget }, requestedBy: string): Promise<AttachedPurchase> {
    const cards = this.list(accountHolderId);
    const card = input.cardId ? cards.find((c) => c.id === input.cardId) : cards[0];
    const p: AttachedPurchase = {
      id: `apu_${randomUUID()}`, accountHolderId, cardId: card?.id ?? "", amount: input.amount, currency: input.currency, target: input.target,
      status: "declined", requestedBy, createdAt: new Date().toISOString(),
    };
    this.purchases.set(p.id, p);
    const settings = this.getSettings(accountHolderId);
    if (!card) return this.decline(p, input.cardId ? "card_not_found" : "no_card_attached");
    if (!Number.isSafeInteger(p.amount) || p.amount <= 0) return this.decline(p, "invalid_amount");
    if ((await this.blockedCategories(accountHolderId)).includes(p.target.merchantCategory)) return this.decline(p, "merchant_category_blocked_by_policy");
    if (p.amount > settings.maxPerPurchase) return this.decline(p, "over_per_purchase_limit");
    if (p.amount > settings.autoApproveUnder) {
      p.status = "awaiting_approval";
      return p;
    }
    return this.releaseFor(p, card, "auto");
  }

  get(accountHolderId: string, purchaseId: string): AttachedPurchase {
    const p = this.purchases.get(purchaseId);
    if (!p || p.accountHolderId !== accountHolderId) throw new AttachedCardError(404, "not_found", "purchase not found");
    return p;
  }

  listPurchases(accountHolderId: string) {
    return [...this.purchases.values()].filter((p) => p.accountHolderId === accountHolderId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Called only after a verified passkey assertion from a person (see routes). */
  async approve(accountHolderId: string, purchaseId: string, approvedBy: string): Promise<AttachedPurchase> {
    const p = this.get(accountHolderId, purchaseId);
    if (p.status !== "awaiting_approval") throw new AttachedCardError(409, "not_pending", `purchase is ${p.status}`);
    const card = this.cards.get(p.cardId);
    p.decidedAt = new Date().toISOString();
    p.approvedBy = approvedBy;
    if (!card) return this.decline(p, "card_removed");
    return this.releaseFor(p, card, approvedBy);
  }

  deny(accountHolderId: string, purchaseId: string, by: string): AttachedPurchase {
    const p = this.get(accountHolderId, purchaseId);
    if (p.status !== "awaiting_approval") throw new AttachedCardError(409, "not_pending", `purchase is ${p.status}`);
    p.status = "denied";
    p.reason = "denied_by_card_holder";
    p.decidedAt = new Date().toISOString();
    p.approvedBy = by;
    return p;
  }

  private async releaseFor(p: AttachedPurchase, card: AttachedCard, by: string): Promise<AttachedPurchase> {
    try {
      const r = await this.provider.release({ providerRef: card.providerRef, purchaseId: p.id, amount: p.amount, currency: p.currency, target: p.target });
      if (r.boundAmount !== p.amount || r.boundMerchant !== p.target.merchantName) {
        p.status = "failed";
        p.reason = "provider_bound_mismatch";
        return p;
      }
      p.release = r;
      p.status = r.delivered ? "paid" : "failed";
      if (!r.delivered) p.reason = "not_delivered";
      if (by === "auto") p.approvedBy = "auto_approve_rule";
      return p;
    } catch {
      p.status = "failed";
      p.reason = "provider_error";
      return p;
    }
  }

  private decline(p: AttachedPurchase, reason: string): AttachedPurchase {
    p.status = "declined";
    p.reason = reason;
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
