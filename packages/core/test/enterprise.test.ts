import { beforeEach, describe, expect, it } from "vitest";
import { Platform } from "../src/platform.js";

let platform: Platform;
let holderId: string;

beforeEach(() => {
  platform = new Platform();
  const holder = platform.signup({ email: "cfo@aurora.co", name: "Aurora", currency: "ZAR", accountType: "enterprise" });
  holderId = holder.id;
  platform.fundWallet(holderId, 10_000_000); // R100 000.00
});

function auth(cardId: string, amount: number, category: string, id = "a_" + Math.random()) {
  return platform.authorize({ authorizationId: id, cardId, amount, currency: "ZAR", merchant: { name: "M", category } });
}

describe("enterprise: account type", () => {
  it("records the enterprise workspace type at signup", () => {
    expect(platform.getAccountHolder(holderId).accountType).toBe("enterprise");
    const personal = platform.signup({ email: "me@example.com", name: "Me" });
    expect(personal.accountType).toBe("personal");
  });
});

describe("enterprise: org policy enforced in the hot path", () => {
  it("blocks a category org-wide regardless of card rules", () => {
    platform.setPolicy(holderId, { blockedMerchantCategories: ["7995"] });
    const card = platform.createCard({ accountHolderId: holderId, singleUse: false }); // no card MCC restriction
    const d = auth(card.id, 1_000, "7995");
    expect(d.approved).toBe(false);
    expect(d.declineReason).toBe("merchant_category_blocked_by_policy");
  });

  it("routes to review at the org approval threshold even if the card has none", () => {
    platform.setPolicy(holderId, { blockedMerchantCategories: [], approvalThreshold: 5_000 });
    const card = platform.createCard({ accountHolderId: holderId, singleUse: false });
    const d = auth(card.id, 6_000, "5999");
    expect(d.approved).toBe(false);
    expect(d.declineReason).toBe("pending_human_approval");
    expect(d.approvalId).toBeDefined();
    // a smaller charge still clears
    expect(auth(card.id, 1_000, "5999").approved).toBe(true);
  });
});

describe("enterprise: department budgets", () => {
  it("declines once a department's monthly budget is exhausted, across its agents", () => {
    const eng = platform.createDepartment({ accountHolderId: holderId, name: "Engineering", monthlyBudget: 5_000 });
    const cardA = platform.createCard({ accountHolderId: holderId, singleUse: false, departmentId: eng.id });
    const cardB = platform.createCard({ accountHolderId: holderId, singleUse: false, departmentId: eng.id });

    expect(auth(cardA.id, 3_000, "5999").approved).toBe(true); // dept spend 3000
    // second agent, same department — 3000 + 3000 > 5000 budget
    const over = auth(cardB.id, 3_000, "5999");
    expect(over.approved).toBe(false);
    expect(over.declineReason).toBe("department_budget_exceeded");
    // a charge that fits the remaining budget clears
    expect(auth(cardB.id, 2_000, "5999").approved).toBe(true);
  });

  it("reports department spend for the finance/overview view", () => {
    const mkt = platform.createDepartment({ accountHolderId: holderId, name: "Marketing", monthlyBudget: 50_000 });
    const card = platform.createCard({ accountHolderId: holderId, singleUse: false, departmentId: mkt.id });
    auth(card.id, 4_000, "5999");
    const spend = platform.listDepartmentSpend(holderId);
    expect(spend).toHaveLength(1);
    expect(spend[0]!.department.name).toBe("Marketing");
    expect(spend[0]!.spentThisMonth).toBe(4_000);
    expect(spend[0]!.cardCount).toBe(1);
  });

  it("rejects a card assigned to another account's department", () => {
    const other = platform.signup({ email: "other@x.co", name: "Other", accountType: "enterprise" });
    const otherDept = platform.createDepartment({ accountHolderId: other.id, name: "X", monthlyBudget: 1000 });
    expect(() => platform.createCard({ accountHolderId: holderId, departmentId: otherDept.id })).toThrow(/department/);
  });
});

describe("enterprise: snapshot round-trip", () => {
  it("preserves departments and policy across hydrate", () => {
    platform.createDepartment({ accountHolderId: holderId, name: "Ops", monthlyBudget: 9_000 });
    platform.setPolicy(holderId, { blockedMerchantCategories: ["7995"], approvalThreshold: 100_000 });
    const restored = Platform.hydrate(platform.serialize());
    expect(restored.listDepartments(holderId)).toHaveLength(1);
    expect(restored.getPolicy(holderId).blockedMerchantCategories).toEqual(["7995"]);
    expect(restored.getPolicy(holderId).approvalThreshold).toBe(100_000);
    expect(restored.getAccountHolder(holderId).accountType).toBe("enterprise");
  });
});
