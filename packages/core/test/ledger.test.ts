import { describe, expect, it } from "vitest";
import { createLedgerStore, Ledger } from "../src/ledger.js";

function setup() {
  const ledger = new Ledger(createLedgerStore());
  const settlement = ledger.createAccount({ name: "settlement", type: "asset", currency: "ZAR" });
  const wallet = ledger.createAccount({ name: "wallet", type: "liability", currency: "ZAR" });
  return { ledger, settlement, wallet };
}

describe("ledger", () => {
  it("rejects unbalanced transactions", () => {
    const { ledger, settlement, wallet } = setup();
    expect(() =>
      ledger.post({
        currency: "ZAR",
        description: "bad",
        postings: [
          { accountId: settlement.id, direction: "debit", amount: 100 },
          { accountId: wallet.id, direction: "credit", amount: 90 },
        ],
      }),
    ).toThrow(/debits/);
  });

  it("rejects non-positive and non-integer amounts", () => {
    const { ledger, settlement, wallet } = setup();
    for (const amount of [0, -5, 10.5]) {
      expect(() =>
        ledger.post({
          currency: "ZAR",
          description: "bad",
          postings: [
            { accountId: settlement.id, direction: "debit", amount },
            { accountId: wallet.id, direction: "credit", amount },
          ],
        }),
      ).toThrow();
    }
  });

  it("tracks posted, held, and available balances through hold → capture", () => {
    const { ledger, settlement, wallet } = setup();
    ledger.post({
      currency: "ZAR",
      description: "top-up",
      postings: [
        { accountId: settlement.id, direction: "debit", amount: 10_000 },
        { accountId: wallet.id, direction: "credit", amount: 10_000 },
      ],
    });
    expect(ledger.availableBalance(wallet.id)).toBe(10_000);

    const hold = ledger.hold({
      currency: "ZAR",
      description: "auth",
      spendingAccountId: wallet.id,
      amount: 4_000,
      postings: [
        { accountId: wallet.id, direction: "debit", amount: 4_000 },
        { accountId: settlement.id, direction: "credit", amount: 4_000 },
      ],
    });
    expect(ledger.availableBalance(wallet.id)).toBe(6_000);
    expect(ledger.postedBalance(wallet.id)).toBe(10_000);
    expect(ledger.heldAmount(wallet.id)).toBe(4_000);

    ledger.capture(hold.id);
    expect(ledger.postedBalance(wallet.id)).toBe(6_000);
    expect(ledger.heldAmount(wallet.id)).toBe(0);
    expect(ledger.availableBalance(wallet.id)).toBe(6_000);
  });

  it("supports partial capture and release", () => {
    const { ledger, settlement, wallet } = setup();
    ledger.post({
      currency: "ZAR",
      description: "top-up",
      postings: [
        { accountId: settlement.id, direction: "debit", amount: 5_000 },
        { accountId: wallet.id, direction: "credit", amount: 5_000 },
      ],
    });
    const hold1 = ledger.hold({
      currency: "ZAR",
      description: "auth1",
      spendingAccountId: wallet.id,
      amount: 2_000,
      postings: [
        { accountId: wallet.id, direction: "debit", amount: 2_000 },
        { accountId: settlement.id, direction: "credit", amount: 2_000 },
      ],
    });
    ledger.capture(hold1.id, 1_500);
    expect(ledger.postedBalance(wallet.id)).toBe(3_500);

    const hold2 = ledger.hold({
      currency: "ZAR",
      description: "auth2",
      spendingAccountId: wallet.id,
      amount: 1_000,
      postings: [
        { accountId: wallet.id, direction: "debit", amount: 1_000 },
        { accountId: settlement.id, direction: "credit", amount: 1_000 },
      ],
    });
    ledger.release(hold2.id);
    expect(ledger.availableBalance(wallet.id)).toBe(3_500);
  });

  it("blocks holds beyond available balance (overspend guard)", () => {
    const { ledger, settlement, wallet } = setup();
    ledger.post({
      currency: "ZAR",
      description: "top-up",
      postings: [
        { accountId: settlement.id, direction: "debit", amount: 1_000 },
        { accountId: wallet.id, direction: "credit", amount: 1_000 },
      ],
    });
    ledger.hold({
      currency: "ZAR",
      description: "auth1",
      spendingAccountId: wallet.id,
      amount: 800,
      postings: [
        { accountId: wallet.id, direction: "debit", amount: 800 },
        { accountId: settlement.id, direction: "credit", amount: 800 },
      ],
    });
    expect(() =>
      ledger.hold({
        currency: "ZAR",
        description: "auth2",
        spendingAccountId: wallet.id,
        amount: 300,
        postings: [
          { accountId: wallet.id, direction: "debit", amount: 300 },
          { accountId: settlement.id, direction: "credit", amount: 300 },
        ],
      }),
    ).toThrow(/exceeds available/);
  });

  it("refuses double capture or capturing a released hold", () => {
    const { ledger, settlement, wallet } = setup();
    ledger.post({
      currency: "ZAR",
      description: "top-up",
      postings: [
        { accountId: settlement.id, direction: "debit", amount: 1_000 },
        { accountId: wallet.id, direction: "credit", amount: 1_000 },
      ],
    });
    const hold = ledger.hold({
      currency: "ZAR",
      description: "auth",
      spendingAccountId: wallet.id,
      amount: 500,
      postings: [
        { accountId: wallet.id, direction: "debit", amount: 500 },
        { accountId: settlement.id, direction: "credit", amount: 500 },
      ],
    });
    ledger.capture(hold.id);
    expect(() => ledger.capture(hold.id)).toThrow(/not held/);
    expect(() => ledger.release(hold.id)).toThrow(/not held/);
  });
});
