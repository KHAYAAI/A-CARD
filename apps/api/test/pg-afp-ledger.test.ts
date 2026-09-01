import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { AfpLedger, createIntent } from "@acard/core";
import { PostgresAfpLedger } from "../src/afp/index.js";

/**
 * Integration tests for the multi-writer Postgres AFP ledger — real tables,
 * real transactions, real concurrent requests. Skipped unless
 * ACARD_TEST_DATABASE_URL points at a reachable Postgres.
 *
 * The most important test here is the concurrency one: it fires ten
 * simultaneous `beginExecution` calls carrying the *same* idempotency key
 * at a real connection pool and asserts exactly one transaction exists
 * afterward. That's the actual proof the UNIQUE index (not just
 * application-level logic that a single JS thread would never race) is
 * what makes this safe under two real API tasks.
 */
const DB_URL = process.env.ACARD_TEST_DATABASE_URL;
const suite = DB_URL ? describe : describe.skip;

const ledger = DB_URL ? new PostgresAfpLedger(DB_URL) : (undefined as unknown as PostgresAfpLedger);

function intent(overrides: Partial<Parameters<typeof createIntent>[0]> = {}) {
  return createIntent({
    accountHolderId: "ah_1",
    amount: 19_900,
    currency: "USD",
    purpose: "OpenAI usage",
    counterparty: "https://api.openai.com",
    ...overrides,
  });
}

suite("PostgresAfpLedger (multi-writer)", () => {
  beforeEach(async () => {
    await ledger.migrate();
    await (ledger as unknown as { pool: { query: (sql: string) => Promise<unknown> } }).pool.query(
      "TRUNCATE acard_afp_transactions, acard_afp_intents CASCADE",
    );
  });

  afterAll(async () => {
    if (DB_URL) await ledger.close();
  });

  it("migrate() is idempotent", async () => {
    await ledger.migrate();
    await ledger.migrate();
  });

  it("records and fetches an intent", async () => {
    const i = intent();
    await ledger.recordIntent(i);
    const fetched = await ledger.getIntent(i.id);
    expect(fetched).toEqual(i);
  });

  it("an unknown intent 404s", async () => {
    await expect(ledger.getIntent("afpi_nope")).rejects.toThrow();
  });

  it("takes an instant-finality transaction straight to settled", async () => {
    const i = intent();
    await ledger.recordIntent(i);
    const tx = await ledger.beginExecution(i, "stablecoin", { kind: "instant" }, "pg-idem-1");
    expect(tx.status).toBe("pending");
    const done = await ledger.completeExecution(tx.id, { railReference: "0xabc", immediate: true });
    expect(done.status).toBe("settled");
    expect(done.settledAt).toBeTruthy();
  });

  it("a reversal-window transaction is only posted until settle() or reverse()", async () => {
    const i = intent();
    await ledger.recordIntent(i);
    const tx = await ledger.beginExecution(i, "card", { kind: "reversal_window", reversalWindowDays: 120 }, "pg-idem-2");
    const posted = await ledger.completeExecution(tx.id, { railReference: "auth_1", immediate: true });
    expect(posted.status).toBe("posted");

    const reversed = await ledger.reverse(posted.id, "cardholder dispute");
    expect(reversed.status).toBe("reversed");
    expect(reversed.reversalReason).toBe("cardholder dispute");
  });

  it("refuses to reverse an instant-finality transaction", async () => {
    const i = intent();
    await ledger.recordIntent(i);
    const tx = await ledger.beginExecution(i, "stablecoin", { kind: "instant" }, "pg-idem-3");
    const settled = await ledger.completeExecution(tx.id, { railReference: "0xdef", immediate: true });
    await expect(ledger.reverse(settled.id, "attempted clawback")).rejects.toThrow(/cannot reverse it/);
  });

  it("a settlement-delay transaction becomes due once its clock elapses, and settle() closes it", async () => {
    const i = intent();
    await ledger.recordIntent(i);
    const tx = await ledger.beginExecution(i, "card", { kind: "settlement_delay", settlesAfterHours: 24 }, "pg-idem-4");
    const posted = await ledger.completeExecution(tx.id, { railReference: "eft_1", immediate: false });

    expect(await ledger.dueForSettlement(Date.now())).toHaveLength(0);
    const due = await ledger.dueForSettlement(Date.now() + 25 * 60 * 60 * 1000);
    expect(due.map((t) => t.id)).toContain(posted.id);

    const settled = await ledger.settle(posted.id);
    expect(settled.status).toBe("settled");
  });

  it("completing with a conflicting result is refused, not silently overwritten", async () => {
    const i = intent();
    await ledger.recordIntent(i);
    const tx = await ledger.beginExecution(i, "stablecoin", { kind: "instant" }, "pg-idem-5");
    await ledger.completeExecution(tx.id, { railReference: "0xaaa", immediate: true });
    await expect(ledger.completeExecution(tx.id, { railReference: "0xBBB", immediate: true })).rejects.toThrow(/refusing to overwrite/);
  });

  it("the reconciliation path: pending -> reconciling -> resolved", async () => {
    const i = intent();
    await ledger.recordIntent(i);
    const tx = await ledger.beginExecution(i, "card", { kind: "reversal_window", reversalWindowDays: 120 }, "pg-idem-6");
    const parked = await ledger.markReconciling(tx.id, "network timeout");
    expect(parked.status).toBe("reconciling");
    const failed = await ledger.markFailed(parked.id, "issuer confirmed it never posted");
    expect(failed.status).toBe("failed");
    expect(failed.history.map((h) => h.status)).toEqual(["pending", "reconciling", "failed"]);
  });

  it("list() is scoped to the account holder", async () => {
    const mine = intent({ accountHolderId: "ah_mine" });
    const theirs = intent({ accountHolderId: "ah_theirs" });
    await ledger.recordIntent(mine);
    await ledger.recordIntent(theirs);
    await ledger.beginExecution(mine, "stablecoin", { kind: "instant" }, "pg-idem-mine");
    await ledger.beginExecution(theirs, "stablecoin", { kind: "instant" }, "pg-idem-theirs");
    const mineList = await ledger.list("ah_mine");
    expect(mineList).toHaveLength(1);
    expect(mineList[0]!.accountHolderId).toBe("ah_mine");
  });

  it("matches the in-memory ledger's behavior for the identical lifecycle", async () => {
    const memory = new AfpLedger();
    const i = intent();
    await ledger.recordIntent(i);
    memory.recordIntent(i);

    const pgTx = await ledger.beginExecution(i, "card", { kind: "reversal_window", reversalWindowDays: 120 }, "pg-idem-parity");
    const memTx = memory.beginExecution(i, "card", { kind: "reversal_window", reversalWindowDays: 120 }, "pg-idem-parity");

    const pgDone = await ledger.completeExecution(pgTx.id, { railReference: "auth_parity", immediate: true });
    const memDone = memory.completeExecution(memTx.id, { railReference: "auth_parity", immediate: true });
    expect(pgDone.status).toBe(memDone.status);
    expect(pgDone.finality).toEqual(memDone.finality);
  });

  it("concurrency: ten simultaneous beginExecution calls with the same idempotency key produce exactly one transaction", async () => {
    const i = intent();
    await ledger.recordIntent(i);
    const results = await Promise.all(
      Array.from({ length: 10 }, () => ledger.beginExecution(i, "stablecoin", { kind: "instant" }, "pg-idem-race")),
    );
    const ids = new Set(results.map((r) => r.id));
    expect(ids.size).toBe(1);

    const all = await ledger.list(i.accountHolderId);
    expect(all.filter((t) => t.idempotencyKey === "pg-idem-race")).toHaveLength(1);
  });
});
