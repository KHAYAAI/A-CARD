import { beforeEach, describe, expect, it } from "vitest";
import { Platform } from "../src/platform.js";

/**
 * Every real card issuer identifies a card by *their own* reference, not
 * ours — a webhook from Sudo (or any BIN-sponsored issuer) carries their
 * card token, never our internal `card.id`. This is the resolution layer
 * that makes `Platform.authorize` work whether the caller is the sandbox
 * mock issuer (which echoes our own id back, unchanged behaviour) or a real
 * issuer sending their own token in the same field.
 */
let platform: Platform;
let holderId: string;

beforeEach(() => {
  platform = new Platform();
  const holder = platform.signup({ email: "founder@example.co.za", name: "Founder", currency: "ZAR" });
  holderId = holder.id;
  platform.fundWallet(holderId, 100_000);
});

describe("issuer card linking", () => {
  it("links an issuer reference at creation and resolves it via getCardByIssuerCardId", () => {
    const card = platform.createCard({ accountHolderId: holderId, singleUse: false, issuerCardId: "sudo_card_abc123" });
    expect(card.issuerCardId).toBe("sudo_card_abc123");
    expect(platform.getCardByIssuerCardId("sudo_card_abc123")?.id).toBe(card.id);
    expect(platform.getCardByIssuerCardId("no_such_token")).toBeUndefined();
  });

  it("refuses to create a second card with an issuer reference already in use", () => {
    platform.createCard({ accountHolderId: holderId, singleUse: false, issuerCardId: "sudo_card_dup" });
    expect(() =>
      platform.createCard({ accountHolderId: holderId, singleUse: false, issuerCardId: "sudo_card_dup" }),
    ).toThrow(/already linked/);
  });

  it("links a card to an issuer reference after the fact (issuer provisioning as a separate step)", () => {
    const card = platform.createCard({ accountHolderId: holderId, singleUse: false });
    expect(card.issuerCardId).toBeUndefined();

    const linked = platform.linkIssuerCard(card.id, "sudo_card_xyz");
    expect(linked.issuerCardId).toBe("sudo_card_xyz");
    expect(platform.getCardByIssuerCardId("sudo_card_xyz")?.id).toBe(card.id);
  });

  it("refuses to link an issuer reference already claimed by a different card", () => {
    const a = platform.createCard({ accountHolderId: holderId, singleUse: false, issuerCardId: "sudo_card_taken" });
    const b = platform.createCard({ accountHolderId: holderId, singleUse: false });
    expect(() => platform.linkIssuerCard(b.id, "sudo_card_taken")).toThrow(/already linked/);
    expect(platform.getCardByIssuerCardId("sudo_card_taken")?.id).toBe(a.id);
  });

  it("re-linking a card to a new issuer reference releases the old one", () => {
    const card = platform.createCard({ accountHolderId: holderId, singleUse: false, issuerCardId: "sudo_card_old" });
    platform.linkIssuerCard(card.id, "sudo_card_new");
    expect(platform.getCardByIssuerCardId("sudo_card_old")).toBeUndefined();
    expect(platform.getCardByIssuerCardId("sudo_card_new")?.id).toBe(card.id);
  });

  it("authorizes by our own card id unchanged (the sandbox mock issuer path)", () => {
    const card = platform.createCard({ accountHolderId: holderId, singleUse: false });
    const decision = platform.authorize({
      authorizationId: "auth_own_id",
      cardId: card.id,
      amount: 10_000,
      currency: "ZAR",
      merchant: { name: "Checkers", category: "5411" },
    });
    expect(decision.approved).toBe(true);
    expect(decision.transaction.cardId).toBe(card.id);
  });

  it("authorizes by the issuer's own card reference (the real-issuer webhook path)", () => {
    const card = platform.createCard({ accountHolderId: holderId, singleUse: false, issuerCardId: "sudo_card_live" });
    const decision = platform.authorize({
      authorizationId: "auth_via_issuer_id",
      cardId: "sudo_card_live", // Sudo's webhook would send their own token here, not ours
      amount: 10_000,
      currency: "ZAR",
      merchant: { name: "Checkers", category: "5411" },
    });
    expect(decision.approved).toBe(true);
    // The persisted transaction is keyed on OUR card id, not the issuer's token —
    // every other listing (list transactions, spend totals) filters by our id.
    expect(decision.transaction.cardId).toBe(card.id);
    expect(platform.listTransactions({ cardId: card.id })).toHaveLength(1);
  });

  it("declines via the issuer reference still record our card id, not the issuer's token", () => {
    const card = platform.createCard({
      accountHolderId: holderId,
      singleUse: false,
      issuerCardId: "sudo_card_declined",
      allowedMerchantCategories: ["5411"], // only groceries
    });
    const decision = platform.authorize({
      authorizationId: "auth_declined_via_issuer",
      cardId: "sudo_card_declined",
      amount: 5_000,
      currency: "ZAR",
      merchant: { name: "Steam", category: "5816" }, // not allowed
    });
    expect(decision.approved).toBe(false);
    expect(decision.transaction.cardId).toBe(card.id);
  });

  it("declines with card_not_found for a reference matching neither an internal id nor an issuer reference", () => {
    const decision = platform.authorize({
      authorizationId: "auth_unknown",
      cardId: "totally_unknown_token",
      amount: 5_000,
      currency: "ZAR",
      merchant: { name: "M", category: "5999" },
    });
    expect(decision.approved).toBe(false);
    expect(decision.declineReason).toBe("card_not_found");
  });

  it("round-trips the issuer link through a snapshot", () => {
    platform.createCard({ accountHolderId: holderId, singleUse: false, issuerCardId: "sudo_card_persisted" });
    const restored = Platform.hydrate(platform.serialize());
    expect(restored.getCardByIssuerCardId("sudo_card_persisted")).toBeDefined();

    const decision = restored.authorize({
      authorizationId: "auth_after_hydrate",
      cardId: "sudo_card_persisted",
      amount: 1_000,
      currency: "ZAR",
      merchant: { name: "M", category: "5999" },
    });
    expect(decision.approved).toBe(true);
  });
});
