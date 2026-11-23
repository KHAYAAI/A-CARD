import type { CardTransaction } from "@acard/core";
import type { Distributor, Partner, PartnerTerms } from "./types.js";

/**
 * Monthly revenue-share statement for one partner.
 *
 * Volume is captured card spend minus refunds in the month, per currency (money
 * is minor units, never converted here: conversion belongs to whoever invoices).
 * A-CARD's fees: `volumeBps` of volume in each currency, plus `perActiveCard`
 * for every card with spend; together topped up to `monthlyMinimum`, which is
 * applied in the terms currency only. The distributor's cut is its share of
 * A-CARD's fees.
 */
export interface CustomerLine {
  accountHolderId: string;
  externalRef?: string;
  volume: Record<string, number>;
  activeCards: number;
  transactions: number;
}

export interface PartnerStatement {
  partnerId: string;
  partnerName: string;
  month: string;
  terms: PartnerTerms;
  customers: CustomerLine[];
  volume: Record<string, number>;
  activeCards: number;
  fees: {
    volume: Record<string, number>;
    activeCards: number;
    /** Top-up so usage fees in the terms currency reach the monthly minimum. */
    minimumTopUp: number;
    /** Total per currency: what A-CARD invoices the partner. */
    total: Record<string, number>;
  };
  distributor?: { id: string; name: string; shareBps: number; payout: Record<string, number> };
}

export const monthBounds = (month: string) => {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error("month must be YYYY-MM");
  const [y, m] = month.split("-").map(Number) as [number, number];
  return { from: Date.UTC(y, m - 1, 1), to: Date.UTC(y, m, 1) };
};
export const currentMonth = (now = new Date()) => now.toISOString().slice(0, 7);

const add = (o: Record<string, number>, k: string, v: number) => { o[k] = (o[k] ?? 0) + v; };

export function customerLine(accountHolderId: string, externalRef: string | undefined, txs: CardTransaction[], month: string): CustomerLine {
  const { from, to } = monthBounds(month);
  const volume: Record<string, number> = {};
  const cards = new Set<string>();
  let n = 0;
  for (const t of txs) {
    const at = Date.parse(t.createdAt);
    if (at < from || at >= to || t.status !== "completed") continue;
    if (t.type === "capture") { add(volume, t.currency, t.amount); cards.add(t.cardId); n++; }
    else if (t.type === "refund") { add(volume, t.currency, -Math.abs(t.amount)); n++; }
  }
  return { accountHolderId, externalRef, volume, activeCards: cards.size, transactions: n };
}

export function statement(partner: Partner, month: string, customers: CustomerLine[], distributor?: Distributor): PartnerStatement {
  const t = partner.terms;
  const volume: Record<string, number> = {};
  let activeCards = 0;
  for (const c of customers) {
    for (const [cur, v] of Object.entries(c.volume)) add(volume, cur, v);
    activeCards += c.activeCards;
  }
  const feeVolume: Record<string, number> = {};
  for (const [cur, v] of Object.entries(volume)) feeVolume[cur] = Math.max(0, Math.round((v * t.volumeBps) / 10_000));
  const cardFee = activeCards * t.perActiveCard;
  const usageInTermsCurrency = (feeVolume[t.currency] ?? 0) + cardFee;
  const minimumTopUp = Math.max(0, t.monthlyMinimum - usageInTermsCurrency);
  const total: Record<string, number> = { ...feeVolume };
  add(total, t.currency, cardFee + minimumTopUp);
  const s: PartnerStatement = {
    partnerId: partner.id, partnerName: partner.name, month, terms: t, customers, volume, activeCards,
    fees: { volume: feeVolume, activeCards: cardFee, minimumTopUp, total },
  };
  if (distributor) {
    const payout: Record<string, number> = {};
    for (const [cur, v] of Object.entries(total)) payout[cur] = Math.floor((v * distributor.shareBps) / 10_000);
    s.distributor = { id: distributor.id, name: distributor.name, shareBps: distributor.shareBps, payout };
  }
  return s;
}
