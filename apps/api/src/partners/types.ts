/**
 * Platform partners (the supplier model): a platform holds one contract with
 * A-CARD and creates and manages its own users ("customers") under it. Each
 * customer is a full A-CARD account; the platform acts for it with its own API
 * key plus the `A-Card-Customer` header, so every existing route (agents,
 * cards, limits, approvals) works for customers unchanged.
 */
export interface Brand {
  displayName: string;
  logoUrl?: string;
  primaryColor?: string;
  supportEmail?: string;
  supportUrl?: string;
}

/** Commercial terms. Set by the A-CARD operator, never by the partner. */
export interface PartnerTerms {
  /** Fee on captured card volume, in basis points (100 = 1%). */
  volumeBps: number;
  /** Per card with spend in the month, minor units of `currency`. */
  perActiveCard: number;
  /** Minimum monthly charge, minor units of `currency`; usage fees count towards it. */
  monthlyMinimum: number;
  currency: string;
}

export const DEFAULT_TERMS: PartnerTerms = { volumeBps: 100, perActiveCard: 50, monthlyMinimum: 30_000, currency: "USD" };

export interface Partner {
  id: string;
  /** The platform's own A-CARD account. */
  accountHolderId: string;
  name: string;
  brand: Brand;
  terms: PartnerTerms;
  /** The distribution partner who introduced this platform, if any. */
  distributorId?: string;
  createdAt: string;
}

export interface PartnerCustomer {
  partnerId: string;
  accountHolderId: string;
  externalRef?: string;
  createdAt: string;
}

/** An aggregator / referrer paid a share of the revenue from partners it brought. */
export interface Distributor {
  id: string;
  name: string;
  /** Share of A-CARD's fees from its partners, in basis points (2000 = 20%). */
  shareBps: number;
  createdAt: string;
}

export interface PartnerStore {
  insertPartner(p: Partner): Promise<void>;
  updatePartner(p: Partner): Promise<void>;
  getPartner(id: string): Promise<Partner | undefined>;
  getPartnerByHolder(accountHolderId: string): Promise<Partner | undefined>;
  listPartners(): Promise<Partner[]>;
  insertCustomer(c: PartnerCustomer): Promise<void>;
  getCustomer(partnerId: string, accountHolderId: string): Promise<PartnerCustomer | undefined>;
  /** Which partner (if any) a customer account belongs to. */
  getCustomerByHolder(accountHolderId: string): Promise<PartnerCustomer | undefined>;
  getCustomerByRef(partnerId: string, externalRef: string): Promise<PartnerCustomer | undefined>;
  listCustomers(partnerId: string): Promise<PartnerCustomer[]>;
  insertDistributor(d: Distributor): Promise<void>;
  getDistributor(id: string): Promise<Distributor | undefined>;
  listDistributors(): Promise<Distributor[]>;
}

export class MemoryPartnerStore implements PartnerStore {
  private partners = new Map<string, Partner>();
  private customers: PartnerCustomer[] = [];
  private distributors = new Map<string, Distributor>();
  async insertPartner(p: Partner) {
    if ([...this.partners.values()].some((x) => x.accountHolderId === p.accountHolderId)) throw new Error("partner exists");
    this.partners.set(p.id, structuredClone(p));
  }
  async updatePartner(p: Partner) { this.partners.set(p.id, structuredClone(p)); }
  async getPartner(id: string) { const p = this.partners.get(id); return p && structuredClone(p); }
  async getPartnerByHolder(h: string) { const p = [...this.partners.values()].find((x) => x.accountHolderId === h); return p && structuredClone(p); }
  async listPartners() { return [...this.partners.values()].map((p) => structuredClone(p)); }
  async insertCustomer(c: PartnerCustomer) {
    if (this.customers.some((x) => x.accountHolderId === c.accountHolderId)) throw new Error("customer already linked");
    if (c.externalRef && this.customers.some((x) => x.partnerId === c.partnerId && x.externalRef === c.externalRef)) throw new Error("external_ref in use");
    this.customers.push({ ...c });
  }
  async getCustomer(p: string, h: string) { return this.customers.find((x) => x.partnerId === p && x.accountHolderId === h); }
  async getCustomerByHolder(h: string) { return this.customers.find((x) => x.accountHolderId === h); }
  async getCustomerByRef(p: string, r: string) { return this.customers.find((x) => x.partnerId === p && x.externalRef === r); }
  async listCustomers(p: string) { return this.customers.filter((x) => x.partnerId === p); }
  async insertDistributor(d: Distributor) { this.distributors.set(d.id, { ...d }); }
  async getDistributor(id: string) { return this.distributors.get(id); }
  async listDistributors() { return [...this.distributors.values()]; }
}
