import pg from "pg";
import {
  ComplianceService,
  InvalidStateError,
  NotFoundError,
  type ComplianceOverride,
  type VerificationRecord,
  type VerificationStatus,
  type VerificationSubject,
} from "@acard/core";

/**
 * Where A-CARD's own compliance records live — the same async-port shape as
 * `PlatformService`, `MerchantDirectoryPort` and `AfpLedgerPort`, with an
 * in-memory wrapper and a real multi-writer Postgres adapter behind it.
 */
export interface ComplianceStorePort {
  open(subject: VerificationSubject, subjectId: string): Promise<VerificationRecord>;
  attachSession(
    id: string,
    session: { providerSessionId: string; providerWorkflowId: string; verificationUrl?: string },
  ): Promise<VerificationRecord>;
  recordProviderDecision(
    id: string,
    decision: { status: VerificationStatus; amlRisk?: VerificationRecord["amlRisk"]; reasons?: string[] },
  ): Promise<VerificationRecord>;
  override(id: string, override: Omit<ComplianceOverride, "decidedAt">): Promise<VerificationRecord>;
  get(id: string): Promise<VerificationRecord>;
  find(subject: VerificationSubject, subjectId: string): Promise<VerificationRecord | undefined>;
  findByProviderSession(providerSessionId: string): Promise<VerificationRecord | undefined>;
  list(filter?: { subject?: VerificationSubject; status?: VerificationStatus }): Promise<VerificationRecord[]>;
  pendingReview(): Promise<VerificationRecord[]>;
}

export class InMemoryComplianceStore implements ComplianceStorePort {
  constructor(private readonly service: ComplianceService) {}

  async open(...args: Parameters<ComplianceService["open"]>) {
    return this.service.open(...args);
  }
  async attachSession(...args: Parameters<ComplianceService["attachSession"]>) {
    return this.service.attachSession(...args);
  }
  async recordProviderDecision(...args: Parameters<ComplianceService["recordProviderDecision"]>) {
    return this.service.recordProviderDecision(...args);
  }
  async override(...args: Parameters<ComplianceService["override"]>) {
    return this.service.override(...args);
  }
  async get(...args: Parameters<ComplianceService["get"]>) {
    return this.service.get(...args);
  }
  async find(...args: Parameters<ComplianceService["find"]>) {
    return this.service.find(...args);
  }
  async findByProviderSession(...args: Parameters<ComplianceService["findByProviderSession"]>) {
    return this.service.findByProviderSession(...args);
  }
  async list(...args: Parameters<ComplianceService["list"]>) {
    return this.service.list(...args);
  }
  async pendingReview() {
    return this.service.pendingReview();
  }
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS acard_verifications (
    id TEXT PRIMARY KEY,
    subject TEXT NOT NULL,
    subject_id TEXT NOT NULL,
    provider_session_id TEXT,
    provider_workflow_id TEXT,
    verification_url TEXT,
    provider_decision TEXT NOT NULL,
    aml_risk TEXT NOT NULL,
    provider_reasons JSONB NOT NULL DEFAULT '[]',
    override_data JSONB,
    history JSONB NOT NULL DEFAULT '[]',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  -- One live record per subject: the uniqueness is what makes open() safe
  -- under two concurrent requests, rather than application-level checking.
  CREATE UNIQUE INDEX IF NOT EXISTS acard_verifications_subject_idx
    ON acard_verifications(subject, subject_id);
  CREATE UNIQUE INDEX IF NOT EXISTS acard_verifications_session_idx
    ON acard_verifications(provider_session_id) WHERE provider_session_id IS NOT NULL;
`;

function rowToRecord(row: any): VerificationRecord {
  return {
    id: row.id,
    subject: row.subject,
    subjectId: row.subject_id,
    providerSessionId: row.provider_session_id ?? undefined,
    providerWorkflowId: row.provider_workflow_id ?? undefined,
    verificationUrl: row.verification_url ?? undefined,
    providerDecision: row.provider_decision,
    amlRisk: row.aml_risk,
    providerReasons: row.provider_reasons ?? [],
    override: row.override_data ?? undefined,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    history: row.history ?? [],
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
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export class PostgresComplianceStore implements ComplianceStorePort {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString });
  }

  async migrate(): Promise<void> {
    await this.pool.query(SCHEMA);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async open(subject: VerificationSubject, subjectId: string): Promise<VerificationRecord> {
    const now = new Date();
    const id = `ver_${subject.slice(0, 3)}_${Buffer.from(subjectId).toString("hex").slice(0, 16)}_${now.getTime().toString(36)}`;
    const history = JSON.stringify([{ status: "not_started", at: now.toISOString(), source: "provider" }]);
    // The unique index is what makes this safe under concurrency, not a
    // read-then-write check — two simultaneous signups for the same subject
    // must not produce two verification records (and, live, two bills).
    const inserted = await this.pool.query(
      `INSERT INTO acard_verifications
         (id, subject, subject_id, provider_decision, aml_risk, provider_reasons, history, created_at, updated_at)
       VALUES ($1,$2,$3,'not_started','not_screened','[]',$4,$5,$5)
       ON CONFLICT (subject, subject_id) DO NOTHING
       RETURNING *`,
      [id, subject, subjectId, history, now],
    );
    if (inserted.rows[0]) return rowToRecord(inserted.rows[0]);
    const existing = await this.pool.query(
      "SELECT * FROM acard_verifications WHERE subject = $1 AND subject_id = $2",
      [subject, subjectId],
    );
    return rowToRecord(existing.rows[0]);
  }

  async attachSession(
    id: string,
    session: { providerSessionId: string; providerWorkflowId: string; verificationUrl?: string },
  ): Promise<VerificationRecord> {
    return withTransaction(this.pool, async (client) => {
      const current = await client.query("SELECT * FROM acard_verifications WHERE id = $1 FOR UPDATE", [id]);
      if (!current.rows[0]) throw new NotFoundError("verification record", id);
      const record = rowToRecord(current.rows[0]);
      if (record.providerSessionId && record.providerSessionId !== session.providerSessionId) {
        throw new InvalidStateError(`verification ${id} is already bound to provider session ${record.providerSessionId}`);
      }
      const now = new Date();
      const history =
        record.providerDecision === "not_started"
          ? [...record.history, { status: "pending", at: now.toISOString(), source: "provider" }]
          : record.history;
      const decision = record.providerDecision === "not_started" ? "pending" : record.providerDecision;
      const { rows } = await client.query(
        `UPDATE acard_verifications
            SET provider_session_id = $2, provider_workflow_id = $3, verification_url = $4,
                provider_decision = $5, history = $6, updated_at = $7
          WHERE id = $1 RETURNING *`,
        [id, session.providerSessionId, session.providerWorkflowId, session.verificationUrl ?? null, decision, JSON.stringify(history), now],
      );
      return rowToRecord(rows[0]);
    });
  }

  async recordProviderDecision(
    id: string,
    decision: { status: VerificationStatus; amlRisk?: VerificationRecord["amlRisk"]; reasons?: string[] },
  ): Promise<VerificationRecord> {
    return withTransaction(this.pool, async (client) => {
      const current = await client.query("SELECT * FROM acard_verifications WHERE id = $1 FOR UPDATE", [id]);
      if (!current.rows[0]) throw new NotFoundError("verification record", id);
      const record = rowToRecord(current.rows[0]);
      const amlRisk = decision.amlRisk ?? record.amlRisk;
      // Webhook delivery is at-least-once; a replayed decision must not append
      // a second history entry, or the audit trail is corrupted.
      if (record.providerDecision === decision.status && record.amlRisk === amlRisk) return record;

      const now = new Date();
      const history = [...record.history, { status: decision.status, at: now.toISOString(), source: "provider" }];
      const { rows } = await client.query(
        `UPDATE acard_verifications
            SET provider_decision = $2, aml_risk = $3, provider_reasons = $4, history = $5, updated_at = $6
          WHERE id = $1 RETURNING *`,
        [id, decision.status, amlRisk, JSON.stringify(decision.reasons ?? record.providerReasons), JSON.stringify(history), now],
      );
      return rowToRecord(rows[0]);
    });
  }

  async override(id: string, override: Omit<ComplianceOverride, "decidedAt">): Promise<VerificationRecord> {
    return withTransaction(this.pool, async (client) => {
      const current = await client.query("SELECT * FROM acard_verifications WHERE id = $1 FOR UPDATE", [id]);
      if (!current.rows[0]) throw new NotFoundError("verification record", id);
      const record = rowToRecord(current.rows[0]);
      const now = new Date();
      const stored: ComplianceOverride = { ...override, decidedAt: now.toISOString() };
      const history = [...record.history, { status: override.status, at: now.toISOString(), source: "operator", note: override.reason }];
      const { rows } = await client.query(
        "UPDATE acard_verifications SET override_data = $2, history = $3, updated_at = $4 WHERE id = $1 RETURNING *",
        [id, JSON.stringify(stored), JSON.stringify(history), now],
      );
      return rowToRecord(rows[0]);
    });
  }

  async get(id: string): Promise<VerificationRecord> {
    const { rows } = await this.pool.query("SELECT * FROM acard_verifications WHERE id = $1", [id]);
    if (!rows[0]) throw new NotFoundError("verification record", id);
    return rowToRecord(rows[0]);
  }

  async find(subject: VerificationSubject, subjectId: string): Promise<VerificationRecord | undefined> {
    const { rows } = await this.pool.query(
      "SELECT * FROM acard_verifications WHERE subject = $1 AND subject_id = $2",
      [subject, subjectId],
    );
    return rows[0] ? rowToRecord(rows[0]) : undefined;
  }

  async findByProviderSession(providerSessionId: string): Promise<VerificationRecord | undefined> {
    const { rows } = await this.pool.query("SELECT * FROM acard_verifications WHERE provider_session_id = $1", [
      providerSessionId,
    ]);
    return rows[0] ? rowToRecord(rows[0]) : undefined;
  }

  async list(filter: { subject?: VerificationSubject; status?: VerificationStatus } = {}): Promise<VerificationRecord[]> {
    const { rows } = filter.subject
      ? await this.pool.query("SELECT * FROM acard_verifications WHERE subject = $1 ORDER BY created_at DESC", [filter.subject])
      : await this.pool.query("SELECT * FROM acard_verifications ORDER BY created_at DESC");
    const records = rows.map(rowToRecord);
    // Effective status folds in the operator override, which lives in JSONB —
    // filtered in JS against the same core helper rather than reimplemented
    // as SQL, for the same reason A-MERCHANT's ranking is not reimplemented.
    if (!filter.status) return records;
    return records.filter((r) => (r.override?.status ?? r.providerDecision) === filter.status);
  }

  async pendingReview(): Promise<VerificationRecord[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM acard_verifications
        WHERE override_data IS NULL
          AND (provider_decision = 'in_review' OR aml_risk IN ('possible_match','hit'))
        ORDER BY updated_at ASC`,
    );
    return rows.map(rowToRecord);
  }
}
