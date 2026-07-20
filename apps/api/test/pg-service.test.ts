import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { PostgresPlatformService } from "../src/service/postgres.js";

/**
 * Integration tests for the multi-writer Postgres store. These exercise the
 * real row-level ledger and, crucially, the per-wallet `FOR UPDATE` lock that
 * makes the overspend guard correct when several requests hit one wallet at
 * once. Skipped unless ACARD_TEST_DATABASE_URL points at a reachable Postgres.
 */
const DB_URL = process.env.ACARD_TEST_DATABASE_URL;
const suite = DB_URL ? describe : describe.skip;

const service = DB_URL ? new PostgresPlatformService(DB_URL) : (undefined as unknown as PostgresPlatformService);

const TABLES = [
  "acard_open_holds",
  "acard_card_transactions",
  "acard_postings",
  "acard_ledger_transactions",
  "acard_approvals",
  "acard_cards",
  "acard_api_keys",
  "acard_idempotency",
  "acard_events_seen",
  "acard_events",
  "acard_settlement_accounts",
  "acard_sessions",
  "acard_memberships",
  "acard_users",
  "acard_accounts",
  "acard_account_holders",
];

suite("PostgresPlatformService (multi-writer ledger)", () => {
  beforeEach(async () => {
    await service.migrate();
    // Reach into the pool for a fast test-only truncate between cases.
    await (service as unknown as { pool: { query: (sql: string) => Promise<unknown> } }).pool.query(
      `TRUNCATE ${TABLES.join(", ")} RESTART IDENTITY CASCADE`,
    );
  });

  afterAll(async () => {
    if (service) await service.close();
  });

  async function fundedHolder(amount = 100_000) {
    const holder = await service.signup({ email: `u${Date.now()}${Math.random()}@x.co.za`, name: "U", currency: "ZAR" });
    await service.fundWallet(holder.id, amount);
    return holder;
  }

  it("funds, holds, and captures with correct balances", async () => {
    const holder = await fundedHolder(100_000);
    const card = await service.createCard({ accountHolderId: holder.id, singleUse: false });

    const decision = await service.authorize({
      authorizationId: "auth_1",
      cardId: card.id,
      amount: 25_000,
      currency: "ZAR",
      merchant: { name: "Takealot", category: "5999" },
    });
    expect(decision.approved).toBe(true);
    expect((await service.walletBalance(holder.id)).available).toBe(75_000);
    expect((await service.walletBalance(holder.id)).held).toBe(25_000);

    await service.capture("auth_1");
    const bal = await service.walletBalance(holder.id);
    expect(bal.posted).toBe(75_000);
    expect(bal.held).toBe(0);
  });

  it("is idempotent on the issuer authorization id under the lock", async () => {
    const holder = await fundedHolder();
    const card = await service.createCard({ accountHolderId: holder.id, singleUse: false });
    const req = {
      authorizationId: "auth_dup",
      cardId: card.id,
      amount: 10_000,
      currency: "ZAR" as const,
      merchant: { name: "M", category: "5999" },
    };
    const a = await service.authorize(req);
    const b = await service.authorize(req);
    expect(b.transaction.id).toBe(a.transaction.id);
    expect((await service.walletBalance(holder.id)).held).toBe(10_000); // only one hold
  });

  it("CONCURRENT authorizations on one wallet cannot overspend", async () => {
    const holder = await fundedHolder(10_000); // room for exactly three R30 holds
    const card = await service.createCard({ accountHolderId: holder.id, singleUse: false });

    // Fire five R3000 authorizations at the same wallet simultaneously.
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        service.authorize({
          authorizationId: `race_${i}`,
          cardId: card.id,
          amount: 3_000,
          currency: "ZAR",
          merchant: { name: "M", category: "5999" },
        }),
      ),
    );

    const approved = results.filter((r) => r.approved).length;
    const declined = results.filter((r) => !r.approved && r.declineReason === "insufficient_funds").length;
    expect(approved).toBe(3); // 3 * 3000 = 9000 <= 10000; the 4th would need 12000
    expect(declined).toBe(2);

    const bal = await service.walletBalance(holder.id);
    expect(bal.held).toBe(9_000);
    expect(bal.available).toBe(1_000);
    expect(bal.available).toBeGreaterThanOrEqual(0); // the invariant that matters
  });

  it("routes above-threshold to review, honors a one-time grant, then re-reviews", async () => {
    const holder = await fundedHolder();
    const card = await service.createCard({ accountHolderId: holder.id, singleUse: false, approvalThreshold: 20_000 });

    const first = await service.authorize({
      authorizationId: "hitl_1",
      cardId: card.id,
      amount: 50_000,
      currency: "ZAR",
      merchant: { name: "FlySafair", category: "4511" },
    });
    expect(first.approved).toBe(false);
    expect(first.declineReason).toBe("pending_human_approval");
    expect(first.approvalId).toBeDefined();
    expect((await service.walletBalance(holder.id)).held).toBe(0);

    await service.decideApproval(first.approvalId!, "approved", "founder@x.co.za");

    const retry = await service.authorize({
      authorizationId: "hitl_2",
      cardId: card.id,
      amount: 50_000,
      currency: "ZAR",
      merchant: { name: "FlySafair", category: "4511" },
    });
    expect(retry.approved).toBe(true);

    const third = await service.authorize({
      authorizationId: "hitl_3",
      cardId: card.id,
      amount: 50_000,
      currency: "ZAR",
      merchant: { name: "FlySafair", category: "4511" },
    });
    expect(third.declineReason).toBe("pending_human_approval"); // grant consumed
  });

  it("releases held funds on reversal and auto-closes single-use cards on capture", async () => {
    const holder = await fundedHolder(100_000);
    const reversible = await service.createCard({ accountHolderId: holder.id, singleUse: false });
    await service.authorize({
      authorizationId: "rev_1",
      cardId: reversible.id,
      amount: 30_000,
      currency: "ZAR",
      merchant: { name: "M", category: "5999" },
    });
    expect((await service.walletBalance(holder.id)).available).toBe(70_000);
    await service.reverse("rev_1");
    expect((await service.walletBalance(holder.id)).available).toBe(100_000);

    const single = await service.createCard({ accountHolderId: holder.id, singleUse: true });
    await service.authorize({
      authorizationId: "su_1",
      cardId: single.id,
      amount: 5_000,
      currency: "ZAR",
      merchant: { name: "M", category: "5999" },
    });
    await service.capture("su_1");
    expect((await service.getCard(single.id))!.status).toBe("closed");
  });

  it("registers an owner, logs in, resolves a session, and manages members (RBAC data)", async () => {
    const reg = await service.registerAccount({ email: "owner@pg.co.za", name: "Owner", password: "supersecret" });
    expect(reg.context.role).toBe("owner");
    expect(reg.sessionToken).toMatch(/^sess_/);

    const resolved = await service.resolveSession(reg.sessionToken);
    expect(resolved?.role).toBe("owner");
    expect(resolved?.accountHolderId).toBe(reg.accountHolder.id);

    const login = await service.login({ email: "owner@pg.co.za", password: "supersecret" });
    expect(login.context.role).toBe("owner");
    await expect(service.login({ email: "owner@pg.co.za", password: "nope" })).rejects.toThrow(/invalid/);

    await service.addMember({ accountHolderId: reg.accountHolder.id, email: "viewer@pg.co.za", name: "V", password: "viewerpass", role: "viewer" });
    const members = await service.listMembers(reg.accountHolder.id);
    expect(members.map((m) => m.role).sort()).toEqual(["owner", "viewer"]);

    const viewerLogin = await service.login({ email: "viewer@pg.co.za", password: "viewerpass" });
    expect(viewerLogin.context.role).toBe("viewer");

    await service.logout(reg.sessionToken);
    expect(await service.resolveSession(reg.sessionToken)).toBeUndefined();
  });

  it("enforces the free plan monthly card cap and idempotency records", async () => {
    const holder = await fundedHolder();
    for (let i = 0; i < 5; i++) await service.createCard({ accountHolderId: holder.id });
    await expect(service.createCard({ accountHolderId: holder.id })).rejects.toThrow(/plan allows 5/);

    await service.idempotencyPut("k1", "hashA", 201, { ok: true });
    expect(await service.idempotencyGet("k1", "hashA")).toEqual({ hit: true, status: 201, body: { ok: true } });
    expect(await service.idempotencyGet("k1", "hashB")).toEqual({ hit: false, conflict: true });
    expect(await service.markEvent("evt_x")).toBe(true);
    expect(await service.markEvent("evt_x")).toBe(false);
  });
});
