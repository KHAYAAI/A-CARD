import { beforeEach, describe, expect, it } from "vitest";
import { Platform } from "../src/platform.js";
import { DomainError } from "../src/errors.js";

/**
 * Per-card USD spend caps (billing.ts's `applyCardCap`): free/basic/pro cap
 * a card's `limits.total`, enterprise doesn't, and — since there's no FX
 * conversion in this codebase — only USD-denominated cards are capped at
 * all. A plain `createCard()` with no explicit total still gets a safe
 * default instead of staying silently uncapped.
 */
let platform: Platform;
let holderId: string;

beforeEach(() => {
  platform = new Platform();
  holderId = platform.signup({ email: "caps@example.com", name: "Caps", currency: "USD" }).id;
});

describe("per-card USD spend caps", () => {
  it("free tier: a USD card with no explicit total defaults to the $50 cap", () => {
    const card = platform.createCard({ accountHolderId: holderId, currency: "USD" });
    expect(card.limits.total).toBe(5_000);
  });

  it("free tier: an explicit total within the cap is honored as-is", () => {
    const card = platform.createCard({ accountHolderId: holderId, currency: "USD", limits: { total: 2_000 } });
    expect(card.limits.total).toBe(2_000);
  });

  it("free tier: an explicit total above the cap is rejected", () => {
    expect(() => platform.createCard({ accountHolderId: holderId, currency: "USD", limits: { total: 10_000 } })).toThrow(DomainError);
    try {
      platform.createCard({ accountHolderId: holderId, currency: "USD", limits: { total: 10_000 } });
    } catch (e) {
      expect(e).toBeInstanceOf(DomainError);
      expect((e as DomainError).code).toBe("plan_card_cap_exceeded");
      expect((e as DomainError).status).toBe(402);
    }
  });

  it("upgrading to pro raises the cap to $1,000", () => {
    platform.setSubscriptionTier(holderId, "pro");
    const card = platform.createCard({ accountHolderId: holderId, currency: "USD", limits: { total: 80_000 } });
    expect(card.limits.total).toBe(80_000);
  });

  it("enterprise tier is uncapped — no default injected, no rejection at any amount", () => {
    platform.setSubscriptionTier(holderId, "enterprise");
    const uncapped = platform.createCard({ accountHolderId: holderId, currency: "USD" });
    expect(uncapped.limits.total).toBeUndefined();
    const large = platform.createCard({ accountHolderId: holderId, currency: "USD", limits: { total: 10_000_000 } });
    expect(large.limits.total).toBe(10_000_000);
  });

  it("non-USD cards are never capped — no FX conversion exists to apply a USD number against", () => {
    const zarHolder = platform.signup({ email: "zar@example.com", name: "ZAR", currency: "ZAR" }).id;
    const card = platform.createCard({ accountHolderId: zarHolder, currency: "ZAR", limits: { total: 10_000_000 } });
    expect(card.limits.total).toBe(10_000_000); // untouched — free tier's $50 cap does not apply to ZAR
    const uncapped = platform.createCard({ accountHolderId: zarHolder, currency: "ZAR" });
    expect(uncapped.limits.total).toBeUndefined(); // no default injected either
  });
});
