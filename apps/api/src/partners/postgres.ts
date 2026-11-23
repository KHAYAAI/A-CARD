import pg from "pg";
import type { Distributor, Partner, PartnerCustomer, PartnerStore } from "./types.js";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS acard_partners (
    id TEXT PRIMARY KEY,
    account_holder_id TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    brand JSONB NOT NULL,
    terms JSONB NOT NULL,
    distributor_id TEXT,
    created_at TIMESTAMPTZ NOT NULL
  );
  CREATE TABLE IF NOT EXISTS acard_partner_customers (
    account_holder_id TEXT PRIMARY KEY,
    partner_id TEXT NOT NULL,
    external_ref TEXT,
    created_at TIMESTAMPTZ NOT NULL
  );
  CREATE INDEX IF NOT EXISTS acard_partner_customers_partner_idx ON acard_partner_customers(partner_id);
  CREATE UNIQUE INDEX IF NOT EXISTS acard_partner_customers_ref_idx ON acard_partner_customers(partner_id, external_ref) WHERE external_ref IS NOT NULL;
  CREATE TABLE IF NOT EXISTS acard_distributors (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    share_bps INT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL
  );
`;
const iso = (d: Date | string) => new Date(d).toISOString();
const partner = (r: any): Partner => ({ id: r.id, accountHolderId: r.account_holder_id, name: r.name, brand: r.brand, terms: r.terms, distributorId: r.distributor_id ?? undefined, createdAt: iso(r.created_at) });
const customer = (r: any): PartnerCustomer => ({ partnerId: r.partner_id, accountHolderId: r.account_holder_id, externalRef: r.external_ref ?? undefined, createdAt: iso(r.created_at) });
const distributor = (r: any): Distributor => ({ id: r.id, name: r.name, shareBps: r.share_bps, createdAt: iso(r.created_at) });

export class PostgresPartnerStore implements PartnerStore {
  readonly pool: pg.Pool;
  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, max: 3 });
  }
  async migrate() { await this.pool.query(SCHEMA); }
  async close() { await this.pool.end(); }
  async insertPartner(p: Partner) {
    await this.pool.query("INSERT INTO acard_partners VALUES ($1,$2,$3,$4,$5,$6,$7)", [p.id, p.accountHolderId, p.name, p.brand, p.terms, p.distributorId ?? null, p.createdAt]);
  }
  async updatePartner(p: Partner) {
    await this.pool.query("UPDATE acard_partners SET name=$2, brand=$3, terms=$4, distributor_id=$5 WHERE id=$1", [p.id, p.name, p.brand, p.terms, p.distributorId ?? null]);
  }
  async getPartner(id: string) { const r = await this.pool.query("SELECT * FROM acard_partners WHERE id=$1", [id]); return r.rows[0] && partner(r.rows[0]); }
  async getPartnerByHolder(h: string) { const r = await this.pool.query("SELECT * FROM acard_partners WHERE account_holder_id=$1", [h]); return r.rows[0] && partner(r.rows[0]); }
  async listPartners() { return (await this.pool.query("SELECT * FROM acard_partners ORDER BY created_at")).rows.map(partner); }
  async insertCustomer(c: PartnerCustomer) {
    await this.pool.query("INSERT INTO acard_partner_customers VALUES ($1,$2,$3,$4)", [c.accountHolderId, c.partnerId, c.externalRef ?? null, c.createdAt]);
  }
  async getCustomer(p: string, h: string) { const r = await this.pool.query("SELECT * FROM acard_partner_customers WHERE partner_id=$1 AND account_holder_id=$2", [p, h]); return r.rows[0] && customer(r.rows[0]); }
  async getCustomerByHolder(h: string) { const r = await this.pool.query("SELECT * FROM acard_partner_customers WHERE account_holder_id=$1", [h]); return r.rows[0] && customer(r.rows[0]); }
  async getCustomerByRef(p: string, ref: string) { const r = await this.pool.query("SELECT * FROM acard_partner_customers WHERE partner_id=$1 AND external_ref=$2", [p, ref]); return r.rows[0] && customer(r.rows[0]); }
  async listCustomers(p: string) { return (await this.pool.query("SELECT * FROM acard_partner_customers WHERE partner_id=$1 ORDER BY created_at", [p])).rows.map(customer); }
  async insertDistributor(d: Distributor) { await this.pool.query("INSERT INTO acard_distributors VALUES ($1,$2,$3,$4)", [d.id, d.name, d.shareBps, d.createdAt]); }
  async getDistributor(id: string) { const r = await this.pool.query("SELECT * FROM acard_distributors WHERE id=$1", [id]); return r.rows[0] && distributor(r.rows[0]); }
  async listDistributors() { return (await this.pool.query("SELECT * FROM acard_distributors ORDER BY created_at")).rows.map(distributor); }
}
