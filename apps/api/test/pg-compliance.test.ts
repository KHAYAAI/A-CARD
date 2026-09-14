import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { canMoveMoney, ComplianceService } from "@acard/core";
import { PostgresComplianceStore } from "../src/compliance/index.js";

/**
 * Integration tests for the multi-writer Postgres compliance store. Skipped
 * unless ACARD_TEST_DATABASE_URL points at a reachable Postgres.
 *
 * The load-bearing test is the concurrency one: two simultaneous `open()`
 * calls for the same subject must produce ONE record. Without that, a double
 * signup click creates two verification sessions — which on a live provider
 * means charging the customer's verification twice and leaving two records
 * that can disagree with each other.
 */
const DB_URL = process.env.ACARD_TEST_DATABASE_URL;
const suite = DB_URL ? describe : describe.skip;

const store = DB_URL ? new PostgresComplianceStore(DB_URL) : (undefined as unknown as PostgresComplianceStore);

afterAll(async () => {
  if (DB_URL) await store.close();
});

suite("PostgresComplianceStore (multi-writer)", () => {
  beforeEach(async () => {
    await store.migrate();
    await (store as unknown as { pool: { query: (sql: string) => Promise<unknown> } }).pool.query(
      "TRUNCATE acard_verifications CASCADE",
    );
  });

  it("migrate() is idempotent", async () => {
    await store.migrate();
    await store.migrate();
  });

  it("opens a record and finds it by subject", async () => {
    const record = await store.open("account_holder", "ah_1");
    expect(record.providerDecision).toBe("not_started");
    expect((await store.find("account_holder", "ah_1"))?.id).toBe(record.id);
  });

  it("open() is idempotent for the same subject", async () => {
    const first = await store.open("account_holder", "ah_1");
    const second = await store.open("account_holder", "ah_1");
    expect(second.id).toBe(first.id);
  });

  it("concurrency: ten simultaneous open() calls create exactly one record", async () => {
    const results = await Promise.all(Array.from({ length: 10 }, () => store.open("account_holder", "ah_race")));
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect((await store.list({ subject: "account_holder" })).filter((r) => r.subjectId === "ah_race")).toHaveLength(1);
  });

  it("the same id under a different subject is a different record", async () => {
    const person = await store.open("account_holder", "x_1");
    const business = await store.open("merchant", "x_1");
    expect(business.id).not.toBe(person.id);
  });

  it("attaches a session and resolves the record by it", async () => {
    const record = await store.open("account_holder", "ah_1");
    const attached = await store.attachSession(record.id, {
      providerSessionId: "sess_pg_1",
      providerWorkflowId: "wf_kyc",
      verificationUrl: "https://verify.example/1",
    });
    expect(attached.providerDecision).toBe("pending");
    expect((await store.findByProviderSession("sess_pg_1"))?.id).toBe(record.id);
  });

  it("refuses to rebind to a different session", async () => {
    const record = await store.open("account_holder", "ah_1");
    await store.attachSession(record.id, { providerSessionId: "sess_a", providerWorkflowId: "wf" });
    await expect(store.attachSession(record.id, { providerSessionId: "sess_b", providerWorkflowId: "wf" })).rejects.toThrow(
      /already bound/,
    );
  });

  it("a replayed webhook decision does not duplicate history", async () => {
    const record = await store.open("account_holder", "ah_1");
    await store.attachSession(record.id, { providerSessionId: "sess_r", providerWorkflowId: "wf" });
    const first = await store.recordProviderDecision(record.id, { status: "approved", amlRisk: "clear" });
    const replay = await store.recordProviderDecision(record.id, { status: "approved", amlRisk: "clear" });
    expect(replay.history).toHaveLength(first.history.length);
  });

  it("an override is stored alongside the provider decision, never replacing it", async () => {
    const record = await store.open("account_holder", "ah_1");
    await store.attachSession(record.id, { providerSessionId: "sess_o", providerWorkflowId: "wf" });
    await store.recordProviderDecision(record.id, { status: "approved", amlRisk: "hit" });
    const overridden = await store.override(record.id, {
      status: "approved",
      decidedBy: "compliance@a-card.cc",
      reason: "false positive",
    });
    expect(overridden.providerDecision).toBe("approved");
    expect(overridden.amlRisk).toBe("hit");
    expect(overridden.override?.decidedBy).toBe("compliance@a-card.cc");
    expect(canMoveMoney(overridden)).toBe(true);
  });

  it("the review queue excludes anything a human already decided", async () => {
    const reviewed = await store.open("account_holder", "ah_review");
    await store.attachSession(reviewed.id, { providerSessionId: "s1", providerWorkflowId: "wf" });
    await store.recordProviderDecision(reviewed.id, { status: "in_review" });

    const handled = await store.open("merchant", "mch_handled");
    await store.attachSession(handled.id, { providerSessionId: "s2", providerWorkflowId: "wf" });
    await store.recordProviderDecision(handled.id, { status: "approved", amlRisk: "possible_match" });
    await store.override(handled.id, { status: "approved", decidedBy: "ops@a-card.cc", reason: "not the same entity" });

    const queue = await store.pendingReview();
    expect(queue.map((r) => r.subjectId)).toEqual(["ah_review"]);
  });

  it("list() filters on effective status, folding in the override", async () => {
    const record = await store.open("account_holder", "ah_1");
    await store.attachSession(record.id, { providerSessionId: "s_eff", providerWorkflowId: "wf" });
    await store.recordProviderDecision(record.id, { status: "approved", amlRisk: "clear" });
    await store.override(record.id, { status: "declined", decidedBy: "ops@a-card.cc", reason: "manual review failed" });

    expect(await store.list({ status: "declined" })).toHaveLength(1);
    expect(await store.list({ status: "approved" })).toHaveLength(0);
  });

  it("matches the in-memory service for the identical lifecycle", async () => {
    const memory = new ComplianceService();
    const memRecord = memory.open("account_holder", "ah_parity");
    memory.attachSession(memRecord.id, { providerSessionId: "sess_parity", providerWorkflowId: "wf" });
    const memDone = memory.recordProviderDecision(memRecord.id, { status: "approved", amlRisk: "clear" });

    const pgRecord = await store.open("account_holder", "ah_parity");
    await store.attachSession(pgRecord.id, { providerSessionId: "sess_parity", providerWorkflowId: "wf" });
    const pgDone = await store.recordProviderDecision(pgRecord.id, { status: "approved", amlRisk: "clear" });

    expect(pgDone.providerDecision).toBe(memDone.providerDecision);
    expect(pgDone.amlRisk).toBe(memDone.amlRisk);
    expect(pgDone.history.map((h) => h.status)).toEqual(memDone.history.map((h) => h.status));
    expect(canMoveMoney(pgDone)).toBe(canMoveMoney(memDone));
  });
});
