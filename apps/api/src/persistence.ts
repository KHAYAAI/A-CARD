import pg from "pg";
import { Platform, type PlatformSnapshot } from "@acard/core";

/**
 * Durability for the sandbox's in-memory Platform. This is a single-writer
 * snapshot model — the whole platform state is serialized to one JSONB row
 * after every mutating request and reloaded on boot. It solves the actual
 * problem an AWS deploy introduces (a restarted/redeployed ECS task loses
 * all in-memory state), without rewriting the ledger's balance arithmetic
 * into SQL aggregates.
 *
 * This is intentionally not a multi-writer ledger: it assumes one API
 * process owns the data at a time, which is correct for a single Fargate
 * task/desired-count=1 deployment. Scaling to multiple concurrent API
 * instances needs a real Postgres-backed ledger (row-level accounts/
 * transactions/postings tables with SQL-level balance aggregation and
 * row locking on hold placement) — tracked as the next step in the README,
 * not attempted here.
 */

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS acard_snapshots (
    id TEXT PRIMARY KEY,
    data JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
`;

const SNAPSHOT_ID = "singleton";

export class PostgresPersistence {
  private readonly pool: pg.Pool;
  private saveInFlight: Promise<void> | null = null;
  private savePending = false;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, max: 5 });
  }

  async migrate(): Promise<void> {
    await this.pool.query(SCHEMA);
  }

  async load(): Promise<Platform> {
    const result = await this.pool.query<{ data: PlatformSnapshot }>(
      "SELECT data FROM acard_snapshots WHERE id = $1",
      [SNAPSHOT_ID],
    );
    const row = result.rows[0];
    if (!row) return new Platform();
    return Platform.hydrate(row.data);
  }

  /** Fire-and-forget save, coalescing bursts of requests into one write. */
  save(platform: Platform): void {
    if (this.saveInFlight) {
      this.savePending = true;
      return;
    }
    this.saveInFlight = this.writeSnapshot(platform)
      .catch((error) => {
        console.error("acard: snapshot save failed", error);
      })
      .then(async () => {
        this.saveInFlight = null;
        if (this.savePending) {
          this.savePending = false;
          this.save(platform);
        }
      });
  }

  /** Await the current + any queued save — used by tests and graceful shutdown. */
  async flush(): Promise<void> {
    while (this.saveInFlight) await this.saveInFlight;
  }

  private async writeSnapshot(platform: Platform): Promise<void> {
    const data = platform.serialize();
    await this.pool.query(
      `INSERT INTO acard_snapshots (id, data, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
      [SNAPSHOT_ID, JSON.stringify(data)],
    );
  }

  async close(): Promise<void> {
    await this.flush();
    await this.pool.end();
  }
}
