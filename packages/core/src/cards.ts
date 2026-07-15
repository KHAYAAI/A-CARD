import { newId } from "./ids.js";
import type { Currency } from "./money.js";

export type CardStatus = "active" | "closed";

export interface CardLimits {
  /** Maximum amount for a single authorization, minor units. */
  perTransaction?: number;
  /** Total lifetime spend cap for the card, minor units. */
  total?: number;
  /** Rolling-window velocity cap. */
  velocity?: { amount: number; windowSeconds: number };
}

export interface Card {
  id: string;
  accountHolderId: string;
  walletAccountId: string;
  currency: Currency;
  status: CardStatus;
  /** Card closes automatically after its first successful capture. */
  singleUse: boolean;
  limits: CardLimits;
  /** Merchant category codes the card may be used at. Empty = all allowed. */
  allowedMerchantCategories: string[];
  /** Authorizations above this amount require human approval. */
  approvalThreshold?: number;
  /**
   * Sandbox PAN. Real deployments never see a PAN — the issuing partner hosts
   * card credentials so the platform stays out of PCI scope. Sandbox uses the
   * deterministic 4242 test PAN, mirroring issuer sandboxes.
   */
  sandboxPan: string;
  last4: string;
  expiryMonth: number;
  expiryYear: number;
  label?: string;
  createdAt: string;
  closedAt?: string;
  closeReason?: string;
}

export interface CreateCardInput {
  accountHolderId: string;
  walletAccountId: string;
  currency: Currency;
  singleUse?: boolean;
  limits?: CardLimits;
  allowedMerchantCategories?: string[];
  approvalThreshold?: number;
  label?: string;
}

export function createCard(input: CreateCardInput): Card {
  const now = new Date();
  const suffix = String(Math.floor(Math.random() * 10000)).padStart(4, "0");
  return {
    id: newId("card"),
    accountHolderId: input.accountHolderId,
    walletAccountId: input.walletAccountId,
    currency: input.currency,
    status: "active",
    singleUse: input.singleUse ?? true,
    limits: input.limits ?? {},
    allowedMerchantCategories: input.allowedMerchantCategories ?? [],
    approvalThreshold: input.approvalThreshold,
    sandboxPan: `424242424242${suffix}`,
    last4: suffix,
    expiryMonth: now.getUTCMonth() + 1,
    expiryYear: now.getUTCFullYear() + 3,
    label: input.label,
    createdAt: now.toISOString(),
  };
}

/** Public view of a card: never exposes the PAN outside sandbox detail calls. */
export function redactCard(card: Card): Omit<Card, "sandboxPan"> {
  const { sandboxPan: _pan, ...rest } = card;
  return rest;
}
