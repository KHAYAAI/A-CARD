import pg from "pg";
import {
  classifyFreshness,
  DomainError,
  evaluateOffers,
  hashSessionToken,
  InvalidStateError,
  MERCHANT_INVITE_TTL_MS,
  MERCHANT_SESSION_TTL_MS,
  newId,
  NotFoundError,
  type Availability,
  type CatalogItem,
  type KybDocument,
  type Merchant,
  type MerchantInvite,
  type MerchantRole,
  type MerchantSessionContext,
  type MerchantStatus,
  type MerchantUser,
  type OfferQuery,
  type OfferSearchResult,
  type RegisterMerchantInput,
  type UpsertItemInput,
} from "@acard/core";
import type { MerchantAuthPort, MerchantDirectoryPort } from "./types.js";

/**
 * Multi-writer Postgres backing for A-MERCHANT — what lets it run alongside
 * A-CARD's own Postgres multi-writer store without either giving up
 * multi-instance safety (the gap flagged when the directory first shipped:
 * it only ever lived on the in-memory `Platform`, so this deployment path
 * left the whole surface unmounted).
 *
 * Deliberately its own connection pool and its own migration, entirely
 * separate from `PostgresPlatformService` — same database, zero shared code
 * path, so nothing here can regress the ledger.
 *
 * `search()` is the one method worth reading closely: it does not
 * reimplement ranking in SQL. SQL's job here is *retrieval* — narrowing the
 * (potentially large) catalog-items table down to the merchants a query
 * could possibly match — and `evaluateOffers` (packages/core/src/merchants.ts),
 * the exact function the in-memory directory itself calls, does the actual
 * filtering, scoring, and match-reason text. One ranking implementation,
 * tested once, used by both backends — see that function's own comment for
 * why a second, SQL-native ranking implementation is a correctness risk
 * this deliberately avoids.
 */

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS acard_merchants (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    trading_name TEXT,
    merchant_category_code TEXT NOT NULL,
    address JSONB NOT NULL,
    service_radius_km NUMERIC NOT NULL DEFAULT 0,
    currency TEXT NOT NULL,
    status TEXT NOT NULL,
    agent_access TEXT NOT NULL,
    allowed_account_holder_ids JSONB NOT NULL DEFAULT '[]',
    -- The whole KybRecord (registration number, contact details, review
    -- trail, uploaded document references) as one blob: nothing here is
    -- ever queried on directly, only read back whole and merged in the
    -- application, same as acard_cards.limits elsewhere in this schema.
    kyb JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS acard_merchants_status_idx ON acard_merchants(status);

  CREATE TABLE IF NOT EXISTS acard_catalog_items (
    id TEXT PRIMARY KEY,
    merchant_id TEXT NOT NULL REFERENCES acard_merchants(id),
    sku TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    unit TEXT NOT NULL,
    unit_price_cents BIGINT NOT NULL,
    currency TEXT NOT NULL,
    availability TEXT NOT NULL,
    quantity_available INT,
    lead_time_days INT NOT NULL DEFAULT 0,
    -- When stock was last *confirmed*, not last written — see merchants.ts.
    inventory_updated_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (merchant_id, sku)
  );
  CREATE INDEX IF NOT EXISTS acard_catalog_items_merchant_idx ON acard_catalog_items(merchant_id);

  CREATE TABLE IF NOT EXISTS acard_merchant_users (
    id TEXT PRIMARY KEY,
    merchant_id TEXT NOT NULL REFERENCES acard_merchants(id),
    workos_user_id TEXT NOT NULL,
    email TEXT NOT NULL,
    name TEXT NOT NULL,
    role TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (merchant_id, workos_user_id)
  );
  CREATE INDEX IF NOT EXISTS acard_merchant_users_workos_idx ON acard_merchant_users(workos_user_id);
  CREATE INDEX IF NOT EXISTS acard_merchant_users_merchant_idx ON acard_merchant_users(merchant_id);

  CREATE TABLE IF NOT EXISTS acard_merchant_sessions (
    hashed_token TEXT PRIMARY KEY,
    merchant_user_id TEXT NOT NULL,
    merchant_id TEXT NOT NULL,
    role TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL
  );

  CREATE TABLE IF NOT EXISTS acard_merchant_invites (
    id TEXT PRIMARY KEY,
    hashed_token TEXT UNIQUE NOT NULL,
    merchant_id TEXT NOT NULL,
    role TEXT NOT NULL,
    issued_by TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,
    consumed_by_user_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
`;

function rowToMerchant(row: any): Merchant {
  return {
    id: row.id,
    name: row.name,
    tradingName: row.trading_name ?? undefined,
    merchantCategoryCode: row.merchant_category_code,
    address: row.address,
    serviceRadiusKm: Number(row.service_radius_km),
    currency: row.currency,
    status: row.status,
    agentAccess: row.agent_access,
    allowedAccountHolderIds: row.allowed_account_holder_ids ?? [],
    kyb: row.kyb,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function rowToItem(row: any): CatalogItem {
  return {
    id: row.id,
    merchantId: row.merchant_id,
    sku: row.sku,
    name: row.name,
    description: row.description ?? undefined,
    unit: row.unit,
    unitPriceCents: Number(row.unit_price_cents),
    currency: row.currency,
    availability: row.availability,
    quantityAvailable: row.quantity_available === null ? undefined : row.quantity_available,
    leadTimeDays: row.lead_time_days,
    inventoryUpdatedAt: row.inventory_updated_at.toISOString(),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function rowToUser(row: any): MerchantUser {
  return {
    id: row.id,
    merchantId: row.merchant_id,
    workosUserId: row.workos_user_id,
    email: row.email,
    name: row.name,
    role: row.role,
    createdAt: row.created_at.toISOString(),
  };
}

function rowToInvite(row: any): MerchantInvite {
  return {
    id: row.id,
    merchantId: row.merchant_id,
    role: row.role,
    issuedBy: row.issued_by,
    expiresAt: row.expires_at.toISOString(),
    consumedAt: row.consumed_at?.toISOString(),
    consumedByUserId: row.consumed_by_user_id ?? undefined,
    createdAt: row.created_at.toISOString(),
  };
}

/** Runs `fn` inside a transaction on a dedicated client, rolling back on any error. */
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

export class PostgresMerchantDirectory implements MerchantDirectoryPort {
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

  async register(input: RegisterMerchantInput): Promise<Merchant> {
    const id = newId("mch");
    const now = new Date();
    const kyb = { ...input.kyb, submittedAt: now.toISOString(), documents: [] as KybDocument[] };
    const { rows } = await this.pool.query(
      `INSERT INTO acard_merchants
         (id, name, trading_name, merchant_category_code, address, service_radius_km, currency, status, agent_access, allowed_account_holder_ids, kyb, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'pending_kyb',$8,$9,$10,$11,$11)
       RETURNING *`,
      [
        id,
        input.name,
        input.tradingName ?? null,
        input.merchantCategoryCode,
        JSON.stringify(input.address),
        input.serviceRadiusKm ?? 0,
        input.currency ?? "ZAR",
        input.agentAccess ?? "open",
        JSON.stringify(input.allowedAccountHolderIds ?? []),
        JSON.stringify(kyb),
        now,
      ],
    );
    return rowToMerchant(rows[0]);
  }

  async get(id: string): Promise<Merchant> {
    const { rows } = await this.pool.query("SELECT * FROM acard_merchants WHERE id = $1", [id]);
    if (rows.length === 0) throw new NotFoundError("merchant", id);
    return rowToMerchant(rows[0]);
  }

  async list(filter: { status?: MerchantStatus } = {}): Promise<Merchant[]> {
    const { rows } = filter.status
      ? await this.pool.query("SELECT * FROM acard_merchants WHERE status = $1 ORDER BY created_at", [filter.status])
      : await this.pool.query("SELECT * FROM acard_merchants ORDER BY created_at");
    return rows.map(rowToMerchant);
  }

  async setStatus(id: string, status: MerchantStatus, reviewedBy: string, note?: string): Promise<Merchant> {
    if (!reviewedBy) throw new DomainError("reviewer_required", "a KYB decision must name its reviewer");
    return withTransaction(this.pool, async (client) => {
      const current = await client.query("SELECT kyb FROM acard_merchants WHERE id = $1 FOR UPDATE", [id]);
      if (current.rows.length === 0) throw new NotFoundError("merchant", id);
      const kyb = { ...current.rows[0].kyb, reviewedAt: new Date().toISOString(), reviewedBy, note };
      const { rows } = await client.query(
        "UPDATE acard_merchants SET status = $1, kyb = $2, updated_at = now() WHERE id = $3 RETURNING *",
        [status, JSON.stringify(kyb), id],
      );
      return rowToMerchant(rows[0]);
    });
  }

  async attachKybDocument(id: string, doc: Omit<KybDocument, "uploadedAt">): Promise<Merchant> {
    if (!doc.uploadedBy) throw new DomainError("uploader_required", "a KYB document must record who uploaded it");
    return withTransaction(this.pool, async (client) => {
      const current = await client.query("SELECT kyb FROM acard_merchants WHERE id = $1 FOR UPDATE", [id]);
      if (current.rows.length === 0) throw new NotFoundError("merchant", id);
      const kyb = {
        ...current.rows[0].kyb,
        documents: [...current.rows[0].kyb.documents, { ...doc, uploadedAt: new Date().toISOString() }],
      };
      const { rows } = await client.query("UPDATE acard_merchants SET kyb = $1, updated_at = now() WHERE id = $2 RETURNING *", [
        JSON.stringify(kyb),
        id,
      ]);
      return rowToMerchant(rows[0]);
    });
  }

  async updateProfile(
    id: string,
    patch: Partial<Pick<Merchant, "name" | "tradingName" | "address" | "serviceRadiusKm" | "agentAccess" | "allowedAccountHolderIds" | "merchantCategoryCode">>,
  ): Promise<Merchant> {
    return withTransaction(this.pool, async (client) => {
      const current = await client.query("SELECT * FROM acard_merchants WHERE id = $1 FOR UPDATE", [id]);
      if (current.rows.length === 0) throw new NotFoundError("merchant", id);
      const merged = { ...rowToMerchant(current.rows[0]), ...patch };
      const { rows } = await client.query(
        `UPDATE acard_merchants
           SET name = $1, trading_name = $2, merchant_category_code = $3, address = $4,
               service_radius_km = $5, agent_access = $6, allowed_account_holder_ids = $7, updated_at = now()
         WHERE id = $8
         RETURNING *`,
        [
          merged.name,
          merged.tradingName ?? null,
          merged.merchantCategoryCode,
          JSON.stringify(merged.address),
          merged.serviceRadiusKm,
          merged.agentAccess,
          JSON.stringify(merged.allowedAccountHolderIds),
          id,
        ],
      );
      return rowToMerchant(rows[0]);
    });
  }

  async upsertItem(merchantId: string, input: UpsertItemInput): Promise<CatalogItem> {
    if (!Number.isSafeInteger(input.unitPriceCents) || input.unitPriceCents < 0) {
      throw new DomainError("invalid_price", "unitPriceCents must be a non-negative integer of minor units");
    }
    return withTransaction(this.pool, async (client) => {
      const merchantRes = await client.query("SELECT currency FROM acard_merchants WHERE id = $1", [merchantId]);
      if (merchantRes.rows.length === 0) throw new NotFoundError("merchant", merchantId);

      const existingRes = await client.query(
        "SELECT * FROM acard_catalog_items WHERE merchant_id = $1 AND sku = $2 FOR UPDATE",
        [merchantId, input.sku],
      );
      const existing = existingRes.rows[0] ? rowToItem(existingRes.rows[0]) : undefined;
      const now = new Date();
      const availability = input.availability ?? existing?.availability ?? "in_stock";
      const quantityAvailable = input.quantityAvailable ?? existing?.quantityAvailable;
      // Only an actual stock statement refreshes the inventory clock — see
      // the identical rule (and its rationale) in the in-memory directory.
      const stockRestated = input.availability !== undefined || input.quantityAvailable !== undefined || existing === undefined;

      const id = existing?.id ?? newId("item");
      const unit = input.unit ?? existing?.unit ?? "each";
      const currency = input.currency ?? existing?.currency ?? merchantRes.rows[0].currency;
      const leadTimeDays = input.leadTimeDays ?? existing?.leadTimeDays ?? 0;
      const inventoryUpdatedAt = stockRestated ? now : new Date(existing?.inventoryUpdatedAt ?? now);

      const { rows } = await client.query(
        `INSERT INTO acard_catalog_items
           (id, merchant_id, sku, name, description, unit, unit_price_cents, currency, availability, quantity_available, lead_time_days, inventory_updated_at, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13)
         ON CONFLICT (merchant_id, sku) DO UPDATE SET
           name = EXCLUDED.name, description = EXCLUDED.description, unit = EXCLUDED.unit,
           unit_price_cents = EXCLUDED.unit_price_cents, currency = EXCLUDED.currency,
           availability = EXCLUDED.availability, quantity_available = EXCLUDED.quantity_available,
           lead_time_days = EXCLUDED.lead_time_days, inventory_updated_at = EXCLUDED.inventory_updated_at,
           updated_at = $13
         RETURNING *`,
        [
          id,
          merchantId,
          input.sku,
          input.name,
          input.description ?? existing?.description ?? null,
          unit,
          input.unitPriceCents,
          currency,
          availability,
          quantityAvailable ?? null,
          leadTimeDays,
          inventoryUpdatedAt,
          now,
        ],
      );
      return rowToItem(rows[0]);
    });
  }

  async restate(itemId: string, state: { availability: Availability; quantityAvailable?: number }): Promise<CatalogItem> {
    const { rows } = await this.pool.query(
      "UPDATE acard_catalog_items SET availability = $1, quantity_available = $2, inventory_updated_at = now(), updated_at = now() WHERE id = $3 RETURNING *",
      [state.availability, state.quantityAvailable ?? null, itemId],
    );
    if (rows.length === 0) throw new NotFoundError("catalog item", itemId);
    return rowToItem(rows[0]);
  }

  async getItem(id: string): Promise<CatalogItem> {
    const { rows } = await this.pool.query("SELECT * FROM acard_catalog_items WHERE id = $1", [id]);
    if (rows.length === 0) throw new NotFoundError("catalog item", id);
    return rowToItem(rows[0]);
  }

  async listItems(merchantId: string): Promise<CatalogItem[]> {
    const { rows } = await this.pool.query("SELECT * FROM acard_catalog_items WHERE merchant_id = $1 ORDER BY created_at", [
      merchantId,
    ]);
    return rows.map(rowToItem);
  }

  async removeItem(id: string): Promise<void> {
    const { rowCount } = await this.pool.query("DELETE FROM acard_catalog_items WHERE id = $1", [id]);
    if (rowCount === 0) throw new NotFoundError("catalog item", id);
  }

  async catalogHealth(merchantId: string) {
    const items = await this.listItems(merchantId);
    const now = Date.now();
    const ages = items.map((i) => Math.max(0, (now - Date.parse(i.inventoryUpdatedAt)) / 3_600_000)).sort((a, b) => a - b);
    const counts = { fresh: 0, aging: 0, stale: 0 };
    for (const age of ages) counts[classifyFreshness(age)] += 1;
    const median = ages.length === 0 ? 0 : (ages[Math.floor((ages.length - 1) / 2)] as number);
    return { items: items.length, ...counts, medianInventoryAgeHours: Math.round(median * 10) / 10 };
  }

  async search(query: OfferQuery): Promise<OfferSearchResult> {
    // Every merchant, any status — evaluateOffers needs the full set to
    // report *why* a pending or suspended merchant was excluded, not just
    // which ones matched.
    const { rows: merchantRows } = await this.pool.query("SELECT * FROM acard_merchants");
    const merchants = merchantRows.map(rowToMerchant);

    // The real SQL narrowing: evaluateOffers only ever reads a verified
    // merchant's items (every other status `continue`s before the item
    // loop), so fetching catalog rows for anyone else is pure waste. At
    // scale this is the difference between scanning every item this
    // platform has ever seen and scanning one city's worth of live stock.
    const verifiedIds = merchants.filter((m) => m.status === "verified").map((m) => m.id);
    const itemsByMerchant = new Map<string, CatalogItem[]>();
    if (verifiedIds.length > 0) {
      const { rows: itemRows } = await this.pool.query(
        "SELECT * FROM acard_catalog_items WHERE merchant_id = ANY($1) ORDER BY created_at",
        [verifiedIds],
      );
      for (const row of itemRows) {
        const item = rowToItem(row);
        const list = itemsByMerchant.get(item.merchantId);
        if (list) list.push(item);
        else itemsByMerchant.set(item.merchantId, [item]);
      }
    }

    return evaluateOffers(merchants, (merchantId) => itemsByMerchant.get(merchantId) ?? [], query, Date.now());
  }
}

export class PostgresMerchantAuth implements MerchantAuthPort {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, max: 5 });
  }

  async createInvite(merchantId: string, role: MerchantRole, issuedBy: string): Promise<{ invite: MerchantInvite; token: string }> {
    if (!issuedBy) throw new DomainError("issuer_required", "a portal invite must name who issued it");
    const token = newId("minv");
    const id = newId("minvrec");
    const expiresAt = new Date(Date.now() + MERCHANT_INVITE_TTL_MS);
    const { rows } = await this.pool.query(
      `INSERT INTO acard_merchant_invites (id, hashed_token, merchant_id, role, issued_by, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [id, hashSessionToken(token), merchantId, role, issuedBy, expiresAt],
    );
    return { invite: rowToInvite(rows[0]), token };
  }

  async peekInvite(token: string): Promise<MerchantInvite | undefined> {
    const { rows } = await this.pool.query("SELECT * FROM acard_merchant_invites WHERE hashed_token = $1", [hashSessionToken(token)]);
    return rows[0] ? rowToInvite(rows[0]) : undefined;
  }

  async redeemInvite(token: string, workosUser: { workosUserId: string; email: string; name: string }): Promise<MerchantUser> {
    return withTransaction(this.pool, async (client) => {
      const inviteRes = await client.query("SELECT * FROM acard_merchant_invites WHERE hashed_token = $1 FOR UPDATE", [
        hashSessionToken(token),
      ]);
      const row = inviteRes.rows[0];
      if (!row) throw new InvalidStateError("this invite link is invalid");
      if (row.consumed_at) throw new InvalidStateError("this invite link has already been used");
      if (row.expires_at.getTime() < Date.now()) throw new InvalidStateError("this invite link has expired");

      // Same identity, same merchant → the existing user, not a duplicate.
      // A different merchant gets its own distinct user row — see the
      // in-memory service's identical rule.
      const existingRes = await client.query(
        "SELECT * FROM acard_merchant_users WHERE merchant_id = $1 AND workos_user_id = $2",
        [row.merchant_id, workosUser.workosUserId],
      );
      let user: MerchantUser;
      if (existingRes.rows[0]) {
        user = rowToUser(existingRes.rows[0]);
      } else {
        const userRes = await client.query(
          `INSERT INTO acard_merchant_users (id, merchant_id, workos_user_id, email, name, role)
           VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
          [newId("mu"), row.merchant_id, workosUser.workosUserId, workosUser.email, workosUser.name || workosUser.email, row.role],
        );
        user = rowToUser(userRes.rows[0]);
      }

      await client.query("UPDATE acard_merchant_invites SET consumed_at = now(), consumed_by_user_id = $1 WHERE id = $2", [
        user.id,
        row.id,
      ]);
      return user;
    });
  }

  async listInvites(merchantId: string): Promise<MerchantInvite[]> {
    const { rows } = await this.pool.query("SELECT * FROM acard_merchant_invites WHERE merchant_id = $1 ORDER BY created_at", [
      merchantId,
    ]);
    return rows.map(rowToInvite);
  }

  async getUser(id: string): Promise<MerchantUser> {
    const { rows } = await this.pool.query("SELECT * FROM acard_merchant_users WHERE id = $1", [id]);
    if (rows.length === 0) throw new NotFoundError("merchant user", id);
    return rowToUser(rows[0]);
  }

  async listUsers(merchantId: string): Promise<MerchantUser[]> {
    const { rows } = await this.pool.query("SELECT * FROM acard_merchant_users WHERE merchant_id = $1 ORDER BY created_at", [
      merchantId,
    ]);
    return rows.map(rowToUser);
  }

  async createSession(user: MerchantUser): Promise<{ token: string; context: MerchantSessionContext }> {
    const token = newId("msess");
    const expiresAt = new Date(Date.now() + MERCHANT_SESSION_TTL_MS);
    await this.pool.query(
      `INSERT INTO acard_merchant_sessions (hashed_token, merchant_user_id, merchant_id, role, expires_at)
       VALUES ($1,$2,$3,$4,$5)`,
      [hashSessionToken(token), user.id, user.merchantId, user.role, expiresAt],
    );
    return { token, context: { merchantUserId: user.id, merchantId: user.merchantId, role: user.role } };
  }

  async resolveSession(token: string): Promise<MerchantSessionContext | undefined> {
    const hashed = hashSessionToken(token);
    const { rows } = await this.pool.query("SELECT * FROM acard_merchant_sessions WHERE hashed_token = $1", [hashed]);
    const row = rows[0];
    if (!row) return undefined;
    if (row.expires_at.getTime() < Date.now()) {
      await this.pool.query("DELETE FROM acard_merchant_sessions WHERE hashed_token = $1", [hashed]);
      return undefined;
    }
    return { merchantUserId: row.merchant_user_id, merchantId: row.merchant_id, role: row.role };
  }

  async revokeSession(token: string): Promise<void> {
    await this.pool.query("DELETE FROM acard_merchant_sessions WHERE hashed_token = $1", [hashSessionToken(token)]);
  }
}
