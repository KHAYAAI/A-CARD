import { describe, expect, it } from "vitest";
import { MerchantAuthService } from "../src/index.js";

const OP = "compliance@a-card.cc";
const PROFILE = { workosUserId: "wu_1", email: "owner@kasihardware.co.za", name: "Thabo" };

describe("MerchantAuthService: invites", () => {
  it("requires an attributed issuer, mirroring the KYB rule elsewhere", () => {
    const auth = new MerchantAuthService();
    expect(() => auth.createInvite("mch_1", "owner", "")).toThrow(/issued it/);
  });

  it("redeems an invite into a new user, and refuses to redeem it twice", () => {
    const auth = new MerchantAuthService();
    const { token } = auth.createInvite("mch_1", "owner", OP);
    const user = auth.redeemInvite(token, PROFILE);
    expect(user.merchantId).toBe("mch_1");
    expect(user.role).toBe("owner");
    expect(user.email).toBe(PROFILE.email);

    expect(() => auth.redeemInvite(token, PROFILE)).toThrow(/already been used/);
  });

  it("rejects an unknown token", () => {
    const auth = new MerchantAuthService();
    expect(() => auth.redeemInvite("nope", PROFILE)).toThrow(/invalid/);
  });

  it("rejects an expired invite", () => {
    // The service has no injectable clock, so the direct way to exercise the
    // expiry branch is: mint a real invite (to get its correctly-hashed
    // token), then hydrate a snapshot with that same record backdated. The
    // plaintext token survives because `redeemInvite` only ever needs the
    // token itself, never the stored hash — see the "never stores the
    // plaintext" test for why the snapshot alone can't be replayed.
    const auth = new MerchantAuthService();
    const { token } = auth.createInvite("mch_1", "owner", OP);
    const backdated = auth.serialize();
    backdated.invites = backdated.invites.map((i) => ({ ...i, expiresAt: new Date(0).toISOString() }));
    const expired = MerchantAuthService.hydrate(JSON.parse(JSON.stringify(backdated)));
    expect(() => expired.redeemInvite(token, PROFILE)).toThrow(/expired/);
  });

  it("peekInvite reports validity without consuming it", () => {
    const auth = new MerchantAuthService();
    const { token } = auth.createInvite("mch_1", "owner", OP);
    expect(auth.peekInvite(token)?.consumedAt).toBeUndefined();
    expect(auth.peekInvite("bogus")).toBeUndefined();
    auth.redeemInvite(token, PROFILE);
    // Redeeming doesn't invalidate the lookup itself — the caller checks `consumedAt`.
    expect(auth.peekInvite(token)?.consumedAt).toBeTruthy();
  });

  it("never stores the plaintext invite token", () => {
    const auth = new MerchantAuthService();
    const { token } = auth.createInvite("mch_1", "owner", OP);
    expect(JSON.stringify(auth.serialize())).not.toContain(token);
  });

  it("lists invites scoped to one merchant", () => {
    const auth = new MerchantAuthService();
    auth.createInvite("mch_1", "owner", OP);
    auth.createInvite("mch_2", "owner", OP);
    expect(auth.listInvites("mch_1")).toHaveLength(1);
  });
});

describe("MerchantAuthService: identity across merchants", () => {
  it("the same WorkOS identity redeeming invites for two different merchants gets two distinct users", () => {
    const auth = new MerchantAuthService();
    const inviteA = auth.createInvite("mch_a", "owner", OP);
    const inviteB = auth.createInvite("mch_b", "owner", OP);
    const userA = auth.redeemInvite(inviteA.token, PROFILE);
    const userB = auth.redeemInvite(inviteB.token, PROFILE);
    expect(userA.id).not.toBe(userB.id);
    expect(userA.merchantId).toBe("mch_a");
    expect(userB.merchantId).toBe("mch_b");
  });

  it("the same WorkOS identity redeeming a second invite for the *same* merchant reuses the user", () => {
    const auth = new MerchantAuthService();
    const first = auth.createInvite("mch_1", "owner", OP);
    const userFirst = auth.redeemInvite(first.token, PROFILE);
    const second = auth.createInvite("mch_1", "staff", OP);
    const userSecond = auth.redeemInvite(second.token, PROFILE);
    expect(userSecond.id).toBe(userFirst.id);
  });
});

describe("MerchantAuthService: sessions", () => {
  it("issues a session that resolves back to the right merchant and role", () => {
    const auth = new MerchantAuthService();
    const { token: invite } = auth.createInvite("mch_1", "staff", OP);
    const user = auth.redeemInvite(invite, PROFILE);
    const { token } = auth.createSession(user);
    const ctx = auth.resolveSession(token);
    expect(ctx).toEqual({ merchantUserId: user.id, merchantId: "mch_1", role: "staff" });
  });

  it("rejects a garbage token and a revoked one", () => {
    const auth = new MerchantAuthService();
    expect(auth.resolveSession("nope")).toBeUndefined();
    const { token: invite } = auth.createInvite("mch_1", "owner", OP);
    const user = auth.redeemInvite(invite, PROFILE);
    const { token } = auth.createSession(user);
    expect(auth.resolveSession(token)).toBeDefined();
    auth.revokeSession(token);
    expect(auth.resolveSession(token)).toBeUndefined();
  });

  it("never stores the plaintext session token", () => {
    const auth = new MerchantAuthService();
    const { token: invite } = auth.createInvite("mch_1", "owner", OP);
    const user = auth.redeemInvite(invite, PROFILE);
    const { token } = auth.createSession(user);
    expect(JSON.stringify(auth.serialize())).not.toContain(token);
  });

  it("survives a snapshot round trip", () => {
    const auth = new MerchantAuthService();
    const { token: invite } = auth.createInvite("mch_1", "owner", OP);
    const user = auth.redeemInvite(invite, PROFILE);
    const { token } = auth.createSession(user);

    const restored = MerchantAuthService.hydrate(JSON.parse(JSON.stringify(auth.serialize())));
    expect(restored.resolveSession(token)).toEqual({ merchantUserId: user.id, merchantId: "mch_1", role: "owner" });
    expect(restored.getUser(user.id).email).toBe(PROFILE.email);
  });
});
