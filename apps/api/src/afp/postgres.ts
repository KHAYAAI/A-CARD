import pg from "pg";
import {
  DomainError,
  InvalidStateError,
  NotFoundError,
  type AfpIntent,
  type AfpTransaction,
  type AfpTransactionStatus,
  type RailExecutionResult,
  type RailFinality,
  type RailId,
} from "@acard/core";
import type { AfpLedgerPort } from "./types.js";

/**
 * Multi-writer Postgres backing for AFP's cross-rail ledger — the gap named
 * when AFP first shipped: the ledger only ever lived in memory, so it
 * couldn't run alongside A-CARD's own Postgres multi-writer store. Same
 * relationship to `AfpLedger` that `apps/api/src/merchant/postgres.ts` has
 * to `MerchantDirectory` — its own tables, its own connection pool,
 * entirely separate from `PostgresPlatformService` so nothing here can
 * regress the ledger AFP itself sits downstream of.
 *
 * Every state transition takes a `SELECT ... FOR UPDATE` row lock before
 * writing — the same discipline the ledger's in-memory version gets for
 * free from JavaScript's single-threadedness, made explicit here because
 * two API tasks really can race to complete the same transaction.
 */

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS acard_afp_intents (
    id TEXT PRIMARY KEY,
    account_holder_id TEXT NOT NULL,
    amount BIGINT NOT NULL,
    currency TEXT NOT NULL,
    purpose TEXT NOT NULL,
    counterparty TEXT NOT NULL,
    allowed_rails JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS acard_afp_transactions (
    id TEXT PRIMARY KEY,
    intent_id TEXT NOT NULL REFERENCES acard_afp_intents(id),
    account_holder_id TEXT NOT NULL,
    rail TEXT NOT NULL,
    amount BIGINT NOT NULL,
    currency TEXT NOT NULL,
    status TEXT NOT NULL,
    finality JSONB NOT NULL,
    rail_reference TEXT,
    idempotency_key TEXT NOT NULL,
    settled_at TIMESTAMPTZ,
    reversal_reason TEXT,
    history JSONB NOT NULL DEFAULT '[]',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE UNIQUE INDEX IF NOT EXISTS acard_afp_tx_idem_idx ON acard_afp_transactions(idempotency_key);
  CREATE INDEX IF NOT EXISTS acard_afp_tx_holder_idx ON acard_afp_transactions(account_holder_id);
`;

function rowToIntent(row: any): AfpIntent {
  return {
    id: row.id,
    accountHolderId: row.account_holder_id,
    amount: Number(row.amount),
    currency: row.currency,
    purpose: row.purpose,
    counterparty: row.counterparty,
    allowedRails: row.allowed_rails ?? undefined,
    createdAt: row.created_at.toISOString(),
  };
}

function rowToTransaction(row: any): AfpTransaction {
  return {
    id: row.id,
    intentId: row.intent_id,
    accountHolderId: row.account_holder_id,
    rail: row.rail,
    amount: Number(row.amount),
    currency: row.currency,
    status: row.status,
    finality: row.finality,
    railReference: row.rail_reference ?? undefined,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    settledAt: row.settled_at?.toISOString(),
    reversalReason: row.reversal_reason ?? undefined,
    history: row.history,
  };
}

async function withTransaction<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export class PostgresAfpLedger implements AfpLedgerPort {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, max: 5 });
  }

  async migrate(): Promise<void> {
    await this.pool.query(SCHEMA);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async recordIntent(intent: AfpIntent): Promise<void> {
    await this.pool.query(
      `INSERT INTO acard_afp_intents (id, account_holder_id, amount, currency, purpose, counterparty, allowed_rails, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (id) DO NOTHING`,
      [
        intent.id,
        intent.accountHolderId,
        intent.amount,
        intent.currency,
        intent.purpose,
        intent.counterparty,
        intent.allowedRails ? JSON.stringify(intent.allowedRails) : null,
        intent.createdAt,
      ],
    );
  }

  async getIntent(id: string): Promise<AfpIntent> {
    const { rows } = await this.pool.query("SELECT * FROM acard_afp_intents WHERE id = $1", [id]);
    if (rows.length === 0) throw new NotFoundError("AFP intent", id);
    return rowToIntent(rows[0]);
  }

  async beginExecution(intent: AfpIntent, rail: RailId, finality: RailFinality, idempotencyKey: string): Promise<AfpTransaction> {
    // A plain SELECT-then-INSERT has a real race here: two concurrent
    // requests carrying the same key can both see "not found" before either
    // commits. The UNIQUE index on idempotency_key is the actual guarantee
    // — INSERT ... ON CONFLICT DO NOTHING either wins the row or backs off,
    // and either way the caller gets the one row that exists, never two.
    const id = `afptx_${idempotencyKey.replace(/[^a-zA-Z0-9]/g, "").slice(0, 12)}_${Date.now().toString(36)}`;
    const now = new Date();
    const history = [{ status: "pending", at: now.toISOString() }];
    const inserted = await this.pool.query(
      `INSERT INTO acard_afp_transactions
         (id, intent_id, account_holder_id, rail, amount, currency, status, finality, idempotency_key, history, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,'pending',$7,$8,$9,$10,$10)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING *`,
      [id, intent.id, intent.accountHolderId, rail, intent.amount, intent.currency, JSON.stringify(finality), idempotencyKey, JSON.stringify(history), now],
    );
    if (inserted.rows[0]) return rowToTransaction(inserted.rows[0]);

    const existing = await this.pool.query("SELECT * FROM acard_afp_transactions WHERE idempotency_key = $1", [idempotencyKey]);
    return rowToTransaction(existing.rows[0]);
  }

  async completeExecution(transactionId: string, result: RailExecutionResult): Promise<AfpTransaction> {
    return withTransaction(this.pool, async (client) => {
      const current = await client.query("SELECT * FROM acard_afp_transactions WHERE id = $1 FOR UPDATE", [transactionId]);
      if (current.rows.length === 0) throw new NotFoundError("AFP transaction", transactionId);
      const tx = rowToTransaction(current.rows[0]);

      if (tx.status !== "pending" && tx.status !== "reconciling") {
        if (tx.railReference === result.railReference) return tx; // safe replay
        throw new InvalidStateError(
          `transaction ${transactionId} is already ${tx.status} with reference ${tx.railReference}; refusing to overwrite with ${result.railReference}`,
        );
      }

      const now = new Date();
      const status: AfpTransactionStatus = tx.finality.kind === "instant" ? "settled" : "posted";
      const history = [...tx.history, { status, at: now.toISOString(), note: `rail reference ${result.railReference}` }];
      const { rows } = await client.query(
        `UPDATE acard_afp_transactions
           SET status = $1, rail_reference = $2, settled_at = $3, history = $4, updated_at = $5
         WHERE id = $6
         RETURNING *`,
        [status, result.railReference, status === "settled" ? now : null, JSON.stringify(history), now, transactionId],
      );
      return rowToTransaction(rows[0]);
    });
  }

  async markReconciling(transactionId: string, note: string): Promise<AfpTransaction> {
    return this.transition(transactionId, "reconciling", ["pending"], note);
  }

  async markFailed(transactionId: string, note: string): Promise<AfpTransaction> {
    return this.transition(transactionId, "failed", ["pending", "reconciling"], note);
  }

  async settle(transactionId: string): Promise<AfpTransaction> {
    return withTransaction(this.pool, async (client) => {
      const current = await client.query("SELECT * FROM acard_afp_transactions WHERE id = $1 FOR UPDATE", [transactionId]);
      if (current.rows.length === 0) throw new NotFoundError("AFP transaction", transactionId);
      const tx = rowToTransaction(current.rows[0]);
      if (tx.status !== "posted") throw new InvalidStateError(`only a posted transaction can settle (${transactionId} is ${tx.status})`);
      const now = new Date();
      const history = [...tx.history, { status: "settled", at: now.toISOString() }];
      const { rows } = await client.query(
        "UPDATE acard_afp_transactions SET status = 'settled', settled_at = $1, history = $2, updated_at = $1 WHERE id = $3 RETURNING *",
        [now, JSON.stringify(history), transactionId],
      );
      return rowToTransaction(rows[0]);
    });
  }

  async reverse(transactionId: string, reason: string): Promise<AfpTransaction> {
    return withTransaction(this.pool, async (client) => {
      const current = await client.query("SELECT * FROM acard_afp_transactions WHERE id = $1 FOR UPDATE", [transactionId]);
      if (current.rows.length === 0) throw new NotFoundError("AFP transaction", transactionId);
      const tx = rowToTransaction(current.rows[0]);

      // Checked ahead of the status guard deliberately — see the identical
      // ordering (and its rationale) in the in-memory AfpLedger.reverse().
      if (tx.finality.kind === "instant") {
        throw new DomainError("not_reversible", `${tx.rail} settles instantly — this ledger cannot reverse it, only record a new offsetting transfer`);
      }
      if (tx.status !== "posted") throw new InvalidStateError(`only a posted transaction can be reversed (${transactionId} is ${tx.status})`);

      const now = new Date();
      const history = [...tx.history, { status: "reversed", at: now.toISOString(), note: reason }];
      const { rows } = await client.query(
        "UPDATE acard_afp_transactions SET status = 'reversed', reversal_reason = $1, history = $2, updated_at = $3 WHERE id = $4 RETURNING *",
        [reason, JSON.stringify(history), now, transactionId],
      );
      return rowToTransaction(rows[0]);
    });
  }

  private async transition(id: string, to: AfpTransactionStatus, from: AfpTransactionStatus[], note?: string): Promise<AfpTransaction> {
    return withTransaction(this.pool, async (client) => {
      const current = await client.query("SELECT * FROM acard_afp_transactions WHERE id = $1 FOR UPDATE", [id]);
      if (current.rows.length === 0) throw new NotFoundError("AFP transaction", id);
      const tx = rowToTransaction(current.rows[0]);
      if (!from.includes(tx.status)) throw new InvalidStateError(`cannot move transaction ${id} to ${to} from ${tx.status}`);
      const now = new Date();
      const history = [...tx.history, { status: to, at: now.toISOString(), note }];
      const { rows } = await client.query("UPDATE acard_afp_transactions SET status = $1, history = $2, updated_at = $3 WHERE id = $4 RETURNING *", [
        to,
        JSON.stringify(history),
        now,
        id,
      ]);
      return rowToTransaction(rows[0]);
    });
  }

  async get(id: string): Promise<AfpTransaction> {
    const { rows } = await this.pool.query("SELECT * FROM acard_afp_transactions WHERE id = $1", [id]);
    if (rows.length === 0) throw new NotFoundError("AFP transaction", id);
    return rowToTransaction(rows[0]);
  }

  async getByIdempotencyKey(key: string): Promise<AfpTransaction | undefined> {
    const { rows } = await this.pool.query("SELECT * FROM acard_afp_transactions WHERE idempotency_key = $1", [key]);
    return rows[0] ? rowToTransaction(rows[0]) : undefined;
  }

  async list(accountHolderId: string): Promise<AfpTransaction[]> {
    const { rows } = await this.pool.query("SELECT * FROM acard_afp_transactions WHERE account_holder_id = $1 ORDER BY created_at", [
      accountHolderId,
    ]);
    return rows.map(rowToTransaction);
  }

  async dueForSettlement(now = Date.now()): Promise<AfpTransaction[]> {
    const { rows } = await this.pool.query("SELECT * FROM acard_afp_transactions WHERE status = 'posted'");
    return rows.map(rowToTransaction).filter((t) => {
      if (t.finality.kind === "reversal_window") {
        const windowMs = (t.finality.reversalWindowDays ?? 0) * 24 * 60 * 60 * 1000;
        return Date.parse(t.updatedAt) + windowMs <= now;
      }
      if (t.finality.kind === "settlement_delay") {
        const delayMs = (t.finality.settlesAfterHours ?? 0) * 60 * 60 * 1000;
        return Date.parse(t.updatedAt) + delayMs <= now;
      }
      return false;
    });
  }
}
