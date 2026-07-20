import { Platform, type PlatformEvent } from "@acard/core";
import type {
  CreateCardParams,
  IdempotencyLookup,
  PlatformService,
  WalletBalance,
} from "./types.js";

/**
 * Async adapter over the synchronous in-memory `Platform`. Every method just
 * awaits an immediate value — the point is to let the REST API depend only on
 * the async `PlatformService` port, so the in-memory sandbox and the
 * Postgres-backed multi-writer deployment are drop-in interchangeable.
 *
 * Durability, when wanted for this path, is the existing single-writer
 * snapshot model (`PostgresPersistence`) driven off `.platform`.
 */
export class InMemoryPlatformService implements PlatformService {
  constructor(readonly platform: Platform = new Platform()) {}

  async signup(input: { email: string; name: string; currency?: import("@acard/core").Currency }) {
    return this.platform.signup(input);
  }

  async issueApiKey(accountHolderId: string, name: string) {
    const issued = this.platform.apiKeys.issue(accountHolderId, name);
    return { secret: issued.secret, id: issued.key.id };
  }

  async authenticateApiKey(secret: string) {
    const key = this.platform.apiKeys.authenticate(secret);
    if (!key) return undefined;
    return this.platform.getAccountHolder(key.accountHolderId);
  }

  async setSubscriptionTier(accountHolderId: string, tier: import("@acard/core").SubscriptionTier) {
    return this.platform.setSubscriptionTier(accountHolderId, tier);
  }

  async walletBalance(accountHolderId: string): Promise<WalletBalance> {
    return this.platform.walletBalance(accountHolderId);
  }

  async fundWallet(accountHolderId: string, amount: number, reference?: string) {
    const ledgerTransaction = this.platform.fundWallet(accountHolderId, amount, reference);
    return { ledgerTransaction, wallet: this.platform.walletBalance(accountHolderId) };
  }

  async createCard(input: CreateCardParams) {
    return this.platform.createCard(input);
  }

  async listCards(accountHolderId: string) {
    return this.platform.listCards(accountHolderId);
  }

  async getCard(id: string) {
    try {
      return this.platform.getCard(id);
    } catch {
      return undefined;
    }
  }

  async closeCard(id: string, reason?: string) {
    return this.platform.closeCard(id, reason);
  }

  async listTransactions(filter: { accountHolderId?: string; cardId?: string }) {
    return this.platform.listTransactions(filter);
  }

  async listApprovals(filter: { accountHolderId?: string; status?: import("@acard/core").ApprovalStatus }) {
    return this.platform.approvals.list(filter);
  }

  async getApproval(id: string) {
    try {
      return this.platform.approvals.get(id);
    } catch {
      return undefined;
    }
  }

  async decideApproval(id: string, decision: "approved" | "denied", decidedBy: string) {
    return this.platform.decideApproval(id, decision, decidedBy);
  }

  async authorize(request: import("@acard/core").AuthorizationRequest) {
    return this.platform.authorize(request);
  }

  async capture(authorizationId: string, finalAmount?: number) {
    return this.platform.capture(authorizationId, finalAmount);
  }

  async reverse(authorizationId: string) {
    return this.platform.reverse(authorizationId);
  }

  async idempotencyGet(key: string, requestHash: string): Promise<IdempotencyLookup> {
    const lookup = this.platform.idempotency.get(key, requestHash);
    if (lookup.hit) return { hit: true, status: lookup.response.status, body: lookup.response.body };
    return { hit: false, conflict: lookup.conflict };
  }

  async idempotencyPut(key: string, requestHash: string, status: number, body: unknown) {
    this.platform.idempotency.put(key, requestHash, status, body);
  }

  async markEvent(eventId: string) {
    return this.platform.idempotency.markEvent(eventId);
  }

  onEvent(listener: (event: PlatformEvent) => void) {
    this.platform.onEvent(listener);
  }

  async close() {
    // Nothing to close for the in-memory path.
  }
}
