import { beforeEach, describe, expect, it } from "vitest";
import { Platform } from "../src/platform.js";

let platform: Platform;
let holderId: string;

beforeEach(() => {
  platform = new Platform();
  const holder = platform.signup({ email: "durable@example.co.za", name: "Durable", currency: "ZAR" });
  holderId = holder.id;
  platform.fundWallet(holderId, 50_000);
});

describe("platform snapshot round-trip", () => {
  it("preserves wallet balances, cards, and open holds across a snapshot/hydrate cycle", () => {
    const card = platform.createCard({ accountHolderId: holderId, singleUse: false });
    platform.authorize({
      authorizationId: "auth_snap_1",
      cardId: card.id,
      amount: 10_000,
      currency: "ZAR",
      merchant: { name: "M", category: "5999" },
    });

    const snapshot = platform.serialize();
    const restored = Platform.hydrate(snapshot);

    expect(restored.walletBalance(holderId)).toEqual(platform.walletBalance(holderId));
    expect(restored.getCard(card.id).status).toBe("active");
    expect(restored.listTransactions({ accountHolderId: holderId })).toHaveLength(1);

    // The restored platform must still enforce the held amount correctly —
    // i.e. it isn't just copying summary numbers, it rebuilt real ledger state.
    restored.capture("auth_snap_1");
    expect(restored.walletBalance(holderId).posted).toBe(40_000);
  });

  it("preserves pending approvals and api keys", () => {
    const card = platform.createCard({ accountHolderId: holderId, approvalThreshold: 1_000 });
    const decision = platform.authorize({
      authorizationId: "auth_snap_2",
      cardId: card.id,
      amount: 5_000,
      currency: "ZAR",
      merchant: { name: "M", category: "5999" },
    });
    const issued = platform.apiKeys.issue(holderId, "restored key");

    const restored = Platform.hydrate(platform.serialize());

    expect(restored.approvals.list({ accountHolderId: holderId, status: "pending" })).toHaveLength(1);
    expect(restored.apiKeys.authenticate(issued.secret)?.accountHolderId).toBe(holderId);

    restored.decideApproval(decision.approvalId!, "approved", "founder");
    const retry = restored.authorize({
      authorizationId: "auth_snap_3",
      cardId: card.id,
      amount: 5_000,
      currency: "ZAR",
      merchant: { name: "M", category: "5999" },
    });
    expect(retry.approved).toBe(true);
  });
});

describe("platform event hooks", () => {
  it("fires onEvent listeners synchronously for approval requests", () => {
    const seen: string[] = [];
    platform.onEvent((event) => seen.push(event.type));

    const card = platform.createCard({ accountHolderId: holderId, approvalThreshold: 1_000 });
    platform.authorize({
      authorizationId: "auth_evt_1",
      cardId: card.id,
      amount: 5_000,
      currency: "ZAR",
      merchant: { name: "M", category: "5999" },
    });

    expect(seen).toContain("approval.requested");
  });
});

describe("subscription tiers", () => {
  it("caps card creation at the free tier's monthly limit", () => {
    for (let i = 0; i < 5; i++) {
      platform.createCard({ accountHolderId: holderId, label: `card ${i}` });
    }
    expect(() => platform.createCard({ accountHolderId: holderId, label: "one too many" })).toThrow(
      /plan allows 5 cards\/month/,
    );
  });

  it("raises the limit once a subscription upgrade is applied", () => {
    for (let i = 0; i < 5; i++) platform.createCard({ accountHolderId: holderId });
    platform.setSubscriptionTier(holderId, "basic");
    expect(() => platform.createCard({ accountHolderId: holderId })).not.toThrow();
  });
});
