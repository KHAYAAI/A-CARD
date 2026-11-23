import pg from "pg";
import { decryptField, encryptField } from "../encryption.js";
import type { AttachedCardStore, PasskeyStore, PendingChallenge, StoredPasskey } from "./store.js";
import type { AttachedCard, AttachedCardSettings, AttachedPurchase } from "./service.js";

/**
 * Postgres storage for attached cards and passkeys: its own tables and pool,
 * like the AFP ledger and A-MERCHANT. The vault reference is encrypted at rest
 * (AES-256-GCM, ACARD_ENCRYPTION_KEY). Card numbers are never stored anywhere.
 * Double approval and challenge reuse are prevented in SQL, not just in code,
 * so they hold across several API instances.
 */
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS acard_attached_cards (
    id TEXT PRIMARY KEY,
    account_holder_id TEXT NOT NULL,
    provider_ref_enc TEXT NOT NULL,
    brand TEXT NOT NULL,
    last4 TEXT NOT NULL,
    exp_month INT NOT NULL,
    exp_year INT NOT NULL,
    label TEXT,
    created_by TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL
  );
  CREATE INDEX IF NOT EXISTS acard_attached_cards_holder_idx ON acard_attached_cards(account_holder_id);

  CREATE TABLE IF NOT EXISTS acard_attached_card_settings (
    account_holder_id TEXT PRIMARY KEY,
    auto_approve_under BIGINT NOT NULL,
    max_per_purchase BIGINT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS acard_attached_purchases (
    id TEXT PRIMARY KEY,
    account_holder_id TEXT NOT NULL,
    card_id TEXT NOT NULL,
    amount BIGINT NOT NULL,
    currency TEXT NOT NULL,
    target JSONB NOT NULL,
    status TEXT NOT NULL,
    reason TEXT,
    release JSONB,
    requested_by TEXT NOT NULL,
    approved_by TEXT,
    created_at TIMESTAMPTZ NOT NULL,
    decided_at TIMESTAMPTZ
  );
  CREATE INDEX IF NOT EXISTS acard_attached_purchases_holder_idx ON acard_attached_purchases(account_holder_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS acard_passkeys (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    public_key BYTEA NOT NULL,
    counter BIGINT NOT NULL,
    transports JSONB,
    created_at TIMESTAMPTZ NOT NULL
  );
  CREATE INDEX IF NOT EXISTS acard_passkeys_user_idx ON acard_passkeys(user_id);

  CREATE TABLE IF NOT EXISTS acard_passkey_challenges (
    key TEXT PRIMARY KEY,
    challenge TEXT NOT NULL,
    user_id TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL
  );
`;

const iso = (v: Date | string | null | undefined) => (v ? new Date(v).toISOString() : undefined);

export class PostgresAttachedCardStore implements AttachedCardStore, PasskeyStore {
  readonly pool: pg.Pool;
  constructor(connectionString: string, private readonly key: Buffer) {
    this.pool = new pg.Pool({ connectionString, max: 5 });
  }
  async migrate() { await this.pool.query(SCHEMA); }
  async close() { await this.pool.end(); }

  // ---- cards
  private card(r: any): AttachedCard {
    return { id: r.id, accountHolderId: r.account_holder_id, providerRef: decryptField(r.provider_ref_enc, this.key), brand: r.brand, last4: r.last4, expMonth: r.exp_month, expYear: r.exp_year, label: r.label ?? undefined, createdBy: r.created_by, createdAt: iso(r.created_at)! };
  }
  async insertCard(c: AttachedCard) {
    await this.pool.query(
      `INSERT INTO acard_attached_cards (id, account_holder_id, provider_ref_enc, brand, last4, exp_month, exp_year, label, created_by, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [c.id, c.accountHolderId, encryptField(c.providerRef, this.key), c.brand, c.last4, c.expMonth, c.expYear, c.label ?? null, c.createdBy, c.createdAt],
    );
  }
  async getCard(id: string) { const r = await this.pool.query(`SELECT * FROM acard_attached_cards WHERE id = $1`, [id]); return r.rows[0] ? this.card(r.rows[0]) : undefined; }
  async listCards(h: string) { const r = await this.pool.query(`SELECT * FROM acard_attached_cards WHERE account_holder_id = $1 ORDER BY created_at`, [h]); return r.rows.map((x) => this.card(x)); }
  async deleteCard(id: string) { await this.pool.query(`DELETE FROM acard_attached_cards WHERE id = $1`, [id]); }

  // ---- settings
  async getSettings(h: string): Promise<AttachedCardSettings | undefined> {
    const r = await this.pool.query(`SELECT * FROM acard_attached_card_settings WHERE account_holder_id = $1`, [h]);
    return r.rows[0] ? { autoApproveUnder: Number(r.rows[0].auto_approve_under), maxPerPurchase: Number(r.rows[0].max_per_purchase) } : undefined;
  }
  async putSettings(h: string, s: AttachedCardSettings) {
    await this.pool.query(
      `INSERT INTO acard_attached_card_settings (account_holder_id, auto_approve_under, max_per_purchase) VALUES ($1,$2,$3)
       ON CONFLICT (account_holder_id) DO UPDATE SET auto_approve_under = EXCLUDED.auto_approve_under, max_per_purchase = EXCLUDED.max_per_purchase`,
      [h, s.autoApproveUnder, s.maxPerPurchase],
    );
  }

  // ---- purchases
  private purchase(r: any): AttachedPurchase {
    return { id: r.id, accountHolderId: r.account_holder_id, cardId: r.card_id, amount: Number(r.amount), currency: r.currency, target: r.target, status: r.status, reason: r.reason ?? undefined, release: r.release ?? undefined, requestedBy: r.requested_by, approvedBy: r.approved_by ?? undefined, createdAt: iso(r.created_at)!, decidedAt: iso(r.decided_at) };
  }
  async insertPurchase(p: AttachedPurchase) {
    await this.pool.query(
      `INSERT INTO acard_attached_purchases (id, account_holder_id, card_id, amount, currency, target, status, reason, release, requested_by, approved_by, created_at, decided_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [p.id, p.accountHolderId, p.cardId, p.amount, p.currency, JSON.stringify(p.target), p.status, p.reason ?? null, p.release ? JSON.stringify(p.release) : null, p.requestedBy, p.approvedBy ?? null, p.createdAt, p.decidedAt ?? null],
    );
  }
  async getPurchase(id: string) { const r = await this.pool.query(`SELECT * FROM acard_attached_purchases WHERE id = $1`, [id]); return r.rows[0] ? this.purchase(r.rows[0]) : undefined; }
  async listPurchases(h: string) { const r = await this.pool.query(`SELECT * FROM acard_attached_purchases WHERE account_holder_id = $1 ORDER BY created_at DESC LIMIT 200`, [h]); return r.rows.map((x) => this.purchase(x)); }
  async claim(id: string, to: "releasing" | "denied", by: string, at: string) {
    const r = await this.pool.query(
      `UPDATE acard_attached_purchases SET status = $2, approved_by = $3, decided_at = $4 WHERE id = $1 AND status = 'awaiting_approval'`,
      [id, to, by, at],
    );
    return r.rowCount === 1;
  }
  async updatePurchase(p: AttachedPurchase) {
    await this.pool.query(
      `UPDATE acard_attached_purchases SET status = $2, reason = $3, release = $4, approved_by = $5, decided_at = $6 WHERE id = $1`,
      [p.id, p.status, p.reason ?? null, p.release ? JSON.stringify(p.release) : null, p.approvedBy ?? null, p.decidedAt ?? null],
    );
  }

  // ---- passkeys
  async listCredentials(userId: string): Promise<StoredPasskey[]> {
    const r = await this.pool.query(`SELECT * FROM acard_passkeys WHERE user_id = $1 ORDER BY created_at`, [userId]);
    return r.rows.map((x) => ({ id: x.id, userId: x.user_id, publicKey: new Uint8Array(x.public_key), counter: Number(x.counter), transports: x.transports ?? undefined, createdAt: iso(x.created_at)! }));
  }
  async addCredential(c: StoredPasskey) {
    await this.pool.query(`INSERT INTO acard_passkeys (id, user_id, public_key, counter, transports, created_at) VALUES ($1,$2,$3,$4,$5,$6)`, [c.id, c.userId, Buffer.from(c.publicKey), c.counter, c.transports ? JSON.stringify(c.transports) : null, c.createdAt]);
  }
  async updateCounter(id: string, counter: number) {
    await this.pool.query(`UPDATE acard_passkeys SET counter = $2 WHERE id = $1 AND counter < $2`, [id, counter]);
  }
  async putChallenge(key: string, c: PendingChallenge) {
    await this.pool.query(
      `INSERT INTO acard_passkey_challenges (key, challenge, user_id, expires_at) VALUES ($1,$2,$3,$4)
       ON CONFLICT (key) DO UPDATE SET challenge = EXCLUDED.challenge, user_id = EXCLUDED.user_id, expires_at = EXCLUDED.expires_at`,
      [key, c.challenge, c.userId, new Date(c.expires).toISOString()],
    );
    await this.pool.query(`DELETE FROM acard_passkey_challenges WHERE expires_at < now() - interval '1 hour'`);
  }
  async takeChallenge(key: string): Promise<PendingChallenge | undefined> {
    const r = await this.pool.query(`DELETE FROM acard_passkey_challenges WHERE key = $1 RETURNING challenge, user_id, expires_at`, [key]);
    const x = r.rows[0];
    return x ? { challenge: x.challenge, userId: x.user_id, expires: new Date(x.expires_at).getTime() } : undefined;
  }
}
