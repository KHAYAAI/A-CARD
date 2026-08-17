import { createHash } from "node:crypto";
import pg from "pg";
import {
  createCard,
  currentBillingPeriod,
  DomainError,
  evaluateRules,
  hashApiKeySecret,
  hashPassword,
  hashSessionToken,
  InvalidStateError,
  LOGIN_LOCKOUT_THRESHOLD,
  LOGIN_LOCKOUT_WINDOW_MS,
  newId,
  NotFoundError,
  SUBSCRIPTION_TIERS,
  verifyPassword,
  type AccountHolder,
  type ApprovalRequest,
  type ApprovalStatus,
  type AuthorizationDecision,
  type AuthorizationRequest,
  type Card,
  type CardTransaction,
  type Chain,
  type Currency,
  type Department,
  type DepartmentSpend,
  type ExternalWalletConnector,
  type LedgerTransaction,
  type LinkedWallet,
  type OrgPolicy,
  type PlatformEvent,
  type Role,
  type SessionContext,
  type SubscriptionTier,
  type WorkspaceType,
} from "@acard/core";
import { randomBytes } from "node:crypto";
import type {
  CreateCardParams,
  IdempotencyLookup,
  MemberView,
  PlatformService,
  RegisterResult,
  WalletBalance,
} from "./types.js";

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7;

/**
 * Multi-writer, row-level Postgres persistence for the platform.
 *
 * The single-writer snapshot model (`persistence.ts`) is honest but caps a
 * deployment at one API instance. This is the real thing: the ledger lives in
 * `accounts` / `ledger_transactions` / `postings` tables, balances are SQL
 * aggregates, and the overspend guard is enforced by taking a
 * `SELECT ... FOR UPDATE` lock on the wallet's account row for the whole
 * authorization decision. Concurrent authorizations on the *same* wallet
 * serialize on that row; authorizations on *different* wallets run fully in
 * parallel. That is what lets several API tasks share one database without two
 * of them both passing the balance check and double-spending a hold.
 */

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS acard_account_holders (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    currency TEXT NOT NULL,
    wallet_account_id TEXT NOT NULL,
    subscription_tier TEXT NOT NULL DEFAULT 'free',
    account_type TEXT NOT NULL DEFAULT 'personal',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS acard_departments (
    id TEXT PRIMARY KEY,
    account_holder_id TEXT NOT NULL,
    name TEXT NOT NULL,
    monthly_budget BIGINT NOT NULL,
    lead TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS acard_departments_holder_idx ON acard_departments(account_holder_id);

  CREATE TABLE IF NOT EXISTS acard_org_policies (
    account_holder_id TEXT PRIMARY KEY,
    blocked_mccs JSONB NOT NULL DEFAULT '[]',
    approval_threshold BIGINT
  );

  CREATE TABLE IF NOT EXISTS acard_accounts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    currency TEXT NOT NULL,
    owner_id TEXT
  );

  CREATE TABLE IF NOT EXISTS acard_wallets (
    account_holder_id TEXT NOT NULL,
    currency TEXT NOT NULL,
    account_id TEXT NOT NULL,
    PRIMARY KEY (account_holder_id, currency)
  );

  CREATE TABLE IF NOT EXISTS acard_settlement_accounts (
    currency TEXT PRIMARY KEY,
    account_id TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS acard_ledger_transactions (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    currency TEXT NOT NULL,
    description TEXT NOT NULL,
    reference TEXT,
    metadata JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    settled_at TIMESTAMPTZ
  );

  CREATE TABLE IF NOT EXISTS acard_postings (
    id BIGSERIAL PRIMARY KEY,
    tx_id TEXT NOT NULL REFERENCES acard_ledger_transactions(id),
    account_id TEXT NOT NULL,
    direction TEXT NOT NULL,
    amount BIGINT NOT NULL,
    position INT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS acard_postings_account_idx ON acard_postings(account_id);
  CREATE INDEX IF NOT EXISTS acard_postings_tx_idx ON acard_postings(tx_id);

  CREATE TABLE IF NOT EXISTS acard_cards (
    id TEXT PRIMARY KEY,
    account_holder_id TEXT NOT NULL,
    wallet_account_id TEXT NOT NULL,
    department_id TEXT,
    currency TEXT NOT NULL,
    status TEXT NOT NULL,
    single_use BOOLEAN NOT NULL,
    limits JSONB NOT NULL DEFAULT '{}',
    allowed_mccs JSONB NOT NULL DEFAULT '[]',
    approval_threshold BIGINT,
    sandbox_pan TEXT NOT NULL,
    last4 TEXT NOT NULL,
    expiry_month INT NOT NULL,
    expiry_year INT NOT NULL,
    label TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    closed_at TIMESTAMPTZ,
    close_reason TEXT
  );
  CREATE INDEX IF NOT EXISTS acard_cards_holder_idx ON acard_cards(account_holder_id);

  CREATE TABLE IF NOT EXISTS acard_card_transactions (
    id TEXT PRIMARY KEY,
    card_id TEXT NOT NULL,
    account_holder_id TEXT NOT NULL,
    type TEXT NOT NULL,
    status TEXT NOT NULL,
    amount BIGINT NOT NULL,
    currency TEXT NOT NULL,
    merchant_name TEXT NOT NULL,
    merchant_category TEXT NOT NULL,
    decline_reason TEXT,
    approval_id TEXT,
    ledger_transaction_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS acard_card_tx_card_idx ON acard_card_transactions(card_id);
  CREATE INDEX IF NOT EXISTS acard_card_tx_holder_idx ON acard_card_transactions(account_holder_id);

  CREATE TABLE IF NOT EXISTS acard_open_holds (
    authorization_id TEXT PRIMARY KEY,
    ledger_transaction_id TEXT NOT NULL,
    card_transaction_id TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS acard_approvals (
    id TEXT PRIMARY KEY,
    card_id TEXT NOT NULL,
    account_holder_id TEXT NOT NULL,
    amount BIGINT NOT NULL,
    currency TEXT NOT NULL,
    merchant_name TEXT NOT NULL,
    merchant_category TEXT NOT NULL,
    reason TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    decided_at TIMESTAMPTZ,
    decided_by TEXT
  );
  CREATE INDEX IF NOT EXISTS acard_approvals_holder_idx ON acard_approvals(account_holder_id);

  CREATE TABLE IF NOT EXISTS acard_api_keys (
    id TEXT PRIMARY KEY,
    account_holder_id TEXT NOT NULL,
    name TEXT NOT NULL,
    hashed_secret TEXT UNIQUE NOT NULL,
    prefix TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at TIMESTAMPTZ
  );

  CREATE TABLE IF NOT EXISTS acard_idempotency (
    key TEXT PRIMARY KEY,
    request_hash TEXT NOT NULL,
    status INT NOT NULL,
    body JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS acard_events_seen (
    event_id TEXT PRIMARY KEY,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS acard_events (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    data JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS acard_users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS acard_memberships (
    user_id TEXT NOT NULL,
    account_holder_id TEXT NOT NULL,
    role TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, account_holder_id)
  );
  CREATE INDEX IF NOT EXISTS acard_memberships_org_idx ON acard_memberships(account_holder_id);

  CREATE TABLE IF NOT EXISTS acard_linked_wallets (
    id TEXT PRIMARY KEY,
    account_holder_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    chain TEXT NOT NULL,
    address TEXT NOT NULL,
    connector TEXT,
    label TEXT,
    is_default BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS acard_linked_wallets_holder_idx ON acard_linked_wallets(account_holder_id);
  CREATE UNIQUE INDEX IF NOT EXISTS acard_linked_wallets_embedded_idx
    ON acard_linked_wallets(account_holder_id, chain) WHERE kind = 'embedded';

  CREATE TABLE IF NOT EXISTS acard_sessions (
    hashed_token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    account_holder_id TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL
  );

  -- Per-account login lockout, shared across API instances (the WAF rate limit
  -- on /v1/auth/login is IP-keyed and can't catch an attacker rotating IPs
  -- against one email; this can, because every instance reads the same table).
  CREATE TABLE IF NOT EXISTS acard_login_attempts (
    id BIGSERIAL PRIMARY KEY,
    email TEXT NOT NULL,
    attempted_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS acard_login_attempts_email_idx ON acard_login_attempts(email, attempted_at);
`;

type Client = pg.PoolClient;

export class PostgresPlatformService implements PlatformService {
  private readonly pool: pg.Pool;
  private readonly listeners: Array<(event: PlatformEvent) => void> = [];

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, max: 10 });
  }

  async migrate(): Promise<void> {
    await this.pool.query(SCHEMA);
    // Additive columns for deployments created before enterprise support.
    await this.pool.query(
      `ALTER TABLE acard_account_holders ADD COLUMN IF NOT EXISTS account_type TEXT NOT NULL DEFAULT 'personal';
       ALTER TABLE acard_cards ADD COLUMN IF NOT EXISTS department_id TEXT;`,
    );
    // Backfill: every existing holder's primary wallet becomes its ZAR/USD/…
    // wallet row, so multi-currency lookups work for accounts created before
    // acard_wallets existed.
    await this.pool.query(
      `INSERT INTO acard_wallets (account_holder_id, currency, account_id)
       SELECT id, currency, wallet_account_id FROM acard_account_holders
       ON CONFLICT (account_holder_id, currency) DO NOTHING`,
    );
  }

  // ---- transaction helper ---------------------------------------------------

  /**
   * Run `fn` in a single DB transaction. Domain events it stages are emitted to
   * in-process listeners (Slack, etc.) only *after* a successful COMMIT, so a
   * rolled-back authorization never fires a notification.
   */
  private async tx<T>(fn: (client: Client, stage: (event: Omit<PlatformEvent, "id" | "createdAt">) => void) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    const staged: PlatformEvent[] = [];
    const stage = (event: Omit<PlatformEvent, "id" | "createdAt">) => {
      staged.push({ id: newId("evt"), createdAt: new Date().toISOString(), ...event });
    };
    try {
      await client.query("BEGIN");
      const result = await fn(client, stage);
      for (const event of staged) {
        await client.query("INSERT INTO acard_events (id, type, data) VALUES ($1, $2, $3)", [
          event.id,
          event.type,
          JSON.stringify(event.data),
        ]);
      }
      await client.query("COMMIT");
      for (const event of staged) for (const listener of this.listeners) listener(event);
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  // ---- account holders & auth ----------------------------------------------

  async signup(input: { email: string; name: string; currency?: Currency; accountType?: WorkspaceType }): Promise<AccountHolder> {
    const currency = input.currency ?? "ZAR";
    const accountType = input.accountType ?? "personal";
    return this.tx(async (client, stage) => {
      const existing = await client.query("SELECT 1 FROM acard_account_holders WHERE email = $1", [input.email]);
      if (existing.rowCount) throw new InvalidStateError(`an account for ${input.email} already exists`);

      const walletAccountId = newId("acct");
      await client.query(
        "INSERT INTO acard_accounts (id, name, type, currency) VALUES ($1, $2, 'liability', $3)",
        [walletAccountId, `wallet:${input.email}:${currency}`, currency],
      );
      const holder: AccountHolder = {
        id: newId("ah"),
        email: input.email,
        name: input.name,
        currency,
        walletAccountId,
        subscriptionTier: "free",
        accountType,
        createdAt: new Date().toISOString(),
      };
      await client.query(
        `INSERT INTO acard_account_holders (id, email, name, currency, wallet_account_id, subscription_tier, account_type, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [holder.id, holder.email, holder.name, holder.currency, holder.walletAccountId, holder.subscriptionTier, holder.accountType, holder.createdAt],
      );
      await client.query(
        "INSERT INTO acard_wallets (account_holder_id, currency, account_id) VALUES ($1, $2, $3)",
        [holder.id, currency, walletAccountId],
      );
      stage({ type: "account_holder.created", data: { accountHolderId: holder.id } });
      return holder;
    });
  }

  private mapHolder(row: any): AccountHolder {
    return {
      id: row.id,
      email: row.email,
      name: row.name,
      currency: row.currency,
      walletAccountId: row.wallet_account_id,
      subscriptionTier: row.subscription_tier,
      accountType: row.account_type ?? "personal",
      createdAt: new Date(row.created_at).toISOString(),
    };
  }

  private async holderById(client: Client, id: string): Promise<AccountHolder> {
    const res = await client.query("SELECT * FROM acard_account_holders WHERE id = $1", [id]);
    if (!res.rowCount) throw new NotFoundError("account holder", id);
    return this.mapHolder(res.rows[0]);
  }

  async getAccountHolder(id: string): Promise<AccountHolder | undefined> {
    const res = await this.pool.query("SELECT * FROM acard_account_holders WHERE id = $1", [id]);
    return res.rowCount ? this.mapHolder(res.rows[0]) : undefined;
  }

  async issueApiKey(accountHolderId: string, name: string): Promise<{ secret: string; id: string }> {
    const secret = `ak_live_${randomBytes(24).toString("base64url")}`;
    const id = newId("key");
    await this.pool.query(
      `INSERT INTO acard_api_keys (id, account_holder_id, name, hashed_secret, prefix)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, accountHolderId, name, hashApiKeySecret(secret), secret.slice(0, 12)],
    );
    return { secret, id };
  }

  async authenticateApiKey(secret: string): Promise<AccountHolder | undefined> {
    const res = await this.pool.query(
      `SELECT h.* FROM acard_api_keys k
       JOIN acard_account_holders h ON h.id = k.account_holder_id
       WHERE k.hashed_secret = $1 AND k.revoked_at IS NULL`,
      [hashApiKeySecret(secret)],
    );
    if (!res.rowCount) return undefined;
    return this.mapHolder(res.rows[0]);
  }

  async setSubscriptionTier(accountHolderId: string, tier: SubscriptionTier): Promise<AccountHolder> {
    return this.tx(async (client, stage) => {
      const res = await client.query(
        "UPDATE acard_account_holders SET subscription_tier = $2 WHERE id = $1 RETURNING *",
        [accountHolderId, tier],
      );
      if (!res.rowCount) throw new NotFoundError("account holder", accountHolderId);
      stage({ type: "subscription.updated", data: { accountHolderId, tier } });
      return this.mapHolder(res.rows[0]);
    });
  }

  // ---- ledger balance helpers ----------------------------------------------

  /** Wallet ledger account for a (holder, currency), created on first use. */
  private async ensureWallet(client: Client, holder: AccountHolder, currency: Currency): Promise<string> {
    const existing = await client.query(
      "SELECT account_id FROM acard_wallets WHERE account_holder_id = $1 AND currency = $2",
      [holder.id, currency],
    );
    if (existing.rowCount) return existing.rows[0].account_id;
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`wallet:${holder.id}:${currency}`]);
    const again = await client.query(
      "SELECT account_id FROM acard_wallets WHERE account_holder_id = $1 AND currency = $2",
      [holder.id, currency],
    );
    if (again.rowCount) return again.rows[0].account_id;
    const accountId = newId("acct");
    await client.query("INSERT INTO acard_accounts (id, name, type, currency) VALUES ($1, $2, 'liability', $3)", [
      accountId,
      `wallet:${holder.email}:${currency}`,
      currency,
    ]);
    await client.query(
      "INSERT INTO acard_wallets (account_holder_id, currency, account_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
      [holder.id, currency, accountId],
    );
    return accountId;
  }

  private async balances(client: Client, walletAccountId: string): Promise<{ available: number; posted: number; held: number }> {
    const res = await client.query(
      `SELECT
         COALESCE(SUM(CASE WHEN t.status = 'posted'
             THEN (CASE WHEN p.direction = 'credit' THEN p.amount ELSE -p.amount END) ELSE 0 END), 0) AS posted,
         COALESCE(SUM(CASE WHEN t.status = 'held' AND p.direction = 'debit'
             THEN p.amount ELSE 0 END), 0) AS held
       FROM acard_postings p
       JOIN acard_ledger_transactions t ON t.id = p.tx_id
       WHERE p.account_id = $1`,
      [walletAccountId],
    );
    const posted = Number(res.rows[0].posted);
    const held = Number(res.rows[0].held);
    return { posted, held, available: posted - held };
  }

  async walletBalance(accountHolderId: string, currency?: Currency): Promise<WalletBalance> {
    const client = await this.pool.connect();
    try {
      const holder = await this.holderById(client, accountHolderId);
      const ccy = currency ?? holder.currency;
      const walletRes = await client.query(
        "SELECT account_id FROM acard_wallets WHERE account_holder_id = $1 AND currency = $2",
        [accountHolderId, ccy],
      );
      if (!walletRes.rowCount) return { available: 0, posted: 0, held: 0, currency: ccy };
      const b = await this.balances(client, walletRes.rows[0].account_id);
      return { ...b, currency: ccy };
    } finally {
      client.release();
    }
  }

  async walletBalances(accountHolderId: string): Promise<WalletBalance[]> {
    const client = await this.pool.connect();
    try {
      const holder = await this.holderById(client, accountHolderId);
      const wallets = await client.query(
        "SELECT currency, account_id FROM acard_wallets WHERE account_holder_id = $1",
        [accountHolderId],
      );
      const out: WalletBalance[] = [];
      for (const row of wallets.rows) {
        const b = await this.balances(client, row.account_id);
        out.push({ ...b, currency: row.currency });
      }
      if (out.length === 0) out.push({ available: 0, posted: 0, held: 0, currency: holder.currency });
      return out.sort((a, b) =>
        a.currency === holder.currency ? -1 : b.currency === holder.currency ? 1 : a.currency.localeCompare(b.currency),
      );
    } finally {
      client.release();
    }
  }

  private async ensureSettlementAccount(client: Client, currency: Currency): Promise<string> {
    const existing = await client.query("SELECT account_id FROM acard_settlement_accounts WHERE currency = $1", [currency]);
    if (existing.rowCount) return existing.rows[0].account_id;
    // Serialize concurrent first-touch creation for this currency.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`settlement:${currency}`]);
    const again = await client.query("SELECT account_id FROM acard_settlement_accounts WHERE currency = $1", [currency]);
    if (again.rowCount) return again.rows[0].account_id;
    const accountId = newId("acct");
    await client.query("INSERT INTO acard_accounts (id, name, type, currency) VALUES ($1, $2, 'asset', $3)", [
      accountId,
      `platform-settlement-${currency}`,
      currency,
    ]);
    await client.query("INSERT INTO acard_settlement_accounts (currency, account_id) VALUES ($1, $2)", [currency, accountId]);
    return accountId;
  }

  async fundWallet(accountHolderId: string, amount: number, currency?: Currency, reference?: string) {
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      throw new DomainError("invalid_amount", "funding amount must be a positive integer of minor units");
    }
    return this.tx(async (client, stage) => {
      const holder = await this.holderById(client, accountHolderId);
      const ccy = currency ?? holder.currency;
      const walletAccountId = await this.ensureWallet(client, holder, ccy);
      const settlement = await this.ensureSettlementAccount(client, ccy);
      const ledgerTransaction = await this.recordLedgerTx(client, {
        status: "posted",
        currency: ccy,
        description: `wallet top-up for ${holder.email} (${ccy})`,
        reference,
        metadata: { accountHolderId },
        postings: [
          { accountId: settlement, direction: "debit", amount },
          { accountId: walletAccountId, direction: "credit", amount },
        ],
      });
      const b = await this.balances(client, walletAccountId);
      stage({ type: "wallet.funded", data: { accountHolderId, amount, currency: ccy } });
      return { ledgerTransaction, wallet: { ...b, currency: ccy } };
    });
  }

  private async recordLedgerTx(
    client: Client,
    input: {
      status: "posted" | "held" | "released";
      currency: Currency;
      description: string;
      reference?: string;
      metadata?: Record<string, string>;
      postings: Array<{ accountId: string; direction: "debit" | "credit"; amount: number }>;
    },
  ): Promise<LedgerTransaction> {
    let debits = 0;
    let credits = 0;
    for (const p of input.postings) {
      if (!Number.isSafeInteger(p.amount) || p.amount <= 0) {
        throw new DomainError("invalid_posting", `posting amount must be a positive integer, got ${p.amount}`);
      }
      if (p.direction === "debit") debits += p.amount;
      else credits += p.amount;
    }
    if (input.postings.length < 2) throw new DomainError("unbalanced_transaction", "a transaction needs at least two postings");
    if (debits !== credits) throw new DomainError("unbalanced_transaction", `debits (${debits}) must equal credits (${credits})`);

    const id = newId("ltx");
    const createdAt = new Date().toISOString();
    const settledAt = input.status === "posted" ? createdAt : undefined;
    await client.query(
      `INSERT INTO acard_ledger_transactions (id, status, currency, description, reference, metadata, created_at, settled_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [id, input.status, input.currency, input.description, input.reference ?? null, JSON.stringify(input.metadata ?? {}), createdAt, settledAt ?? null],
    );
    let position = 0;
    for (const p of input.postings) {
      await client.query(
        "INSERT INTO acard_postings (tx_id, account_id, direction, amount, position) VALUES ($1, $2, $3, $4, $5)",
        [id, p.accountId, p.direction, p.amount, position++],
      );
    }
    return {
      id,
      status: input.status,
      postings: input.postings,
      currency: input.currency,
      description: input.description,
      reference: input.reference,
      metadata: input.metadata ?? {},
      createdAt,
      settledAt,
    };
  }

  // ---- cards ----------------------------------------------------------------

  private mapCard(row: any): Card {
    return {
      id: row.id,
      accountHolderId: row.account_holder_id,
      walletAccountId: row.wallet_account_id,
      departmentId: row.department_id ?? undefined,
      currency: row.currency,
      status: row.status,
      singleUse: row.single_use,
      limits: row.limits ?? {},
      allowedMerchantCategories: row.allowed_mccs ?? [],
      approvalThreshold: row.approval_threshold === null ? undefined : Number(row.approval_threshold),
      sandboxPan: row.sandbox_pan,
      last4: row.last4,
      expiryMonth: row.expiry_month,
      expiryYear: row.expiry_year,
      label: row.label ?? undefined,
      createdAt: new Date(row.created_at).toISOString(),
      closedAt: row.closed_at ? new Date(row.closed_at).toISOString() : undefined,
      closeReason: row.close_reason ?? undefined,
    };
  }

  async createCard(input: CreateCardParams): Promise<Card> {
    return this.tx(async (client, stage) => {
      const holder = await this.holderById(client, input.accountHolderId);
      const currency = input.currency ?? holder.currency;
      const walletAccountId = await this.ensureWallet(client, holder, currency);
      if (input.departmentId) {
        const dept = await client.query("SELECT 1 FROM acard_departments WHERE id = $1 AND account_holder_id = $2", [input.departmentId, holder.id]);
        if (!dept.rowCount) throw new DomainError("invalid_department", "department does not belong to this account");
      }
      const tierLimit = SUBSCRIPTION_TIERS[holder.subscriptionTier].cardsPerMonth;
      const period = currentBillingPeriod();
      const count = await client.query(
        `SELECT COUNT(*)::int AS n FROM acard_cards
         WHERE account_holder_id = $1 AND to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM') = $2`,
        [holder.id, period],
      );
      if (count.rows[0].n >= tierLimit) {
        throw new DomainError(
          "plan_limit_exceeded",
          `${holder.subscriptionTier} plan allows ${tierLimit} cards/month; upgrade to create more`,
          402,
        );
      }
      const card = createCard({ ...input, currency, walletAccountId });
      await client.query(
        `INSERT INTO acard_cards
           (id, account_holder_id, wallet_account_id, department_id, currency, status, single_use, limits, allowed_mccs,
            approval_threshold, sandbox_pan, last4, expiry_month, expiry_year, label, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [
          card.id, card.accountHolderId, card.walletAccountId, card.departmentId ?? null, card.currency, card.status, card.singleUse,
          JSON.stringify(card.limits), JSON.stringify(card.allowedMerchantCategories),
          card.approvalThreshold ?? null, card.sandboxPan, card.last4, card.expiryMonth, card.expiryYear,
          card.label ?? null, card.createdAt,
        ],
      );
      stage({ type: "card.created", data: { cardId: card.id, accountHolderId: holder.id } });
      return card;
    });
  }

  async listCards(accountHolderId: string): Promise<Card[]> {
    const res = await this.pool.query(
      "SELECT * FROM acard_cards WHERE account_holder_id = $1 ORDER BY created_at DESC",
      [accountHolderId],
    );
    return res.rows.map((r) => this.mapCard(r));
  }

  async getCard(id: string): Promise<Card | undefined> {
    const res = await this.pool.query("SELECT * FROM acard_cards WHERE id = $1", [id]);
    return res.rowCount ? this.mapCard(res.rows[0]) : undefined;
  }

  async closeCard(id: string, reason = "closed_by_user"): Promise<Card> {
    return this.tx(async (client, stage) => {
      const res = await client.query("SELECT * FROM acard_cards WHERE id = $1 FOR UPDATE", [id]);
      if (!res.rowCount) throw new NotFoundError("card", id);
      const card = this.mapCard(res.rows[0]);
      if (card.status === "closed") return card;
      const updated = await client.query(
        "UPDATE acard_cards SET status = 'closed', closed_at = now(), close_reason = $2 WHERE id = $1 RETURNING *",
        [id, reason],
      );
      stage({ type: "card.closed", data: { cardId: id, reason } });
      return this.mapCard(updated.rows[0]);
    });
  }

  // ---- transactions ---------------------------------------------------------

  private mapCardTx(row: any): CardTransaction {
    return {
      id: row.id,
      cardId: row.card_id,
      accountHolderId: row.account_holder_id,
      type: row.type,
      status: row.status,
      amount: Number(row.amount),
      currency: row.currency,
      merchantName: row.merchant_name,
      merchantCategory: row.merchant_category,
      declineReason: row.decline_reason ?? undefined,
      approvalId: row.approval_id ?? undefined,
      ledgerTransactionId: row.ledger_transaction_id ?? undefined,
      createdAt: new Date(row.created_at).toISOString(),
    };
  }

  async listTransactions(filter: { accountHolderId?: string; cardId?: string }): Promise<CardTransaction[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.accountHolderId) {
      params.push(filter.accountHolderId);
      clauses.push(`account_holder_id = $${params.length}`);
    }
    if (filter.cardId) {
      params.push(filter.cardId);
      clauses.push(`card_id = $${params.length}`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const res = await this.pool.query(`SELECT * FROM acard_card_transactions ${where} ORDER BY created_at DESC`, params);
    return res.rows.map((r) => this.mapCardTx(r));
  }

  // ---- approvals ------------------------------------------------------------

  private mapApproval(row: any): ApprovalRequest {
    return {
      id: row.id,
      cardId: row.card_id,
      accountHolderId: row.account_holder_id,
      amount: Number(row.amount),
      currency: row.currency,
      merchantName: row.merchant_name,
      merchantCategory: row.merchant_category,
      reason: row.reason,
      status: row.status,
      createdAt: new Date(row.created_at).toISOString(),
      decidedAt: row.decided_at ? new Date(row.decided_at).toISOString() : undefined,
      decidedBy: row.decided_by ?? undefined,
    };
  }

  async listApprovals(filter: { accountHolderId?: string; status?: ApprovalStatus }): Promise<ApprovalRequest[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.accountHolderId) {
      params.push(filter.accountHolderId);
      clauses.push(`account_holder_id = $${params.length}`);
    }
    if (filter.status) {
      params.push(filter.status);
      clauses.push(`status = $${params.length}`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const res = await this.pool.query(`SELECT * FROM acard_approvals ${where} ORDER BY created_at DESC`, params);
    return res.rows.map((r) => this.mapApproval(r));
  }

  async getApproval(id: string): Promise<ApprovalRequest | undefined> {
    const res = await this.pool.query("SELECT * FROM acard_approvals WHERE id = $1", [id]);
    return res.rowCount ? this.mapApproval(res.rows[0]) : undefined;
  }

  async decideApproval(id: string, decision: "approved" | "denied", decidedBy: string): Promise<ApprovalRequest> {
    return this.tx(async (client, stage) => {
      const res = await client.query("SELECT * FROM acard_approvals WHERE id = $1 FOR UPDATE", [id]);
      if (!res.rowCount) throw new NotFoundError("approval", id);
      const approval = this.mapApproval(res.rows[0]);
      if (approval.status !== "pending") throw new InvalidStateError(`approval ${id} already ${approval.status}`);
      const updated = await client.query(
        "UPDATE acard_approvals SET status = $2, decided_at = now(), decided_by = $3 WHERE id = $1 RETURNING *",
        [id, decision, decidedBy],
      );
      stage({ type: `approval.${decision}`, data: { approvalId: id, decidedBy } });
      return this.mapApproval(updated.rows[0]);
    });
  }

  // ---- real-time authorization (the locked hot path) ------------------------

  async authorize(request: AuthorizationRequest): Promise<AuthorizationDecision> {
    return this.tx(async (client, stage) => {
      const txId = `ctx_${request.authorizationId}`;

      // Exactly-once: a repeated authorization id returns the recorded outcome.
      const prior = await client.query("SELECT * FROM acard_card_transactions WHERE id = $1", [txId]);
      if (prior.rowCount) {
        const existing = this.mapCardTx(prior.rows[0]);
        return { approved: existing.status !== "declined", declineReason: existing.declineReason, transaction: existing };
      }

      const cardRes = await client.query("SELECT * FROM acard_cards WHERE id = $1", [request.cardId]);
      if (!cardRes.rowCount) {
        return this.recordDecline(client, stage, request, undefined, "card_not_found");
      }
      const card = this.mapCard(cardRes.rows[0]);

      // The overspend guard: hold the wallet's account row for the whole
      // decision, so concurrent authorizations on this wallet serialize here.
      await client.query("SELECT id FROM acard_accounts WHERE id = $1 FOR UPDATE", [card.walletAccountId]);

      // Org policy, enforced ahead of per-card rules.
      const policy = await this.loadPolicy(client, card.accountHolderId);
      if (policy.blockedMerchantCategories.includes(request.merchant.category)) {
        return this.recordDecline(client, stage, request, card, "merchant_category_blocked_by_policy");
      }

      const spend = await this.cardSpend(client, card.id, card.limits.velocity?.windowSeconds ?? 0);
      const grant = await this.findGrant(client, card.id, request.merchant.name, request.amount);
      let outcome = evaluateRules({
        card,
        amount: request.amount,
        currency: request.currency,
        merchant: request.merchant,
        cardSpendToDate: spend.total,
        cardSpendInWindow: spend.inWindow,
        hasApprovalGrant: grant !== undefined,
      });

      // Org approval threshold: route to review even if the card has none.
      if (
        outcome.decision === "approve" &&
        policy.approvalThreshold !== undefined &&
        request.amount >= policy.approvalThreshold &&
        grant === undefined
      ) {
        outcome = { decision: "review", reason: "amount_requires_org_approval" };
      }

      if (outcome.decision === "decline") {
        return this.recordDecline(client, stage, request, card, outcome.reason);
      }

      // Department monthly budget — a hard cap across all of a department's agents.
      if (outcome.decision === "approve" && card.departmentId) {
        const budgeted = await this.departmentBudgetExceeded(client, card.departmentId, request.amount);
        if (budgeted) return this.recordDecline(client, stage, request, card, "department_budget_exceeded");
      }

      if (outcome.decision === "review") {
        const approval = await this.openApproval(client, {
          cardId: card.id,
          accountHolderId: card.accountHolderId,
          amount: request.amount,
          currency: card.currency,
          merchantName: request.merchant.name,
          merchantCategory: request.merchant.category,
          reason: outcome.reason,
        });
        stage({ type: "approval.requested", data: { approvalId: approval.id, cardId: card.id, amount: request.amount } });
        const decision = await this.recordDecline(client, stage, request, card, "pending_human_approval", approval.id);
        return { ...decision, approvalId: approval.id };
      }

      // Approve: check available balance under the row lock, then place the hold.
      const b = await this.balances(client, card.walletAccountId);
      if (request.amount > b.available) {
        return this.recordDecline(client, stage, request, card, "insufficient_funds");
      }

      const settlement = await this.ensureSettlementAccount(client, card.currency);
      const hold = await this.recordLedgerTx(client, {
        status: "held",
        currency: card.currency,
        description: `authorization at ${request.merchant.name}`,
        reference: request.authorizationId,
        metadata: { cardId: card.id, authorizationId: request.authorizationId },
        postings: [
          { accountId: card.walletAccountId, direction: "debit", amount: request.amount },
          { accountId: settlement, direction: "credit", amount: request.amount },
        ],
      });

      if (grant) {
        await client.query("UPDATE acard_approvals SET status = 'consumed' WHERE id = $1", [grant.id]);
      }

      const transaction: CardTransaction = {
        id: txId,
        cardId: card.id,
        accountHolderId: card.accountHolderId,
        type: "authorization",
        status: "pending",
        amount: request.amount,
        currency: card.currency,
        merchantName: request.merchant.name,
        merchantCategory: request.merchant.category,
        approvalId: grant?.id,
        ledgerTransactionId: hold.id,
        createdAt: new Date().toISOString(),
      };
      await this.insertCardTx(client, transaction);
      await client.query(
        "INSERT INTO acard_open_holds (authorization_id, ledger_transaction_id, card_transaction_id) VALUES ($1, $2, $3)",
        [request.authorizationId, hold.id, transaction.id],
      );
      stage({ type: "authorization.approved", data: { cardId: card.id, authorizationId: request.authorizationId, amount: request.amount } });
      return { approved: true, transaction };
    });
  }

  private async cardSpend(client: Client, cardId: string, windowSeconds: number): Promise<{ total: number; inWindow: number }> {
    const totalRes = await client.query(
      `SELECT COALESCE(SUM(amount), 0) AS total FROM acard_card_transactions
       WHERE card_id = $1 AND status IN ('pending', 'completed')`,
      [cardId],
    );
    let inWindow = 0;
    if (windowSeconds > 0) {
      const windowRes = await client.query(
        `SELECT COALESCE(SUM(amount), 0) AS total FROM acard_card_transactions
         WHERE card_id = $1 AND status IN ('pending', 'completed')
           AND created_at >= now() - ($2 || ' seconds')::interval`,
        [cardId, windowSeconds],
      );
      inWindow = Number(windowRes.rows[0].total);
    }
    return { total: Number(totalRes.rows[0].total), inWindow };
  }

  private async findGrant(client: Client, cardId: string, merchantName: string, amount: number): Promise<{ id: string } | undefined> {
    const res = await client.query(
      `SELECT id FROM acard_approvals
       WHERE status = 'approved' AND card_id = $1 AND merchant_name = $2 AND amount >= $3
       ORDER BY created_at ASC LIMIT 1 FOR UPDATE`,
      [cardId, merchantName, amount],
    );
    return res.rowCount ? { id: res.rows[0].id } : undefined;
  }

  private async openApproval(
    client: Client,
    input: { cardId: string; accountHolderId: string; amount: number; currency: Currency; merchantName: string; merchantCategory: string; reason: string },
  ): Promise<ApprovalRequest> {
    const existing = await client.query(
      `SELECT * FROM acard_approvals
       WHERE status = 'pending' AND card_id = $1 AND merchant_name = $2 AND amount = $3
       ORDER BY created_at ASC LIMIT 1`,
      [input.cardId, input.merchantName, input.amount],
    );
    if (existing.rowCount) return this.mapApproval(existing.rows[0]);
    const id = newId("appr");
    const res = await client.query(
      `INSERT INTO acard_approvals
         (id, card_id, account_holder_id, amount, currency, merchant_name, merchant_category, reason, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending') RETURNING *`,
      [id, input.cardId, input.accountHolderId, input.amount, input.currency, input.merchantName, input.merchantCategory, input.reason],
    );
    return this.mapApproval(res.rows[0]);
  }

  private async insertCardTx(client: Client, t: CardTransaction): Promise<void> {
    await client.query(
      `INSERT INTO acard_card_transactions
         (id, card_id, account_holder_id, type, status, amount, currency, merchant_name, merchant_category,
          decline_reason, approval_id, ledger_transaction_id, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        t.id, t.cardId, t.accountHolderId, t.type, t.status, t.amount, t.currency, t.merchantName, t.merchantCategory,
        t.declineReason ?? null, t.approvalId ?? null, t.ledgerTransactionId ?? null, t.createdAt,
      ],
    );
  }

  private async recordDecline(
    client: Client,
    stage: (event: Omit<PlatformEvent, "id" | "createdAt">) => void,
    request: AuthorizationRequest,
    card: Card | undefined,
    reason: string,
    approvalId?: string,
  ): Promise<AuthorizationDecision> {
    const transaction: CardTransaction = {
      id: `ctx_${request.authorizationId}`,
      cardId: request.cardId,
      accountHolderId: card?.accountHolderId ?? "unknown",
      type: "declined",
      status: "declined",
      amount: request.amount,
      currency: request.currency,
      merchantName: request.merchant.name,
      merchantCategory: request.merchant.category,
      declineReason: reason,
      approvalId,
      createdAt: new Date().toISOString(),
    };
    await this.insertCardTx(client, transaction);
    stage({ type: "authorization.declined", data: { authorizationId: request.authorizationId, reason } });
    return { approved: false, declineReason: reason, transaction, approvalId };
  }

  async capture(authorizationId: string, finalAmount?: number): Promise<CardTransaction> {
    return this.tx(async (client, stage) => {
      const open = await client.query("SELECT * FROM acard_open_holds WHERE authorization_id = $1", [authorizationId]);
      if (!open.rowCount) throw new NotFoundError("open authorization", authorizationId);
      const { ledger_transaction_id: ledgerTxId, card_transaction_id: cardTxId } = open.rows[0];

      const ltxRes = await client.query("SELECT * FROM acard_ledger_transactions WHERE id = $1 FOR UPDATE", [ledgerTxId]);
      if (ltxRes.rows[0].status !== "held") {
        throw new DomainError("invalid_state", `transaction ${ledgerTxId} is ${ltxRes.rows[0].status}, not held`, 409);
      }
      if (finalAmount !== undefined) {
        const original = Number(
          (await client.query("SELECT amount FROM acard_postings WHERE tx_id = $1 ORDER BY position ASC LIMIT 1", [ledgerTxId])).rows[0].amount,
        );
        if (finalAmount <= 0 || finalAmount > original) {
          throw new DomainError("invalid_capture_amount", `capture amount ${finalAmount} must be > 0 and <= held amount ${original}`);
        }
        await client.query("UPDATE acard_postings SET amount = $2 WHERE tx_id = $1", [ledgerTxId, finalAmount]);
      }
      await client.query("UPDATE acard_ledger_transactions SET status = 'posted', settled_at = now() WHERE id = $1", [ledgerTxId]);

      const updated = await client.query(
        `UPDATE acard_card_transactions
         SET status = 'completed', type = 'capture'${finalAmount !== undefined ? ", amount = $2" : ""}
         WHERE id = $1 RETURNING *`,
        finalAmount !== undefined ? [cardTxId, finalAmount] : [cardTxId],
      );
      await client.query("DELETE FROM acard_open_holds WHERE authorization_id = $1", [authorizationId]);

      const transaction = this.mapCardTx(updated.rows[0]);
      const cardRes = await client.query("SELECT * FROM acard_cards WHERE id = $1 FOR UPDATE", [transaction.cardId]);
      const card = this.mapCard(cardRes.rows[0]);
      if (card.singleUse && card.status === "active") {
        await client.query(
          "UPDATE acard_cards SET status = 'closed', closed_at = now(), close_reason = 'single_use_completed' WHERE id = $1",
          [card.id],
        );
        stage({ type: "card.closed", data: { cardId: card.id, reason: "single_use_completed" } });
      }
      stage({ type: "transaction.captured", data: { cardId: card.id, authorizationId, amount: transaction.amount } });
      return transaction;
    });
  }

  async reverse(authorizationId: string): Promise<CardTransaction> {
    return this.tx(async (client, stage) => {
      const open = await client.query("SELECT * FROM acard_open_holds WHERE authorization_id = $1", [authorizationId]);
      if (!open.rowCount) throw new NotFoundError("open authorization", authorizationId);
      const { ledger_transaction_id: ledgerTxId, card_transaction_id: cardTxId } = open.rows[0];

      const ltxRes = await client.query("SELECT status FROM acard_ledger_transactions WHERE id = $1 FOR UPDATE", [ledgerTxId]);
      if (ltxRes.rows[0].status !== "held") {
        throw new DomainError("invalid_state", `transaction ${ledgerTxId} is ${ltxRes.rows[0].status}, not held`, 409);
      }
      await client.query("UPDATE acard_ledger_transactions SET status = 'released', settled_at = now() WHERE id = $1", [ledgerTxId]);
      const updated = await client.query(
        "UPDATE acard_card_transactions SET status = 'reversed' WHERE id = $1 RETURNING *",
        [cardTxId],
      );
      await client.query("DELETE FROM acard_open_holds WHERE authorization_id = $1", [authorizationId]);
      stage({ type: "authorization.reversed", data: { authorizationId } });
      return this.mapCardTx(updated.rows[0]);
    });
  }

  // ---- idempotency ----------------------------------------------------------

  async idempotencyGet(key: string, requestHash: string): Promise<IdempotencyLookup> {
    const res = await this.pool.query("SELECT request_hash, status, body FROM acard_idempotency WHERE key = $1", [key]);
    if (!res.rowCount) return { hit: false, conflict: false };
    const row = res.rows[0];
    if (row.request_hash !== requestHash) return { hit: false, conflict: true };
    return { hit: true, status: row.status, body: row.body };
  }

  async idempotencyPut(key: string, requestHash: string, status: number, body: unknown): Promise<void> {
    await this.pool.query(
      `INSERT INTO acard_idempotency (key, request_hash, status, body) VALUES ($1, $2, $3, $4)
       ON CONFLICT (key) DO NOTHING`,
      [key, requestHash, status, body === undefined ? null : JSON.stringify(body)],
    );
  }

  async markEvent(eventId: string): Promise<boolean> {
    const res = await this.pool.query(
      "INSERT INTO acard_events_seen (event_id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING event_id",
      [eventId],
    );
    return res.rowCount === 1;
  }

  // ---- human auth & RBAC ----------------------------------------------------

  async registerAccount(input: { email: string; name: string; password: string; currency?: Currency; accountType?: WorkspaceType }): Promise<RegisterResult> {
    const email = input.email.toLowerCase();
    if (input.password.length < 8) throw new DomainError("weak_password", "password must be at least 8 characters");
    const currency = input.currency ?? "ZAR";
    const accountType = input.accountType ?? "personal";
    return this.tx(async (client, stage) => {
      const dupeUser = await client.query("SELECT 1 FROM acard_users WHERE email = $1", [email]);
      if (dupeUser.rowCount) throw new InvalidStateError(`a user with email ${input.email} already exists`);
      const dupeOrg = await client.query("SELECT 1 FROM acard_account_holders WHERE email = $1", [email]);
      if (dupeOrg.rowCount) throw new InvalidStateError(`an account for ${input.email} already exists`);

      // org (account holder) + wallet
      const walletAccountId = newId("acct");
      await client.query("INSERT INTO acard_accounts (id, name, type, currency) VALUES ($1, $2, 'liability', $3)", [
        walletAccountId,
        `wallet:${email}:${currency}`,
        currency,
      ]);
      const accountHolder: AccountHolder = {
        id: newId("ah"),
        email,
        name: input.name,
        currency,
        walletAccountId,
        subscriptionTier: "free",
        accountType,
        createdAt: new Date().toISOString(),
      };
      await client.query(
        `INSERT INTO acard_account_holders (id, email, name, currency, wallet_account_id, subscription_tier, account_type, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [accountHolder.id, email, accountHolder.name, currency, walletAccountId, "free", accountType, accountHolder.createdAt],
      );
      await client.query(
        "INSERT INTO acard_wallets (account_holder_id, currency, account_id) VALUES ($1, $2, $3)",
        [accountHolder.id, currency, walletAccountId],
      );

      // user + owner membership
      const userId = newId("usr");
      const passwordHash = hashPassword(input.password);
      const createdAt = new Date().toISOString();
      await client.query(
        "INSERT INTO acard_users (id, email, name, password_hash, created_at) VALUES ($1,$2,$3,$4,$5)",
        [userId, email, input.name, passwordHash, createdAt],
      );
      await client.query(
        "INSERT INTO acard_memberships (user_id, account_holder_id, role, created_at) VALUES ($1,$2,'owner',$3)",
        [userId, accountHolder.id, createdAt],
      );

      const { token } = await this.insertSession(client, userId, accountHolder.id);
      stage({ type: "account_holder.created", data: { accountHolderId: accountHolder.id } });
      stage({ type: "user.registered", data: { userId, accountHolderId: accountHolder.id } });
      return {
        user: { id: userId, email, name: input.name, createdAt },
        accountHolder,
        sessionToken: token,
        context: { user: { id: userId, email, name: input.name, createdAt }, accountHolderId: accountHolder.id, role: "owner" },
      };
    });
  }

  private async insertSession(client: Client, userId: string, accountHolderId: string): Promise<{ token: string; expiresAt: string }> {
    const token = `sess_${randomBytes(32).toString("base64url")}`;
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
    await client.query(
      "INSERT INTO acard_sessions (hashed_token, user_id, account_holder_id, expires_at) VALUES ($1,$2,$3,$4)",
      [hashSessionToken(token), userId, accountHolderId, expiresAt],
    );
    return { token, expiresAt };
  }

  async login(input: { email: string; password: string; accountHolderId?: string }): Promise<{ sessionToken: string; context: SessionContext }> {
    const email = input.email.toLowerCase();
    const windowStart = new Date(Date.now() - LOGIN_LOCKOUT_WINDOW_MS).toISOString();
    const attemptsRes = await this.pool.query(
      "SELECT count(*) FROM acard_login_attempts WHERE email = $1 AND attempted_at > $2",
      [email, windowStart],
    );
    if (Number(attemptsRes.rows[0].count) >= LOGIN_LOCKOUT_THRESHOLD) {
      throw new DomainError("account_locked", "too many failed login attempts — try again in a few minutes", 429);
    }

    const userRes = await this.pool.query("SELECT * FROM acard_users WHERE email = $1", [email]);
    if (!userRes.rowCount || !verifyPassword(input.password, userRes.rows[0].password_hash)) {
      await this.pool.query("INSERT INTO acard_login_attempts (email) VALUES ($1)", [email]);
      throw new DomainError("invalid_credentials", "invalid email or password", 401);
    }
    await this.pool.query("DELETE FROM acard_login_attempts WHERE email = $1", [email]);
    const user = userRes.rows[0];
    const memberships = await this.pool.query(
      "SELECT * FROM acard_memberships WHERE user_id = $1 ORDER BY created_at ASC",
      [user.id],
    );
    if (!memberships.rowCount) throw new DomainError("no_membership", "user has no organization", 403);
    const membership =
      (input.accountHolderId && memberships.rows.find((m) => m.account_holder_id === input.accountHolderId)) ||
      memberships.rows[0];
    const client = await this.pool.connect();
    try {
      const { token } = await this.insertSession(client, user.id, membership.account_holder_id);
      return {
        sessionToken: token,
        context: {
          user: { id: user.id, email: user.email, name: user.name, createdAt: new Date(user.created_at).toISOString() },
          accountHolderId: membership.account_holder_id,
          role: membership.role,
        },
      };
    } finally {
      client.release();
    }
  }

  async resolveSession(token: string): Promise<SessionContext | undefined> {
    const res = await this.pool.query(
      `SELECT s.expires_at, s.account_holder_id, u.id AS user_id, u.email, u.name, u.created_at, m.role
       FROM acard_sessions s
       JOIN acard_users u ON u.id = s.user_id
       JOIN acard_memberships m ON m.user_id = s.user_id AND m.account_holder_id = s.account_holder_id
       WHERE s.hashed_token = $1`,
      [hashSessionToken(token)],
    );
    if (!res.rowCount) return undefined;
    const row = res.rows[0];
    if (new Date(row.expires_at).getTime() < Date.now()) {
      await this.pool.query("DELETE FROM acard_sessions WHERE hashed_token = $1", [hashSessionToken(token)]);
      return undefined;
    }
    return {
      user: { id: row.user_id, email: row.email, name: row.name, createdAt: new Date(row.created_at).toISOString() },
      accountHolderId: row.account_holder_id,
      role: row.role,
    };
  }

  async logout(token: string): Promise<void> {
    await this.pool.query("DELETE FROM acard_sessions WHERE hashed_token = $1", [hashSessionToken(token)]);
  }

  async addMember(input: { accountHolderId: string; email: string; name?: string; password?: string; role: Role }): Promise<MemberView> {
    const email = input.email.toLowerCase();
    return this.tx(async (client) => {
      let user = (await client.query("SELECT * FROM acard_users WHERE email = $1", [email])).rows[0];
      if (!user) {
        if (!input.password) throw new DomainError("password_required", "a starting password is required to invite a new user");
        if (input.password.length < 8) throw new DomainError("weak_password", "password must be at least 8 characters");
        const userId = newId("usr");
        const createdAt = new Date().toISOString();
        await client.query(
          "INSERT INTO acard_users (id, email, name, password_hash, created_at) VALUES ($1,$2,$3,$4,$5)",
          [userId, email, input.name ?? email, hashPassword(input.password), createdAt],
        );
        user = { id: userId, email, name: input.name ?? email, created_at: createdAt };
      }
      const createdAt = new Date().toISOString();
      await client.query(
        `INSERT INTO acard_memberships (user_id, account_holder_id, role, created_at) VALUES ($1,$2,$3,$4)
         ON CONFLICT (user_id, account_holder_id) DO UPDATE SET role = EXCLUDED.role`,
        [user.id, input.accountHolderId, input.role, createdAt],
      );
      return {
        user: { id: user.id, email: user.email, name: user.name, createdAt: new Date(user.created_at).toISOString() },
        role: input.role,
        createdAt,
      };
    });
  }

  async listMembers(accountHolderId: string): Promise<MemberView[]> {
    const res = await this.pool.query(
      `SELECT u.id, u.email, u.name, u.created_at AS user_created, m.role, m.created_at AS member_created
       FROM acard_memberships m JOIN acard_users u ON u.id = m.user_id
       WHERE m.account_holder_id = $1 ORDER BY m.created_at ASC`,
      [accountHolderId],
    );
    return res.rows.map((row) => ({
      user: { id: row.id, email: row.email, name: row.name, createdAt: new Date(row.user_created).toISOString() },
      role: row.role,
      createdAt: new Date(row.member_created).toISOString(),
    }));
  }

  // ---- enterprise: departments & policy ------------------------------------

  private mapDept(row: any): Department {
    return {
      id: row.id,
      accountHolderId: row.account_holder_id,
      name: row.name,
      monthlyBudget: Number(row.monthly_budget),
      lead: row.lead ?? undefined,
      createdAt: new Date(row.created_at).toISOString(),
    };
  }

  private async loadPolicy(client: Client, accountHolderId: string): Promise<OrgPolicy> {
    const res = await client.query("SELECT blocked_mccs, approval_threshold FROM acard_org_policies WHERE account_holder_id = $1", [accountHolderId]);
    if (!res.rowCount) return { blockedMerchantCategories: [] };
    const row = res.rows[0];
    return {
      blockedMerchantCategories: row.blocked_mccs ?? [],
      approvalThreshold: row.approval_threshold === null ? undefined : Number(row.approval_threshold),
    };
  }

  /** True if this department's captured+held spend this period plus `amount` exceeds its budget. */
  private async departmentBudgetExceeded(client: Client, departmentId: string, amount: number): Promise<boolean> {
    const deptRes = await client.query("SELECT monthly_budget FROM acard_departments WHERE id = $1", [departmentId]);
    if (!deptRes.rowCount) return false;
    const budget = Number(deptRes.rows[0].monthly_budget);
    const spentRes = await client.query(
      `SELECT COALESCE(SUM(t.amount), 0) AS spent
       FROM acard_card_transactions t JOIN acard_cards c ON c.id = t.card_id
       WHERE c.department_id = $1 AND t.status IN ('pending','completed')
         AND to_char(t.created_at AT TIME ZONE 'UTC', 'YYYY-MM') = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM')`,
      [departmentId],
    );
    return Number(spentRes.rows[0].spent) + amount > budget;
  }

  async createDepartment(input: { accountHolderId: string; name: string; monthlyBudget: number; lead?: string }): Promise<Department> {
    if (!input.name.trim()) throw new DomainError("invalid_department", "department name is required");
    if (!Number.isSafeInteger(input.monthlyBudget) || input.monthlyBudget <= 0) {
      throw new DomainError("invalid_department", "monthlyBudget must be a positive integer of minor units");
    }
    const id = newId("dept");
    const createdAt = new Date().toISOString();
    await this.pool.query(
      "INSERT INTO acard_departments (id, account_holder_id, name, monthly_budget, lead, created_at) VALUES ($1,$2,$3,$4,$5,$6)",
      [id, input.accountHolderId, input.name.trim(), input.monthlyBudget, input.lead ?? null, createdAt],
    );
    return { id, accountHolderId: input.accountHolderId, name: input.name.trim(), monthlyBudget: input.monthlyBudget, lead: input.lead, createdAt };
  }

  async updateDepartment(id: string, patch: { name?: string; monthlyBudget?: number; lead?: string }): Promise<Department> {
    if (patch.monthlyBudget !== undefined && (!Number.isSafeInteger(patch.monthlyBudget) || patch.monthlyBudget <= 0)) {
      throw new DomainError("invalid_department", "monthlyBudget must be a positive integer of minor units");
    }
    const res = await this.pool.query(
      `UPDATE acard_departments SET
         name = COALESCE($2, name),
         monthly_budget = COALESCE($3, monthly_budget),
         lead = COALESCE($4, lead)
       WHERE id = $1 RETURNING *`,
      [id, patch.name?.trim() || null, patch.monthlyBudget ?? null, patch.lead ?? null],
    );
    if (!res.rowCount) throw new NotFoundError("department", id);
    return this.mapDept(res.rows[0]);
  }

  async listDepartments(accountHolderId: string): Promise<Department[]> {
    const res = await this.pool.query("SELECT * FROM acard_departments WHERE account_holder_id = $1 ORDER BY created_at ASC", [accountHolderId]);
    return res.rows.map((r) => this.mapDept(r));
  }

  async listDepartmentSpend(accountHolderId: string): Promise<DepartmentSpend[]> {
    const holder = await this.getAccountHolder(accountHolderId);
    const res = await this.pool.query(
      `SELECT d.*,
         (SELECT COUNT(*) FROM acard_cards c WHERE c.department_id = d.id) AS card_count,
         (SELECT COALESCE(SUM(t.amount),0) FROM acard_card_transactions t JOIN acard_cards c ON c.id = t.card_id
            WHERE c.department_id = d.id AND t.status IN ('pending','completed')
              AND to_char(t.created_at AT TIME ZONE 'UTC','YYYY-MM') = to_char(now() AT TIME ZONE 'UTC','YYYY-MM')) AS spent
       FROM acard_departments d WHERE d.account_holder_id = $1 ORDER BY d.created_at ASC`,
      [accountHolderId],
    );
    return res.rows.map((r) => ({
      department: this.mapDept(r),
      spentThisMonth: Number(r.spent),
      cardCount: Number(r.card_count),
      currency: holder?.currency ?? "ZAR",
    }));
  }

  async getPolicy(accountHolderId: string): Promise<OrgPolicy> {
    const client = await this.pool.connect();
    try {
      return await this.loadPolicy(client, accountHolderId);
    } finally {
      client.release();
    }
  }

  async setPolicy(accountHolderId: string, policy: OrgPolicy): Promise<OrgPolicy> {
    if (policy.approvalThreshold !== undefined && (!Number.isSafeInteger(policy.approvalThreshold) || policy.approvalThreshold <= 0)) {
      throw new DomainError("invalid_policy", "approvalThreshold must be a positive integer of minor units");
    }
    const blocked = [...new Set(policy.blockedMerchantCategories ?? [])];
    await this.pool.query(
      `INSERT INTO acard_org_policies (account_holder_id, blocked_mccs, approval_threshold) VALUES ($1,$2,$3)
       ON CONFLICT (account_holder_id) DO UPDATE SET blocked_mccs = EXCLUDED.blocked_mccs, approval_threshold = EXCLUDED.approval_threshold`,
      [accountHolderId, JSON.stringify(blocked), policy.approvalThreshold ?? null],
    );
    return { blockedMerchantCategories: blocked, approvalThreshold: policy.approvalThreshold };
  }

  // ---- crypto wallets: embedded (default) + optional external linking ------

  private mapWallet(row: any): LinkedWallet {
    return {
      id: row.id,
      accountHolderId: row.account_holder_id,
      kind: row.kind,
      chain: row.chain,
      address: row.address,
      connector: row.connector ?? undefined,
      label: row.label ?? undefined,
      isDefault: row.is_default,
      createdAt: new Date(row.created_at).toISOString(),
    };
  }

  private async insertLinkedWallet(
    client: Client | pg.Pool,
    input: {
      accountHolderId: string;
      kind: "embedded" | "external";
      chain: Chain;
      address: string;
      connector?: ExternalWalletConnector;
      label?: string;
    },
  ): Promise<LinkedWallet> {
    const existingRes = await client.query("SELECT 1 FROM acard_linked_wallets WHERE account_holder_id = $1 LIMIT 1", [
      input.accountHolderId,
    ]);
    const isDefault = existingRes.rowCount === 0;
    const id = newId("wal");
    const createdAt = new Date().toISOString();
    const res = await client.query(
      `INSERT INTO acard_linked_wallets (id, account_holder_id, kind, chain, address, connector, label, is_default, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [id, input.accountHolderId, input.kind, input.chain, input.address, input.connector ?? null, input.label ?? null, isDefault, createdAt],
    );
    return this.mapWallet(res.rows[0]);
  }

  async recordEmbeddedWallet(accountHolderId: string, chain: Chain, address: string): Promise<LinkedWallet> {
    const existing = await this.pool.query(
      "SELECT * FROM acard_linked_wallets WHERE account_holder_id = $1 AND kind = 'embedded' AND chain = $2",
      [accountHolderId, chain],
    );
    if (existing.rowCount) return this.mapWallet(existing.rows[0]);
    return this.insertLinkedWallet(this.pool, { accountHolderId, kind: "embedded", chain, address });
  }

  async linkExternalWallet(input: {
    accountHolderId: string;
    chain: Chain;
    address: string;
    connector: ExternalWalletConnector;
    label?: string;
  }): Promise<LinkedWallet> {
    const { isValidAddress } = await import("@acard/core");
    if (!isValidAddress(input.chain, input.address)) {
      throw new DomainError("invalid_state", `"${input.address}" is not a valid ${input.chain} address`);
    }
    const duplicate = await this.pool.query(
      "SELECT 1 FROM acard_linked_wallets WHERE account_holder_id = $1 AND chain = $2 AND lower(address) = lower($3)",
      [input.accountHolderId, input.chain, input.address],
    );
    if (duplicate.rowCount) {
      throw new DomainError("invalid_state", "this wallet is already linked to this account");
    }
    return this.insertLinkedWallet(this.pool, { ...input, kind: "external" });
  }

  async listLinkedWallets(accountHolderId: string): Promise<LinkedWallet[]> {
    const res = await this.pool.query(
      "SELECT * FROM acard_linked_wallets WHERE account_holder_id = $1 ORDER BY created_at ASC",
      [accountHolderId],
    );
    return res.rows.map((r) => this.mapWallet(r));
  }

  async setDefaultWallet(accountHolderId: string, id: string): Promise<LinkedWallet> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const target = await client.query("SELECT * FROM acard_linked_wallets WHERE id = $1 AND account_holder_id = $2", [
        id,
        accountHolderId,
      ]);
      if (!target.rowCount) throw new NotFoundError("wallet", id);
      await client.query("UPDATE acard_linked_wallets SET is_default = false WHERE account_holder_id = $1", [accountHolderId]);
      const res = await client.query("UPDATE acard_linked_wallets SET is_default = true WHERE id = $1 RETURNING *", [id]);
      await client.query("COMMIT");
      return this.mapWallet(res.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async unlinkWallet(accountHolderId: string, id: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const target = await client.query("SELECT * FROM acard_linked_wallets WHERE id = $1 AND account_holder_id = $2", [
        id,
        accountHolderId,
      ]);
      if (!target.rowCount) throw new NotFoundError("wallet", id);
      if (target.rows[0].kind === "embedded") {
        throw new InvalidStateError("the embedded wallet cannot be unlinked");
      }
      await client.query("DELETE FROM acard_linked_wallets WHERE id = $1", [id]);
      if (target.rows[0].is_default) {
        await client.query(
          `UPDATE acard_linked_wallets SET is_default = true WHERE id = (
             SELECT id FROM acard_linked_wallets WHERE account_holder_id = $1 ORDER BY created_at ASC LIMIT 1
           )`,
          [accountHolderId],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  // ---- events & lifecycle ---------------------------------------------------

  onEvent(listener: (event: PlatformEvent) => void): void {
    this.listeners.push(listener);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export function hashRequestPayload(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload) ?? "null").digest("hex");
}
