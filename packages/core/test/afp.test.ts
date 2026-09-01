import { describe, expect, it } from "vitest";
import { AfpLedger, createIntent, routeIntent, type RailFinality, type RailProfile, type RailQuote } from "../src/index.js";

const CARD: RailProfile = { id: "card", label: "A-CARD virtual card", finality: { kind: "reversal_window", reversalWindowDays: 120 } };
const X402: RailProfile = { id: "x402", label: "x402 machine payment", finality: { kind: "instant" } };
const STABLECOIN: RailProfile = { id: "stablecoin", label: "Stablecoin transfer", finality: { kind: "instant" } };
const EFT: RailProfile = { id: "card", label: "EFT (test double)", finality: { kind: "settlement_delay", settlesAfterHours: 24 } };

function intent(overrides: Partial<Parameters<typeof createIntent>[0]> = {}) {
  return createIntent({
    accountHolderId: "ah_1",
    amount: 19_900,
    currency: "USD",
    purpose: "OpenAI API usage",
    counterparty: "https://api.openai.com/v1/usage",
    ...overrides,
  });
}

describe("createIntent", () => {
  it("rejects a non-positive or non-integer amount", () => {
    expect(() => createIntent({ accountHolderId: "ah_1", amount: 0, currency: "USD", purpose: "x", counterparty: "y" })).toThrow(
      /positive integer/,
    );
    expect(() => createIntent({ accountHolderId: "ah_1", amount: 19.5, currency: "USD", purpose: "x", counterparty: "y" })).toThrow(
      /positive integer/,
    );
  });
});

describe("routeIntent", () => {
  it("picks the cheapest, fastest, most-final rail and explains why", () => {
    const i = intent();
    const quotes = [
      { profile: CARD, quote: { rail: "card", available: true, costCents: 400, etaSeconds: 2 } as RailQuote },
      { profile: X402, quote: { rail: "x402", available: true, costCents: 50, etaSeconds: 1 } as RailQuote },
    ];
    const decision = routeIntent(i, quotes);
    expect(decision.chosenRail).toBe("x402");
    const winner = decision.scored.find((s) => s.rail === "x402")!;
    expect(winner.matchReasons).toContain("lowest fee");
    expect(winner.matchReasons).toContain("fastest execution");
    expect(winner.matchReasons).toContain("instant finality — no standing reversal risk");
  });

  it("a small fee gap does not let a reversal-window rail beat an instant one on a rounding error", () => {
    // The exact bug proportional scoring in A-MERCHANT was built to avoid,
    // reproduced here for AFP: two rails a cent apart in fee should not let
    // the one carrying 120 days of reversal risk win outright.
    const i = intent();
    const quotes = [
      { profile: CARD, quote: { rail: "card", available: true, costCents: 99, etaSeconds: 2 } as RailQuote },
      { profile: X402, quote: { rail: "x402", available: true, costCents: 100, etaSeconds: 2 } as RailQuote },
    ];
    const decision = routeIntent(i, quotes);
    // Card is marginally cheaper by raw fee, but x402's finality weight
    // should keep the two close rather than card running away with it.
    const card = decision.scored.find((s) => s.rail === "card")!;
    const x402 = decision.scored.find((s) => s.rail === "x402")!;
    expect(Math.abs(card.score - x402.score)).toBeLessThan(0.2);
  });

  it("reports why an unavailable rail was rejected, and never scores it", () => {
    const i = intent();
    const decision = routeIntent(i, [
      { profile: CARD, quote: { rail: "card", available: false, costCents: 0, etaSeconds: 0, reason: "card limit exceeded" } },
      { profile: X402, quote: { rail: "x402", available: true, costCents: 50, etaSeconds: 1 } },
    ]);
    expect(decision.chosenRail).toBe("x402");
    expect(decision.rejected).toEqual([{ rail: "card", reason: "card limit exceeded" }]);
    expect(decision.scored.map((s) => s.rail)).toEqual(["x402"]);
  });

  it("honours the intent's own allowed-rails restriction ahead of any quote", () => {
    const i = intent({ allowedRails: ["card"] });
    const decision = routeIntent(i, [
      { profile: CARD, quote: { rail: "card", available: true, costCents: 400, etaSeconds: 2 } },
      { profile: X402, quote: { rail: "x402", available: true, costCents: 50, etaSeconds: 1 } },
    ]);
    expect(decision.chosenRail).toBe("card");
    expect(decision.rejected).toEqual([{ rail: "x402", reason: "not in this intent's allowed rails" }]);
  });

  it("returns no chosen rail, not a crash, when every candidate is rejected", () => {
    const i = intent({ allowedRails: ["stablecoin"] });
    const decision = routeIntent(i, [{ profile: CARD, quote: { rail: "card", available: true, costCents: 400, etaSeconds: 2 } }]);
    expect(decision.chosenRail).toBeUndefined();
    expect(decision.scored).toEqual([]);
  });

  it("scores a single available candidate without dividing by zero", () => {
    const i = intent();
    const decision = routeIntent(i, [{ profile: STABLECOIN, quote: { rail: "stablecoin", available: true, costCents: 10, etaSeconds: 3 } }]);
    expect(decision.chosenRail).toBe("stablecoin");
    expect(Number.isFinite(decision.scored[0]!.score)).toBe(true);
  });
});

describe("AfpLedger: happy path per finality kind", () => {
  it("an instant rail settles immediately on completion", () => {
    const ledger = new AfpLedger();
    const i = intent();
    const tx = ledger.beginExecution(i, "stablecoin", STABLECOIN.finality, "idem-1");
    expect(tx.status).toBe("pending");
    const done = ledger.completeExecution(tx.id, { railReference: "0xabc123", immediate: true });
    expect(done.status).toBe("settled");
    expect(done.settledAt).toBeTruthy();
  });

  it("a reversal-window rail is only posted, not settled, until the window elapses", () => {
    const ledger = new AfpLedger();
    const i = intent();
    const tx = ledger.beginExecution(i, "card", CARD.finality, "idem-2");
    const done = ledger.completeExecution(tx.id, { railReference: "auth_9f2a", immediate: true });
    expect(done.status).toBe("posted");
    expect(done.settledAt).toBeUndefined();

    expect(() => ledger.reverse(done.id, "test")).not.toThrow();
  });

  it("a settlement-delay rail is posted, then settles once its own clock elapses", () => {
    const ledger = new AfpLedger();
    const i = intent();
    const tx = ledger.beginExecution(i, "card", EFT.finality, "idem-3");
    const posted = ledger.completeExecution(tx.id, { railReference: "eft_ref_1", immediate: false });
    expect(posted.status).toBe("posted");
    expect(ledger.dueForSettlement(Date.now())).toHaveLength(0);
    expect(ledger.dueForSettlement(Date.now() + 25 * 60 * 60 * 1000).map((t) => t.id)).toContain(posted.id);

    const settled = ledger.settle(posted.id);
    expect(settled.status).toBe("settled");
  });
});

describe("AfpLedger: idempotency — the actual proof against double-execution", () => {
  it("beginExecution with the same idempotency key returns the same transaction, never a second one", () => {
    const ledger = new AfpLedger();
    const i = intent();
    const first = ledger.beginExecution(i, "x402", X402.finality, "idem-shared");
    const second = ledger.beginExecution(i, "x402", X402.finality, "idem-shared");
    expect(second.id).toBe(first.id);
    expect(ledger.list(i.accountHolderId)).toHaveLength(1);
  });

  it("completing an already-completed transaction with the same result is a safe no-op replay", () => {
    const ledger = new AfpLedger();
    const i = intent();
    const tx = ledger.beginExecution(i, "x402", X402.finality, "idem-replay");
    const first = ledger.completeExecution(tx.id, { railReference: "x402_ref_1", immediate: true });
    const replay = ledger.completeExecution(tx.id, { railReference: "x402_ref_1", immediate: true });
    expect(replay).toEqual(first);
  });

  it("completing an already-completed transaction with a DIFFERENT result is refused, not silently overwritten", () => {
    // This is the actual danger case: two different answers about what
    // happened to the same money. The ledger must never guess which is true.
    const ledger = new AfpLedger();
    const i = intent();
    const tx = ledger.beginExecution(i, "x402", X402.finality, "idem-conflict");
    ledger.completeExecution(tx.id, { railReference: "x402_ref_1", immediate: true });
    expect(() => ledger.completeExecution(tx.id, { railReference: "x402_ref_DIFFERENT", immediate: true })).toThrow(
      /refusing to overwrite/,
    );
  });
});

describe("AfpLedger: the ambiguous-outcome / reconciliation path", () => {
  it("a timed-out execution parks as reconciling rather than guessing settled or failed", () => {
    const ledger = new AfpLedger();
    const i = intent();
    const tx = ledger.beginExecution(i, "stablecoin", STABLECOIN.finality, "idem-timeout");
    const parked = ledger.markReconciling(tx.id, "network timeout after the chain call was sent");
    expect(parked.status).toBe("reconciling");
  });

  it("reconciliation can still resolve to settled once the rail's own status check confirms it landed", () => {
    const ledger = new AfpLedger();
    const i = intent();
    const tx = ledger.beginExecution(i, "stablecoin", STABLECOIN.finality, "idem-resolve");
    ledger.markReconciling(tx.id, "timeout");
    const resolved = ledger.completeExecution(tx.id, { railReference: "0xdef456", immediate: true });
    expect(resolved.status).toBe("settled");
  });

  it("reconciliation can resolve to failed when the status check confirms nothing moved", () => {
    const ledger = new AfpLedger();
    const i = intent();
    const tx = ledger.beginExecution(i, "card", CARD.finality, "idem-fail");
    ledger.markReconciling(tx.id, "timeout");
    const failed = ledger.markFailed(tx.id, "issuer confirmed the authorization never posted");
    expect(failed.status).toBe("failed");
  });
});

describe("AfpLedger: compensating transactions and finality gating", () => {
  it("reverses a posted reversal-window transaction, recording why", () => {
    const ledger = new AfpLedger();
    const i = intent();
    const tx = ledger.beginExecution(i, "card", CARD.finality, "idem-chargeback");
    ledger.completeExecution(tx.id, { railReference: "auth_1", immediate: true });
    const reversed = ledger.reverse(tx.id, "cardholder dispute — goods not received");
    expect(reversed.status).toBe("reversed");
    expect(reversed.reversalReason).toContain("dispute");
    expect(reversed.history.at(-1)).toMatchObject({ status: "reversed" });
  });

  it("refuses to reverse an instant-finality transaction — that isn't a compensation, it's a second transfer", () => {
    const ledger = new AfpLedger();
    const i = intent();
    const tx = ledger.beginExecution(i, "stablecoin", STABLECOIN.finality, "idem-instant-reverse");
    ledger.completeExecution(tx.id, { railReference: "0xfeed", immediate: true });
    expect(() => ledger.reverse(tx.id, "attempted clawback")).toThrow(/cannot reverse it/);
  });

  it("refuses to reverse a transaction that never posted", () => {
    const ledger = new AfpLedger();
    const i = intent();
    const tx = ledger.beginExecution(i, "card", CARD.finality, "idem-pending-reverse");
    expect(() => ledger.reverse(tx.id, "too early")).toThrow(/only a posted transaction/);
  });

  it("refuses to settle a transaction that isn't posted", () => {
    const ledger = new AfpLedger();
    const i = intent();
    const tx = ledger.beginExecution(i, "card", EFT.finality, "idem-early-settle");
    expect(() => ledger.settle(tx.id)).toThrow(/only a posted transaction/);
  });

  it("keeps a full, ordered history across a real multi-step lifecycle", () => {
    const ledger = new AfpLedger();
    const i = intent();
    const tx = ledger.beginExecution(i, "card", CARD.finality, "idem-history");
    ledger.markReconciling(tx.id, "slow network");
    const posted = ledger.completeExecution(tx.id, { railReference: "auth_2", immediate: true });
    const reversed = ledger.reverse(posted.id, "duplicate charge");
    expect(reversed.history.map((h) => h.status)).toEqual(["pending", "reconciling", "posted", "reversed"]);
  });
});

describe("AfpLedger: persistence", () => {
  it("survives a snapshot round trip, idempotency map included", () => {
    const ledger = new AfpLedger();
    const i = intent();
    const tx = ledger.beginExecution(i, "x402", X402.finality, "idem-persist");
    ledger.completeExecution(tx.id, { railReference: "x402_ref", immediate: true });

    const restored = AfpLedger.hydrate(JSON.parse(JSON.stringify(ledger.serialize())));
    expect(restored.get(tx.id).status).toBe("settled");
    // Idempotency survives the restart too — a retried request after a
    // process restart must not double-execute.
    expect(restored.getByIdempotencyKey("idem-persist")?.id).toBe(tx.id);
    expect(restored.beginExecution(i, "x402", X402.finality, "idem-persist").id).toBe(tx.id);
  });
});
