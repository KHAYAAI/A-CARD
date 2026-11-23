import type { AttachedCard, AttachedCardSettings, AttachedPurchase } from "./service.js";

/** Storage for attached cards and their purchases. Memory for tests and single-instance dev; Postgres in production. */
export interface AttachedCardStore {
  insertCard(card: AttachedCard): Promise<void>;
  getCard(id: string): Promise<AttachedCard | undefined>;
  listCards(accountHolderId: string): Promise<AttachedCard[]>;
  deleteCard(id: string): Promise<void>;
  getSettings(accountHolderId: string): Promise<AttachedCardSettings | undefined>;
  putSettings(accountHolderId: string, s: AttachedCardSettings): Promise<void>;
  insertPurchase(p: AttachedPurchase): Promise<void>;
  getPurchase(id: string): Promise<AttachedPurchase | undefined>;
  listPurchases(accountHolderId: string): Promise<AttachedPurchase[]>;
  /**
   * Atomically move a purchase from awaiting_approval to `to`. Returns false if
   * it was no longer awaiting (another request or another API instance won), so
   * a purchase can never be released twice.
   */
  claim(id: string, to: "releasing" | "denied", by: string, at: string): Promise<boolean>;
  updatePurchase(p: AttachedPurchase): Promise<void>;
}

export interface StoredPasskey {
  id: string;
  userId: string;
  publicKey: Uint8Array<ArrayBuffer>;
  counter: number;
  transports?: string[];
  createdAt: string;
}

export interface PendingChallenge {
  challenge: string;
  userId: string;
  expires: number;
}

/** Storage for passkeys and their one-time challenges. */
export interface PasskeyStore {
  listCredentials(userId: string): Promise<StoredPasskey[]>;
  addCredential(c: StoredPasskey): Promise<void>;
  /** Only ever moves the counter forward. */
  updateCounter(credentialId: string, counter: number): Promise<void>;
  putChallenge(key: string, c: PendingChallenge): Promise<void>;
  /** Returns and deletes in one step, so a challenge can be used only once even across API instances. */
  takeChallenge(key: string): Promise<PendingChallenge | undefined>;
}

const clone = <T>(v: T): T => structuredClone(v);

export class MemoryAttachedCardStore implements AttachedCardStore {
  private cards = new Map<string, AttachedCard>();
  private settings = new Map<string, AttachedCardSettings>();
  private purchases = new Map<string, AttachedPurchase>();
  async insertCard(card: AttachedCard) { this.cards.set(card.id, clone(card)); }
  async getCard(id: string) { const c = this.cards.get(id); return c && clone(c); }
  async listCards(h: string) { return [...this.cards.values()].filter((c) => c.accountHolderId === h).map(clone); }
  async deleteCard(id: string) { this.cards.delete(id); }
  async getSettings(h: string) { const s = this.settings.get(h); return s && clone(s); }
  async putSettings(h: string, s: AttachedCardSettings) { this.settings.set(h, clone(s)); }
  async insertPurchase(p: AttachedPurchase) { this.purchases.set(p.id, clone(p)); }
  async getPurchase(id: string) { const p = this.purchases.get(id); return p && clone(p); }
  async listPurchases(h: string) { return [...this.purchases.values()].filter((p) => p.accountHolderId === h).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(clone); }
  async claim(id: string, to: "releasing" | "denied", by: string, at: string) {
    const p = this.purchases.get(id);
    if (!p || p.status !== "awaiting_approval") return false;
    p.status = to; p.approvedBy = by; p.decidedAt = at;
    return true;
  }
  async updatePurchase(p: AttachedPurchase) { this.purchases.set(p.id, clone(p)); }
}

export class MemoryPasskeyStore implements PasskeyStore {
  private creds: StoredPasskey[] = [];
  private challenges = new Map<string, PendingChallenge>();
  async listCredentials(userId: string) { return this.creds.filter((c) => c.userId === userId).map((c) => ({ ...c })); }
  async addCredential(c: StoredPasskey) { this.creds.push({ ...c }); }
  async updateCounter(id: string, counter: number) { const c = this.creds.find((x) => x.id === id); if (c && counter > c.counter) c.counter = counter; }
  async putChallenge(key: string, c: PendingChallenge) { this.challenges.set(key, { ...c }); }
  async takeChallenge(key: string) { const c = this.challenges.get(key); this.challenges.delete(key); return c; }
}
