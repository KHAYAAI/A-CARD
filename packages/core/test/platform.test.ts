import { beforeEach, describe, expect, it } from "vitest";
import { Platform } from "../src/platform.js";

let platform: Platform;
let holderId: string;

beforeEach(() => {
  platform = new Platform();
  const holder = platform.signup({ email: "founder@example.co.za", name: "Founder", currency: "ZAR" });
  holderId = holder.id;
  platform.fundWallet(holderId, 100_000); // R1000.00
});

function activeCard(overrides: Parameters<Platform["createCard"]>[0] extends infer T ? Partial<T> : never = {}) {
  return platform.createCard({
    accountHolderId: holderId,
    singleUse: false,
    ...overrides,
  });
}

describe("authorization flow", () => {
  it("approves an in-budget authorization and captures it", () => {
    const card = activeCard();
    const decision = platform.authorize({
      authorizationId: "auth_1",
      cardId: card.id,
      amount: 25_000,
      currency: "ZAR",
      merchant: { name: "Takealot", category: "5999" },
    });
    expect(decision.approved).toBe(true);
    expect(platform.walletBalance(holderId).available).toBe(75_000);

    const captured = platform.capture("auth_1");
    expect(captured.status).toBe("completed");
    expect(platform.walletBalance(holderId).posted).toBe(75_000);
  });

  it("is idempotent on the issuer authorization id", () => {
    const card = activeCard();
    const first = platform.authorize({
      authorizationId: "auth_dup",
      cardId: card.id,
      amount: 10_000,
      currency: "ZAR",
      merchant: { name: "Takealot", category: "5999" },
    });
    const second = platform.authorize({
      authorizationId: "auth_dup",
      cardId: card.id,
      amount: 10_000,
      currency: "ZAR",
      merchant: { name: "Takealot", category: "5999" },
    });
    expect(second.transaction.id).toBe(first.transaction.id);
    // Only one hold placed.
    expect(platform.walletBalance(holderId).held).toBe(10_000);
  });

  it("declines when wallet lacks available funds", () => {
    const card = activeCard();
    const decision = platform.authorize({
      authorizationId: "auth_big",
      cardId: card.id,
      amount: 150_000,
      currency: "ZAR",
      merchant: { name: "Takealot", category: "5999" },
    });
    expect(decision.approved).toBe(false);
    expect(decision.declineReason).toBe("insufficient_funds");
  });

  it("enforces merchant category allow-list", () => {
    const card = activeCard({ allowedMerchantCategories: ["5734"] });
    const decision = platform.authorize({
      authorizationId: "auth_mcc",
      cardId: card.id,
      amount: 1_000,
      currency: "ZAR",
      merchant: { name: "Casino", category: "7995" },
    });
    expect(decision.declineReason).toBe("merchant_category_not_allowed");
  });

  it("enforces per-transaction and total limits", () => {
    const card = activeCard({ limits: { perTransaction: 5_000, total: 8_000 } });
    expect(
      platform.authorize({
        authorizationId: "a1",
        cardId: card.id,
        amount: 6_000,
        currency: "ZAR",
        merchant: { name: "M", category: "5999" },
      }).declineReason,
    ).toBe("per_transaction_limit_exceeded");

    expect(
      platform.authorize({
        authorizationId: "a2",
        cardId: card.id,
        amount: 5_000,
        currency: "ZAR",
        merchant: { name: "M", category: "5999" },
      }).approved,
    ).toBe(true);

    expect(
      platform.authorize({
        authorizationId: "a3",
        cardId: card.id,
        amount: 4_000,
        currency: "ZAR",
        merchant: { name: "M", category: "5999" },
      }).declineReason,
    ).toBe("card_total_limit_exceeded");
  });

  it("declines on closed cards", () => {
    const card = activeCard();
    platform.closeCard(card.id);
    const decision = platform.authorize({
      authorizationId: "auth_closed",
      cardId: card.id,
      amount: 1_000,
      currency: "ZAR",
      merchant: { name: "M", category: "5999" },
    });
    expect(decision.declineReason).toBe("card_closed");
  });

  it("auto-closes single-use cards after capture", () => {
    const card = activeCard({ singleUse: true });
    platform.authorize({
      authorizationId: "auth_su",
      cardId: card.id,
      amount: 2_000,
      currency: "ZAR",
      merchant: { name: "M", category: "5999" },
    });
    platform.capture("auth_su");
    expect(platform.getCard(card.id).status).toBe("closed");
    expect(platform.getCard(card.id).closeReason).toBe("single_use_completed");
  });

  it("releases held funds on reversal", () => {
    const card = activeCard();
    platform.authorize({
      authorizationId: "auth_rev",
      cardId: card.id,
      amount: 30_000,
      currency: "ZAR",
      merchant: { name: "M", category: "5999" },
    });
    expect(platform.walletBalance(holderId).available).toBe(70_000);
    platform.reverse("auth_rev");
    expect(platform.walletBalance(holderId).available).toBe(100_000);
  });
});

describe("human-in-the-loop approvals", () => {
  it("routes above-threshold charges to review, then honors the grant", () => {
    const card = activeCard({ approvalThreshold: 20_000 });

    const first = platform.authorize({
      authorizationId: "auth_hitl_1",
      cardId: card.id,
      amount: 50_000,
      currency: "ZAR",
      merchant: { name: "FlySafair", category: "4511" },
    });
    expect(first.approved).toBe(false);
    expect(first.declineReason).toBe("pending_human_approval");
    expect(first.approvalId).toBeDefined();
    // No funds locked while pending.
    expect(platform.walletBalance(holderId).held).toBe(0);

    platform.decideApproval(first.approvalId!, "approved", "founder@example.co.za");

    const retry = platform.authorize({
      authorizationId: "auth_hitl_2",
      cardId: card.id,
      amount: 50_000,
      currency: "ZAR",
      merchant: { name: "FlySafair", category: "4511" },
    });
    expect(retry.approved).toBe(true);

    // Grant is consumed: a third attempt goes back to review.
    const third = platform.authorize({
      authorizationId: "auth_hitl_3",
      cardId: card.id,
      amount: 50_000,
      currency: "ZAR",
      merchant: { name: "FlySafair", category: "4511" },
    });
    expect(third.declineReason).toBe("pending_human_approval");
  });

  it("denied approvals never let the charge through", () => {
    const card = activeCard({ approvalThreshold: 1_000 });
    const first = platform.authorize({
      authorizationId: "auth_deny_1",
      cardId: card.id,
      amount: 5_000,
      currency: "ZAR",
      merchant: { name: "M", category: "5999" },
    });
    platform.decideApproval(first.approvalId!, "denied", "founder@example.co.za");
    const retry = platform.authorize({
      authorizationId: "auth_deny_2",
      cardId: card.id,
      amount: 5_000,
      currency: "ZAR",
      merchant: { name: "M", category: "5999" },
    });
    expect(retry.approved).toBe(false);
  });

  it("grant does not cover a larger amount than approved", () => {
    const card = activeCard({ approvalThreshold: 1_000 });
    const first = platform.authorize({
      authorizationId: "auth_bound_1",
      cardId: card.id,
      amount: 5_000,
      currency: "ZAR",
      merchant: { name: "M", category: "5999" },
    });
    platform.decideApproval(first.approvalId!, "approved", "founder");
    const bigger = platform.authorize({
      authorizationId: "auth_bound_2",
      cardId: card.id,
      amount: 9_000,
      currency: "ZAR",
      merchant: { name: "M", category: "5999" },
    });
    expect(bigger.approved).toBe(false);
  });
});

describe("api keys", () => {
  it("authenticates issued keys and rejects revoked ones", () => {
    const issued = platform.apiKeys.issue(holderId, "test key");
    expect(platform.apiKeys.authenticate(issued.secret)?.accountHolderId).toBe(holderId);
    platform.apiKeys.revoke(issued.key.id);
    expect(platform.apiKeys.authenticate(issued.secret)).toBeUndefined();
  });
});
