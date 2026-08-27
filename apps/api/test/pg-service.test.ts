import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { generateSync } from "otplib";
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
  "acard_org_policies",
  "acard_departments",
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
  "acard_mfa_challenges",
  "acard_login_attempts",
  "acard_sessions",
  "acard_memberships",
  "acard_users",
  "acard_linked_wallets",
  "acard_wallets",
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

  it("holds independent ZAR and USD wallets against the row-level ledger", async () => {
    const holder = await service.signup({ email: `mc${Date.now()}${Math.random()}@x.co.za`, name: "MC", currency: "ZAR" });
    await service.fundWallet(holder.id, 100_000, "ZAR");
    await service.fundWallet(holder.id, 40_000, "USD");

    expect((await service.walletBalance(holder.id, "ZAR")).available).toBe(100_000);
    expect((await service.walletBalance(holder.id, "USD")).available).toBe(40_000);
    expect((await service.walletBalances(holder.id)).map((w) => w.currency).sort()).toEqual(["USD", "ZAR"]);

    const usdCard = await service.createCard({ accountHolderId: holder.id, currency: "USD", singleUse: false });
    expect(usdCard.currency).toBe("USD");
    const decision = await service.authorize({
      authorizationId: "pg_usd_1",
      cardId: usdCard.id,
      // Kept under the free tier's $50 per-card cap (see billing.ts's applyCardCap).
      amount: 3_000,
      currency: "USD",
      merchant: { name: "OpenAI", category: "5734" },
    });
    expect(decision.approved).toBe(true);

    // USD moved; ZAR untouched.
    expect((await service.walletBalance(holder.id, "USD")).available).toBe(37_000);
    expect((await service.walletBalance(holder.id, "ZAR")).available).toBe(100_000);
  });

  it("registers an owner, logs in, resolves a session, and manages members (RBAC data)", async () => {
    const reg = await service.registerAccount({ email: "owner@pg.co.za", name: "Owner", password: "supersecret" });
    expect(reg.context.role).toBe("owner");
    expect(reg.sessionToken).toMatch(/^sess_/);

    const resolved = await service.resolveSession(reg.sessionToken);
    expect(resolved?.role).toBe("owner");
    expect(resolved?.accountHolderId).toBe(reg.accountHolder.id);

    const login = await service.login({ email: "owner@pg.co.za", password: "supersecret" });
    expect(login.status).toBe("authenticated");
    if (login.status !== "authenticated") throw new Error("expected a session");
    expect(login.context.role).toBe("owner");
    await expect(service.login({ email: "owner@pg.co.za", password: "nope" })).rejects.toThrow(/invalid/);

    await service.addMember({ accountHolderId: reg.accountHolder.id, email: "viewer@pg.co.za", name: "V", password: "viewerpass", role: "viewer" });
    const members = await service.listMembers(reg.accountHolder.id);
    expect(members.map((m) => m.role).sort()).toEqual(["owner", "viewer"]);

    const viewerLogin = await service.login({ email: "viewer@pg.co.za", password: "viewerpass" });
    if (viewerLogin.status !== "authenticated") throw new Error("expected a session");
    expect(viewerLogin.context.role).toBe("viewer");

    await service.logout(reg.sessionToken);
    expect(await service.resolveSession(reg.sessionToken)).toBeUndefined();
  });

  it("locks out an account after repeated failed logins (shared across instances via the row-level table)", async () => {
    await service.registerAccount({ email: "locktarget@pg.co.za", name: "Owner", password: "supersecret" });

    for (let i = 0; i < 5; i++) {
      await expect(service.login({ email: "locktarget@pg.co.za", password: "wrongwrong" })).rejects.toThrow(/invalid/);
    }
    // Even the right password is rejected once locked — and with the lockout's own error code.
    await expect(service.login({ email: "locktarget@pg.co.za", password: "supersecret" })).rejects.toMatchObject({
      code: "account_locked",
    });
  });

  it("issues scoped API keys and enforces a spend cap under the row lock", async () => {
    const holder = await service.signup({ email: `keys${Date.now()}@x.co.za`, name: "Keys", currency: "ZAR" });
    await service.fundWallet(holder.id, 10_000_000);

    const readOnly = await service.issueApiKey(holder.id, "bi tool", { scope: "read_only" });
    expect(readOnly.scope).toBe("read_only");
    const principal = await service.authenticateApiKey(readOnly.secret);
    expect(principal?.key.scope).toBe("read_only");
    expect(principal?.holder.id).toBe(holder.id);

    const capped = await service.issueApiKey(holder.id, "capped", { spendCapCents: 100_000 });
    await service.createCard({ accountHolderId: holder.id, limits: { total: 60_000 }, apiKeyId: capped.id });
    await expect(
      service.createCard({ accountHolderId: holder.id, limits: { total: 50_000 }, apiKeyId: capped.id }),
    ).rejects.toMatchObject({ code: "api_key_spend_cap_exceeded" });

    // A capped key may not sidestep the cap by omitting the card's total budget.
    await expect(
      service.createCard({ accountHolderId: holder.id, apiKeyId: capped.id }),
    ).rejects.toMatchObject({ code: "card_budget_required" });

    // The refused attempts left the running total untouched.
    const keys = await service.listApiKeys(holder.id);
    expect(keys.find((k) => k.id === capped.id)?.provisionedCents).toBe(60_000);

    await service.revokeApiKey(holder.id, capped.id);
    expect(await service.authenticateApiKey(capped.secret)).toBeUndefined();
  });

  it("demands a TOTP code at login once MFA is enabled, and burns recovery codes", async () => {
    const reg = await service.registerAccount({ email: "mfa@pg.co.za", name: "MFA", password: "supersecret" });
    const { secret } = await service.beginMfaEnrolment(reg.user.id);
    const { recoveryCodes } = await service.confirmMfaEnrolment(reg.user.id, generateSync({ strategy: "totp", secret }));

    const challenged = await service.login({ email: "mfa@pg.co.za", password: "supersecret" });
    expect(challenged.status).toBe("mfa_required");
    if (challenged.status !== "mfa_required") throw new Error("expected a challenge");

    const session = await service.verifyMfaChallenge(challenged.challengeToken, generateSync({ strategy: "totp", secret }));
    expect(session.context.role).toBe("owner");
    expect(await service.resolveSession(session.sessionToken)).toBeDefined();

    // A recovery code works once, then is spent.
    const [code] = recoveryCodes as [string];
    const again = await service.login({ email: "mfa@pg.co.za", password: "supersecret" });
    if (again.status !== "mfa_required") throw new Error("expected a challenge");
    expect(await service.verifyMfaChallenge(again.challengeToken, code)).toBeDefined();

    const third = await service.login({ email: "mfa@pg.co.za", password: "supersecret" });
    if (third.status !== "mfa_required") throw new Error("expected a challenge");
    await expect(service.verifyMfaChallenge(third.challengeToken, code)).rejects.toMatchObject({ code: "invalid_mfa_code" });
  });

  it("links a WorkOS org, routes login by domain, and refuses a duplicate domain", async () => {
    const holder = await service.signup({ email: `ssoA${Date.now()}@acme.co.za`, name: "Acme", currency: "ZAR" });
    const linked = await service.setSsoOrganization(holder.id, { workosOrganizationId: "org_pg_1", ssoDomain: "Acme-PG.co.za" });
    expect(linked.ssoDomain).toBe("acme-pg.co.za"); // lowercased

    expect((await service.getAccountHolderBySsoDomain("ACME-PG.CO.ZA"))?.id).toBe(holder.id);
    expect((await service.getAccountHolderByWorkosOrganizationId("org_pg_1"))?.id).toBe(holder.id);

    const other = await service.signup({ email: `ssoB${Date.now()}@other.co.za`, name: "Other", currency: "ZAR" });
    await expect(
      service.setSsoOrganization(other.id, { workosOrganizationId: "org_pg_2", ssoDomain: "acme-pg.co.za" }),
    ).rejects.toMatchObject({ code: "invalid_state" });
  });

  it("completes an SSO login under the row lock, creating a member without touching a promoted role on retry", async () => {
    const holder = await service.signup({ email: `ssoC${Date.now()}@acme2.co.za`, name: "Acme2", currency: "ZAR" });
    await service.setSsoOrganization(holder.id, { workosOrganizationId: "org_pg_3", ssoDomain: "acme2.co.za" });

    const first = await service.completeSsoLogin({ accountHolderId: holder.id, email: "person@acme2.co.za", name: "Person" });
    expect(first.sessionToken).toMatch(/^sess_/);
    expect(first.context.role).toBe("member");

    await service.addMember({ accountHolderId: holder.id, email: "person@acme2.co.za", role: "admin" });
    const second = await service.completeSsoLogin({ accountHolderId: holder.id, email: "person@acme2.co.za", name: "Person" });
    expect(second.context.user.id).toBe(first.context.user.id);
    expect(second.context.role).toBe("admin"); // the second SSO login did not reset the promotion
  });

  it("stores the card PAN encrypted at rest, and still round-trips the plaintext through getCard", async () => {
    const holder = await service.signup({ email: `enc${Date.now()}@x.co.za`, name: "Enc", currency: "ZAR" });
    const card = await service.createCard({ accountHolderId: holder.id });
    expect(card.sandboxPan.startsWith("4242")).toBe(true); // the caller gets plaintext back

    const row = await (service as unknown as { pool: { query: (sql: string, params: unknown[]) => Promise<{ rows: any[] }> } }).pool.query(
      "SELECT sandbox_pan FROM acard_cards WHERE id = $1",
      [card.id],
    );
    const stored: string = row.rows[0].sandbox_pan;
    expect(stored).not.toBe(card.sandboxPan); // not plaintext in the column
    expect(stored).not.toContain("4242"); // no fragment of the PAN leaks into the ciphertext
    // iv (12B) + authTag (16B) + ciphertext, base64-encoded — always longer than the raw PAN.
    expect(Buffer.from(stored, "base64").length).toBeGreaterThan(28);

    const fetched = await service.getCard(card.id);
    expect(fetched?.sandboxPan).toBe(card.sandboxPan); // decrypts back to the original on read
  });

  it("links a card to an issuer reference and resolves it via getCardByIssuerCardId, under the unique index", async () => {
    const holder = await service.signup({ email: `issuer${Date.now()}@x.co.za`, name: "Issuer", currency: "ZAR" });
    const card = await service.createCard({ accountHolderId: holder.id, issuerCardId: "sudo_card_pg_1" });
    expect(card.issuerCardId).toBe("sudo_card_pg_1");
    expect((await service.getCardByIssuerCardId("sudo_card_pg_1"))?.id).toBe(card.id);

    // The real Postgres unique-violation error must actually be caught and
    // remapped — not just assumed to have the guessed constraint name.
    await expect(
      service.createCard({ accountHolderId: holder.id, issuerCardId: "sudo_card_pg_1" }),
    ).rejects.toMatchObject({ code: "invalid_state" });
  });

  it("links a card to an issuer reference after the fact, and refuses a reference already claimed elsewhere", async () => {
    const holder = await service.signup({ email: `issuer2${Date.now()}@x.co.za`, name: "Issuer2", currency: "ZAR" });
    const a = await service.createCard({ accountHolderId: holder.id, issuerCardId: "sudo_card_pg_taken" });
    const b = await service.createCard({ accountHolderId: holder.id });
    expect(b.issuerCardId).toBeUndefined();

    await expect(service.linkIssuerCard(b.id, "sudo_card_pg_taken")).rejects.toMatchObject({ code: "invalid_state" });
    expect((await service.getCardByIssuerCardId("sudo_card_pg_taken"))?.id).toBe(a.id);

    const linked = await service.linkIssuerCard(b.id, "sudo_card_pg_free");
    expect(linked.issuerCardId).toBe("sudo_card_pg_free");
  });

  it("authorizes under the row lock by the issuer's own card reference, recording our card id on the transaction", async () => {
    const holder = await service.signup({ email: `issuer3${Date.now()}@x.co.za`, name: "Issuer3", currency: "ZAR" });
    await service.fundWallet(holder.id, 100_000);
    const card = await service.createCard({ accountHolderId: holder.id, issuerCardId: "sudo_card_pg_auth" });

    const decision = await service.authorize({
      authorizationId: "auth_pg_via_issuer_ref",
      cardId: "sudo_card_pg_auth", // the issuer's webhook would send their own reference, not our id
      amount: 10_000,
      currency: "ZAR",
      merchant: { name: "Checkers", category: "5411" },
    });
    expect(decision.approved).toBe(true);
    expect(decision.transaction.cardId).toBe(card.id);

    const txs = await service.listTransactions({ cardId: card.id });
    expect(txs).toHaveLength(1);
  });

  it("enforces org policy and department budgets in the Postgres hot path", async () => {
    const holder = await service.signup({ email: `ent${Date.now()}${Math.random()}@x.co.za`, name: "Aurora", currency: "ZAR", accountType: "enterprise" });
    expect(holder.accountType).toBe("enterprise");
    await service.fundWallet(holder.id, 10_000_000);

    // block a category org-wide
    await service.setPolicy(holder.id, { blockedMerchantCategories: ["7995"], approvalThreshold: undefined });
    const eng = await service.createDepartment({ accountHolderId: holder.id, name: "Engineering", monthlyBudget: 5_000, lead: "Naledi" });
    const card = await service.createCard({ accountHolderId: holder.id, singleUse: false, departmentId: eng.id });
    expect(card.departmentId).toBe(eng.id);

    // blocked MCC declines regardless of card rules
    const blocked = await service.authorize({ authorizationId: "e_block", cardId: card.id, amount: 1_000, currency: "ZAR", merchant: { name: "Casino", category: "7995" } });
    expect(blocked.declineReason).toBe("merchant_category_blocked_by_policy");

    // department budget: 3000 ok, next 3000 exceeds the 5000 cap
    expect((await service.authorize({ authorizationId: "e_ok", cardId: card.id, amount: 3_000, currency: "ZAR", merchant: { name: "AWS", category: "5734" } })).approved).toBe(true);
    const over = await service.authorize({ authorizationId: "e_over", cardId: card.id, amount: 3_000, currency: "ZAR", merchant: { name: "AWS", category: "5734" } });
    expect(over.declineReason).toBe("department_budget_exceeded");

    // department spend reporting
    const spend = await service.listDepartmentSpend(holder.id);
    expect(spend[0]!.department.name).toBe("Engineering");
    expect(spend[0]!.spentThisMonth).toBe(3_000);
    expect(spend[0]!.cardCount).toBe(1);

    // org approval threshold routes to review even with no card threshold
    await service.setPolicy(holder.id, { blockedMerchantCategories: [], approvalThreshold: 2_000 });
    const holder2 = await service.signup({ email: `ent2${Date.now()}${Math.random()}@x.co.za`, name: "Beta", accountType: "enterprise" });
    await service.fundWallet(holder2.id, 1_000_000);
    await service.setPolicy(holder2.id, { blockedMerchantCategories: [], approvalThreshold: 2_000 });
    const card2 = await service.createCard({ accountHolderId: holder2.id, singleUse: false });
    const review = await service.authorize({ authorizationId: "e_review", cardId: card2.id, amount: 5_000, currency: "ZAR", merchant: { name: "M", category: "5999" } });
    expect(review.declineReason).toBe("pending_human_approval");
    expect(review.approvalId).toBeDefined();
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
