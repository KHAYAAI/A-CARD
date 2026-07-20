import { Platform, publicUser, type PlatformEvent, type Role } from "@acard/core";
import type {
  CreateCardParams,
  IdempotencyLookup,
  MemberView,
  PlatformService,
  RegisterResult,
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

  async getAccountHolder(id: string) {
    try {
      return this.platform.getAccountHolder(id);
    } catch {
      return undefined;
    }
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

  async registerAccount(input: { email: string; name: string; password: string; currency?: import("@acard/core").Currency }): Promise<RegisterResult> {
    const user = this.platform.auth.registerUser(input);
    const accountHolder = this.platform.signup({ email: input.email, name: input.name, currency: input.currency });
    const membership = this.platform.auth.addMembership(user.id, accountHolder.id, "owner");
    const { token, context } = this.platform.auth.openSession(user, membership);
    return { user: publicUser(user), accountHolder, sessionToken: token, context };
  }

  async login(input: { email: string; password: string; accountHolderId?: string }) {
    const { token, context } = this.platform.auth.login(input);
    return { sessionToken: token, context };
  }

  async resolveSession(token: string) {
    return this.platform.auth.resolveSession(token);
  }

  async logout(token: string) {
    this.platform.auth.revokeSession(token);
  }

  async addMember(input: { accountHolderId: string; email: string; name?: string; password?: string; role: Role }): Promise<MemberView> {
    let user = this.platform.auth.getUserByEmail(input.email);
    if (!user) {
      if (!input.password) throw new (await import("@acard/core")).DomainError("password_required", "a starting password is required to invite a new user");
      user = this.platform.auth.registerUser({ email: input.email, name: input.name ?? input.email, password: input.password });
    }
    const membership = this.platform.auth.addMembership(user.id, input.accountHolderId, input.role);
    return { user: publicUser(user), role: membership.role, createdAt: membership.createdAt };
  }

  async listMembers(accountHolderId: string): Promise<MemberView[]> {
    return this.platform.auth.membersOf(accountHolderId).map((m) => ({
      user: publicUser(this.platform.auth.getUser(m.userId)),
      role: m.role,
      createdAt: m.createdAt,
    }));
  }

  onEvent(listener: (event: PlatformEvent) => void) {
    this.platform.onEvent(listener);
  }

  async close() {
    // Nothing to close for the in-memory path.
  }
}
