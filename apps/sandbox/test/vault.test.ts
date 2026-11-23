import { describe, expect, it } from "vitest";
import { SandboxVault } from "../src/vault.js";

describe("SandboxVault stand-ins", () => {
  it("are single use, bound to merchant and amount", () => {
    const v = new SandboxVault();
    v.attach({ number: "4242424242424242", exp: "12/30", holder: "T" });
    const p = v.request({ merchant: "Shop", category: "5411", amountCents: 5000, blockedCategories: [] });
    expect(p.status).toBe("paid");
    // the checkout already used it: any further charge is refused
    expect(v.charge(p.id, "Shop", 5000)).toEqual({ ok: false, reason: "stand_in_already_used" });
  });

  it("refuse a higher amount or a different merchant before use", () => {
    const v = new SandboxVault();
    v.attach({ number: "4242424242424242", exp: "12/30", holder: "T" });
    v.setSettings({ autoApproveCents: 0 });
    const p = v.request({ merchant: "Shop", category: "5411", amountCents: 5000, blockedCategories: [] });
    expect(p.status).toBe("awaiting_approval");
    expect(v.charge(p.id, "Shop", 5000)).toEqual({ ok: false, reason: "no_stand_in" }); // nothing exists before approval
    const card = v.cards[0]!;
    v.remove(card.id);
    expect(v.decide(p.id, true)).toMatchObject({ status: "declined", reason: "card_removed" });
  });

  it("only the holder's decision moves a held purchase, once", () => {
    const v = new SandboxVault();
    v.attach({ number: "378282246310005", exp: "12/30", holder: "T" });
    const p = v.request({ merchant: "Shop", category: "5411", amountCents: 50_000, blockedCategories: [] });
    expect(v.decide(p.id, false)).toMatchObject({ status: "denied" });
    expect(() => v.decide(p.id, true)).toThrow();
  });
});
