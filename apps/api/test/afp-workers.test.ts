import { describe, expect, it } from "vitest";
import { AfpLedger, createIntent } from "@acard/core";
import { InMemoryAfpLedger } from "../src/afp/index.js";
import { reconcileTransaction, runAfpTick, runSettlementSweep } from "../src/afp/workers.js";
import type { ReconcilableRail } from "../src/afp/workers.js";

const intent = (overrides = {}) =>
  createIntent({
    accountHolderId: "ah_1",
    amount: 19_900,
    currency: "USD",
    purpose: "OpenAI usage",
    counterparty: "https://api.openai.com",
    ...overrides,
  });

function rail(id: string, confirm?: ReconcilableRail["confirm"]): ReconcilableRail {
  return {
    profile: { id, label: id, finality: { kind: "instant" } } as never,
    carriesRealValue: true,
    quote: async () => ({ rail: id, available: true, costCents: 0, etaSeconds: 1 }) as never,
    execute: async () => ({ railReference: "r", immediate: true }),
    confirm,
  };
}

async function parkedTransaction(ledger: InMemoryAfpLedger, railId = "card") {
  const i = intent();
  await ledger.recordIntent(i);
  const tx = await ledger.beginExecution(i, railId as never, { kind: "reversal_window", reversalWindowDays: 120 }, `idem_${Math.random()}`);
  return ledger.markReconciling(tx.id, "connection dropped mid-execute");
}

describe("AFP settlement sweep", () => {
  it("settles only what its own clock says is due", async () => {
    const ledger = new InMemoryAfpLedger(new AfpLedger());
    const i = intent();
    await ledger.recordIntent(i);
    const tx = await ledger.beginExecution(i, "card", { kind: "settlement_delay", settlesAfterHours: 24 }, "idem_sweep");
    await ledger.completeExecution(tx.id, { railReference: "eft_1", immediate: false });

    const early = await runSettlementSweep({ ledger, rails: [], now: () => Date.now() });
    expect(early.settled).toHaveLength(0);

    const later = await runSettlementSweep({ ledger, rails: [], now: () => Date.now() + 25 * 60 * 60 * 1000 });
    expect(later.settled).toEqual([tx.id]);
    expect((await ledger.get(tx.id)).status).toBe("settled");
  });

  it("one stuck transaction does not stop the rest of the sweep", async () => {
    const ledger = new InMemoryAfpLedger(new AfpLedger());
    const i = intent();
    await ledger.recordIntent(i);
    const good = await ledger.beginExecution(i, "card", { kind: "settlement_delay", settlesAfterHours: 1 }, "idem_good");
    await ledger.completeExecution(good.id, { railReference: "ok", immediate: false });

    const future = () => Date.now() + 2 * 60 * 60 * 1000;
    // Make settle() throw for one id only.
    const realSettle = ledger.settle.bind(ledger);
    let first = true;
    ledger.settle = async (id: string) => {
      if (first) {
        first = false;
        throw new Error("row locked");
      }
      return realSettle(id);
    };

    const result = await runSettlementSweep({ ledger, rails: [], now: future });
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.error).toBe("row locked");
  });
});

describe("AFP reconciliation", () => {
  it("a rail confirming the payment happened settles it", async () => {
    const ledger = new InMemoryAfpLedger(new AfpLedger());
    const tx = await parkedTransaction(ledger);
    const result = await reconcileTransaction(
      { ledger, rails: [rail("card", async () => ({ happened: true, reference: "auth_confirmed" }))] },
      tx.id,
    );
    expect(result.outcome).toBe("settled");
    expect((await ledger.get(tx.id)).status).toBe("posted");
    expect((await ledger.get(tx.id)).railReference).toBe("auth_confirmed");
  });

  it("a rail confirming it never happened fails it", async () => {
    const ledger = new InMemoryAfpLedger(new AfpLedger());
    const tx = await parkedTransaction(ledger);
    const result = await reconcileTransaction({ ledger, rails: [rail("card", async () => ({ happened: false }))] }, tx.id);
    expect(result.outcome).toBe("failed");
    expect((await ledger.get(tx.id)).status).toBe("failed");
  });

  it("a rail that cannot tell yet leaves it parked — never guesses", async () => {
    const ledger = new InMemoryAfpLedger(new AfpLedger());
    const tx = await parkedTransaction(ledger);
    const result = await reconcileTransaction({ ledger, rails: [rail("card", async () => undefined)] }, tx.id);
    expect(result.outcome).toBe("still_unknown");
    expect((await ledger.get(tx.id)).status).toBe("reconciling");
  });

  it("a rail being unreachable leaves it parked — an outage says nothing about the money", async () => {
    const ledger = new InMemoryAfpLedger(new AfpLedger());
    const tx = await parkedTransaction(ledger);
    const result = await reconcileTransaction(
      { ledger, rails: [rail("card", async () => { throw new Error("timeout"); })] },
      tx.id,
    );
    expect(result.outcome).toBe("still_unknown");
    expect(result.detail).toMatch(/could not be reached/);
    expect((await ledger.get(tx.id)).status).toBe("reconciling");
  });

  it("a rail with no confirm capability leaves it for a human", async () => {
    const ledger = new InMemoryAfpLedger(new AfpLedger());
    const tx = await parkedTransaction(ledger);
    const result = await reconcileTransaction({ ledger, rails: [rail("card")] }, tx.id);
    expect(result.outcome).toBe("still_unknown");
    expect(result.detail).toMatch(/cannot confirm/);
  });

  it("a rail no longer configured on this instance is reported, not guessed at", async () => {
    const ledger = new InMemoryAfpLedger(new AfpLedger());
    const tx = await parkedTransaction(ledger, "stablecoin");
    const result = await reconcileTransaction({ ledger, rails: [rail("card")] }, tx.id);
    expect(result.outcome).toBe("no_rail");
    expect((await ledger.get(tx.id)).status).toBe("reconciling");
  });

  it("a transaction that is not reconciling is left alone", async () => {
    const ledger = new InMemoryAfpLedger(new AfpLedger());
    const i = intent();
    await ledger.recordIntent(i);
    const tx = await ledger.beginExecution(i, "card", { kind: "instant" }, "idem_settled");
    await ledger.completeExecution(tx.id, { railReference: "x", immediate: true });
    const result = await reconcileTransaction({ ledger, rails: [rail("card", async () => ({ happened: true }))] }, tx.id);
    expect(result.outcome).toBe("still_unknown");
    expect(result.detail).toMatch(/not reconciling/);
  });
});

describe("AFP tick", () => {
  it("settles what is due and works the reconciliation queue in one pass", async () => {
    const ledger = new InMemoryAfpLedger(new AfpLedger());

    const due = intent();
    await ledger.recordIntent(due);
    const dueTx = await ledger.beginExecution(due, "card", { kind: "settlement_delay", settlesAfterHours: 1 }, "idem_tick_due");
    await ledger.completeExecution(dueTx.id, { railReference: "eft", immediate: false });

    const parked = await parkedTransaction(ledger);

    const result = await runAfpTick({
      ledger,
      rails: [rail("card", async () => ({ happened: true, reference: "confirmed" }))],
      now: () => Date.now() + 2 * 60 * 60 * 1000,
    });

    expect(result.settlement.settled).toContain(dueTx.id);
    expect(result.reconciliation.map((r) => r.outcome)).toEqual(["settled"]);
    expect((await ledger.get(parked.id)).status).toBe("posted");
  });

  it("an empty ledger is a clean no-op", async () => {
    const ledger = new InMemoryAfpLedger(new AfpLedger());
    const result = await runAfpTick({ ledger, rails: [] });
    expect(result.settlement.examined).toBe(0);
    expect(result.reconciliation).toHaveLength(0);
  });
});
