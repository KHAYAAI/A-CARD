import { describe, expect, it } from "vitest";
import { customerLine, statement, DEFAULT_TERMS } from "../src/partners/index.js";

const tx = (o: any) => ({ id: Math.random().toString(), accountHolderId: "h", merchantName: "m", merchantCategory: "5999", currency: "USD", status: "completed", createdAt: "2026-11-10T10:00:00Z", ...o });
const partner = { id: "p", accountHolderId: "x", name: "P", brand: { displayName: "P" }, terms: DEFAULT_TERMS, createdAt: "" };

describe("revenue maths", () => {
  it("counts captures minus refunds in the month, per currency; ignores holds, declines and other months", () => {
    const l = customerLine("h", "r", [
      tx({ type: "capture", amount: 10_000, cardId: "c1" }),
      tx({ type: "capture", amount: 5_000, cardId: "c1", currency: "ZAR" }),
      tx({ type: "refund", amount: 2_000, cardId: "c1" }),
      tx({ type: "authorization", status: "pending", amount: 99_999, cardId: "c2" }),
      tx({ type: "declined", status: "declined", amount: 99_999, cardId: "c3" }),
      tx({ type: "capture", amount: 99_999, cardId: "c4", createdAt: "2026-10-31T23:59:59Z" }),
    ], "2026-11");
    expect(l).toEqual({ accountHolderId: "h", externalRef: "r", volume: { USD: 8_000, ZAR: 5_000 }, activeCards: 1, transactions: 3 });
  });
  it("applies the minimum only in the terms currency, above it charges usage", () => {
    const big = statement(partner, "2026-11", [{ accountHolderId: "h", volume: { USD: 40_000_000, ZAR: 1_000_000 }, activeCards: 2_000, transactions: 1 }]);
    expect(big.fees).toEqual({ volume: { USD: 400_000, ZAR: 10_000 }, activeCards: 100_000, minimumTopUp: 0, total: { USD: 500_000, ZAR: 10_000 } });
  });
});
