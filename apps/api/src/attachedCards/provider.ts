/**
 * Where attached cards live. A-CARD NEVER holds a card number: the card is
 * stored either as a Visa / Mastercard agent network token, or with a
 * PCI-certified vault provider. A-CARD keeps only the provider's reference
 * plus brand, last four and expiry for display.
 *
 * A real adapter is written once a partner is chosen and its API docs exist.
 * The contract below is what A-CARD needs from any of them.
 */
export type CardBrand = "visa" | "mastercard" | "amex" | "other";

export interface CardDisplay {
  brand: CardBrand;
  last4: string;
  expMonth: number;
  expYear: number;
}

/** Where the money goes: how the released credential reaches the merchant. */
export interface CheckoutTarget {
  merchantName: string;
  merchantCategory: string;
  /**
   * How the provider delivers the credential, so A-CARD itself never handles it:
   * - "network_token": the provider sends a token and cryptogram to the merchant's acquirer or processor.
   * - "vault_proxy": the provider forwards the card into the merchant's own payment API through its proxy.
   */
  method: "network_token" | "vault_proxy";
  /** For vault_proxy: the merchant payment endpoint the provider calls. For network_token: the merchant or processor id. */
  destination: string;
}

export interface ReleaseResult {
  /** Provider's id for this one-time release; safe to store and show. */
  releaseRef: string;
  /** Delivered to the merchant (or its processor) by the provider. A-CARD never sees the credential. */
  delivered: boolean;
  /** The provider's own record of the charge, when it reports one. */
  chargeRef?: string;
  boundAmount: number;
  boundMerchant: string;
  expiresAt: string;
}

export interface CardVaultProvider {
  readonly name: string;
  readonly kind: "network_token" | "pci_vault" | "test";
  /**
   * Resolve the reference the provider's own hosted card form (or the network's
   * token flow) returned after the holder entered their card there. The card
   * number is typed into the provider's page, never into A-CARD's.
   */
  describe(providerRef: string): Promise<CardDisplay>;
  /**
   * Release a single-use credential for exactly this purchase: bound to one
   * merchant and amount, short-lived. Called only after A-CARD's rules pass and,
   * where required, the holder approved with a passkey.
   */
  release(input: { providerRef: string; purchaseId: string; amount: number; currency: string; target: CheckoutTarget }): Promise<ReleaseResult>;
  /** Ask the provider to delete the stored card or token. */
  remove(providerRef: string): Promise<void>;
}

/**
 * A provider for tests and local development only. References look like
 * `test_tok_visa_4242_1230`. It holds no card data and delivers nothing.
 * index.ts refuses to start with it when NODE_ENV=production.
 */
export class TestVaultProvider implements CardVaultProvider {
  readonly name = "test";
  readonly kind = "test" as const;
  released: { providerRef: string; purchaseId: string; amount: number; target: CheckoutTarget }[] = [];
  removed: string[] = [];

  async describe(providerRef: string): Promise<CardDisplay> {
    const m = /^test_tok_(visa|mastercard|amex)_(\d{4})_(\d{2})(\d{2})$/.exec(providerRef);
    if (!m) throw new Error("unknown card reference");
    return { brand: m[1] as CardBrand, last4: m[2]!, expMonth: Number(m[3]), expYear: 2000 + Number(m[4]) };
  }

  async release(input: { providerRef: string; purchaseId: string; amount: number; currency: string; target: CheckoutTarget }): Promise<ReleaseResult> {
    this.released.push({ providerRef: input.providerRef, purchaseId: input.purchaseId, amount: input.amount, target: input.target });
    return {
      releaseRef: `test_rel_${input.purchaseId}`,
      delivered: true,
      chargeRef: `test_chg_${input.purchaseId}`,
      boundAmount: input.amount,
      boundMerchant: input.target.merchantName,
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    };
  }

  async remove(providerRef: string): Promise<void> {
    this.removed.push(providerRef);
  }
}
