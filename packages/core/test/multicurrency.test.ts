import { beforeEach, describe, expect, it } from "vitest";
import { Platform } from "../src/platform.js";

/**
 * ZAR and USD wallets are independent: an org holds one wallet per currency,
 * a card draws only from its currency's wallet, and spending one never touches
 * the other.
 */
let platform: Platform;
let holderId: string;

beforeEach(() => {
  platform = new Platform();
  holderId = platform.signup({ email: "global@example.com", name: "Global", currency: "ZAR" }).id;
});

describe("multi-currency wallets", () => {
  it("keeps ZAR and USD balances separate", () => {
    platform.fundWallet(holderId, 100_000, "ZAR");
    platform.fundWallet(holderId, 40_000, "USD");

    expect(platform.walletBalance(holderId, "ZAR").available).toBe(100_000);
    expect(platform.walletBalance(holderId, "USD").available).toBe(40_000);

    const balances = platform.walletBalances(holderId);
    expect(balances.map((b) => b.currency).sort()).toEqual(["USD", "ZAR"]);
    // Primary currency (ZAR) is listed first.
    expect(balances[0]!.currency).toBe("ZAR");
  });

  it("a USD card draws from the USD wallet and leaves ZAR untouched", () => {
    platform.fundWallet(holderId, 100_000, "ZAR");
    platform.fundWallet(holderId, 40_000, "USD");

    const usdCard = platform.createCard({ accountHolderId: holderId, currency: "USD", singleUse: false });
    expect(usdCard.currency).toBe("USD");

    const decision = platform.authorize({
      authorizationId: "usd_auth_1",
      cardId: usdCard.id,
      amount: 15_000,
      currency: "USD",
      merchant: { name: "OpenAI", category: "5734" },
    });
    expect(decision.approved).toBe(true);

    // USD wallet reflects the hold; ZAR wallet is completely untouched.
    expect(platform.walletBalance(holderId, "USD").available).toBe(25_000);
    expect(platform.walletBalance(holderId, "USD").held).toBe(15_000);
    expect(platform.walletBalance(holderId, "ZAR").available).toBe(100_000);
    expect(platform.walletBalance(holderId, "ZAR").held).toBe(0);

    platform.capture("usd_auth_1");
    expect(platform.walletBalance(holderId, "USD").posted).toBe(25_000);
    expect(platform.walletBalance(holderId, "ZAR").posted).toBe(100_000);
  });

  it("a USD card cannot be funded by ZAR — insufficient USD funds decline", () => {
    platform.fundWallet(holderId, 100_000, "ZAR"); // only ZAR funded
    const usdCard = platform.createCard({ accountHolderId: holderId, currency: "USD", singleUse: false });
    const decision = platform.authorize({
      authorizationId: "usd_auth_2",
      cardId: usdCard.id,
      amount: 5_000,
      currency: "USD",
      merchant: { name: "AWS", category: "5734" },
    });
    expect(decision.approved).toBe(false);
    expect(decision.declineReason).toBe("insufficient_funds");
  });

  it("survives a snapshot/hydrate cycle with both wallets intact", () => {
    platform.fundWallet(holderId, 100_000, "ZAR");
    platform.fundWallet(holderId, 40_000, "USD");
    const restored = Platform.hydrate(platform.serialize());
    expect(restored.walletBalance(holderId, "ZAR").available).toBe(100_000);
    expect(restored.walletBalance(holderId, "USD").available).toBe(40_000);
  });
});
