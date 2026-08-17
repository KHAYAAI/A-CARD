import { describe, expect, it } from "vitest";
import { ApiKeyService } from "../src/index.js";

describe("API key scoping", () => {
  it("defaults to full access and no spend cap, preserving the original behaviour", () => {
    const keys = new ApiKeyService();
    const { key, secret } = keys.issue("acct_1", "default");
    expect(key.scope).toBe("full");
    expect(key.spendCapCents).toBeUndefined();
    expect(key.provisionedCents).toBe(0);
    expect(secret.startsWith("ak_live_")).toBe(true);
    expect(keys.authenticate(secret)?.id).toBe(key.id);
  });

  it("issues a read-only key that still authenticates", () => {
    const keys = new ApiKeyService();
    const { key, secret } = keys.issue("acct_1", "bi tool", { scope: "read_only" });
    expect(key.scope).toBe("read_only");
    expect(keys.authenticate(secret)?.scope).toBe("read_only");
  });

  it("draws down a spend cap and refuses the charge that would exceed it", () => {
    const keys = new ApiKeyService();
    const { key } = keys.issue("acct_1", "capped", { spendCapCents: 100_000 });

    keys.assertSpendAllowance(key.id, 60_000);
    keys.recordSpend(key.id, 60_000);
    expect(key.provisionedCents).toBe(60_000);

    // 60k + 50k > 100k cap.
    expect(() => keys.assertSpendAllowance(key.id, 50_000)).toThrow(
      expect.objectContaining({ code: "api_key_spend_cap_exceeded" }),
    );
    // The rejected charge must not have been counted.
    expect(key.provisionedCents).toBe(60_000);

    // Exactly hitting the cap is allowed.
    keys.assertSpendAllowance(key.id, 40_000);
    keys.recordSpend(key.id, 40_000);
    expect(key.provisionedCents).toBe(100_000);
    expect(() => keys.assertSpendAllowance(key.id, 1)).toThrow(
      expect.objectContaining({ code: "api_key_spend_cap_exceeded" }),
    );
  });

  it("refuses a card with no total budget through a capped key", () => {
    const keys = new ApiKeyService();
    const { key } = keys.issue("acct_1", "capped", { spendCapCents: 100_000 });
    // An unbounded card would otherwise slip straight past the cap.
    expect(() => keys.assertSpendAllowance(key.id, undefined)).toThrow(
      expect.objectContaining({ code: "card_budget_required" }),
    );
  });

  it("leaves uncapped keys unrestricted", () => {
    const keys = new ApiKeyService();
    const { key } = keys.issue("acct_1", "uncapped");
    keys.assertSpendAllowance(key.id, 10_000_000);
    keys.recordSpend(key.id, 10_000_000);
    expect(key.provisionedCents).toBe(0); // nothing to track when there is no cap
    // An uncapped key may also create cards with no declared total.
    expect(() => keys.assertSpendAllowance(key.id, undefined)).not.toThrow();
  });

  it("round-trips scope and cap state through a snapshot", () => {
    const keys = new ApiKeyService();
    const { key } = keys.issue("acct_1", "capped", { scope: "read_only", spendCapCents: 50_000 });
    keys.recordSpend(key.id, 20_000);

    const restored = ApiKeyService.hydrate(keys.serialize());
    const [only] = restored.list("acct_1") as [(typeof key)];
    expect(only.scope).toBe("read_only");
    expect(only.spendCapCents).toBe(50_000);
    expect(only.provisionedCents).toBe(20_000);
    // The restored cap still bites at the right point.
    expect(() => restored.assertSpendAllowance(only.id, 30_001)).toThrow(
      expect.objectContaining({ code: "api_key_spend_cap_exceeded" }),
    );
  });

  it("treats keys snapshotted before scoping existed as full-access and uncapped", () => {
    // A pre-scoping snapshot: no `scope`, no `provisionedCents`.
    const legacy = [
      {
        id: "key_legacy",
        accountHolderId: "acct_1",
        name: "legacy",
        hashedSecret: "deadbeef",
        prefix: "ak_live_xxx",
        createdAt: new Date().toISOString(),
      },
    ] as unknown as ReturnType<ApiKeyService["serialize"]>;

    const [restored] = ApiKeyService.hydrate(legacy).list("acct_1");
    expect(restored?.scope).toBe("full");
    expect(restored?.provisionedCents).toBe(0);
    expect(restored?.spendCapCents).toBeUndefined();
  });

  it("stops authenticating a revoked key", () => {
    const keys = new ApiKeyService();
    const { key, secret } = keys.issue("acct_1", "temp");
    expect(keys.authenticate(secret)).toBeDefined();
    keys.revoke(key.id);
    expect(keys.authenticate(secret)).toBeUndefined();
  });
});
