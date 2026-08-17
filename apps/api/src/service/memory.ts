import { Platform, publicUser, type ApiKeyScope, type OrgPolicy, type PlatformEvent, type Role, type WorkspaceType } from "@acard/core";
import type {
  ApiKeyPrincipal,
  CreateCardParams,
  IdempotencyLookup,
  LoginOutcome,
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

  async signup(input: { email: string; name: string; currency?: import("@acard/core").Currency; accountType?: WorkspaceType }) {
    return this.platform.signup(input);
  }

  async getAccountHolder(id: string) {
    try {
      return this.platform.getAccountHolder(id);
    } catch {
      return undefined;
    }
  }

  async issueApiKey(accountHolderId: string, name: string, options: { scope?: ApiKeyScope; spendCapCents?: number } = {}) {
    const issued = this.platform.apiKeys.issue(accountHolderId, name, options);
    return {
      secret: issued.secret,
      id: issued.key.id,
      scope: issued.key.scope,
      spendCapCents: issued.key.spendCapCents,
    };
  }

  async authenticateApiKey(secret: string): Promise<ApiKeyPrincipal | undefined> {
    const key = this.platform.apiKeys.authenticate(secret);
    if (!key) return undefined;
    const holder = this.platform.getAccountHolder(key.accountHolderId);
    return holder ? { holder, key } : undefined;
  }

  async listApiKeys(accountHolderId: string) {
    return this.platform.apiKeys.list(accountHolderId).map(({ hashedSecret: _secret, ...rest }) => rest);
  }

  async revokeApiKey(accountHolderId: string, id: string) {
    const key = this.platform.apiKeys.list(accountHolderId).find((k) => k.id === id);
    if (!key) throw new (await import("@acard/core")).NotFoundError("api key", id);
    this.platform.apiKeys.revoke(id);
  }

  async setSubscriptionTier(accountHolderId: string, tier: import("@acard/core").SubscriptionTier) {
    return this.platform.setSubscriptionTier(accountHolderId, tier);
  }

  async walletBalance(accountHolderId: string, currency?: import("@acard/core").Currency): Promise<WalletBalance> {
    return this.platform.walletBalance(accountHolderId, currency);
  }

  async walletBalances(accountHolderId: string): Promise<WalletBalance[]> {
    return this.platform.walletBalances(accountHolderId);
  }

  async fundWallet(accountHolderId: string, amount: number, currency?: import("@acard/core").Currency, reference?: string) {
    const ledgerTransaction = this.platform.fundWallet(accountHolderId, amount, currency, reference);
    const ccy = currency ?? this.platform.getAccountHolder(accountHolderId).currency;
    return { ledgerTransaction, wallet: this.platform.walletBalance(accountHolderId, ccy) };
  }

  async createCard(input: CreateCardParams) {
    const { apiKeyId, ...cardInput } = input;
    // Check the cap before creating, then draw it down only once the card
    // exists — so a card refused for an unrelated reason (plan limit, bad
    // department) does not silently eat the key's allowance. Safe to do in two
    // steps here because this path is synchronous and single-writer; the
    // Postgres store instead relies on its transaction to roll both back.
    if (apiKeyId) this.platform.apiKeys.assertSpendAllowance(apiKeyId, cardInput.limits?.total);
    const card = this.platform.createCard(cardInput);
    if (apiKeyId) this.platform.apiKeys.recordSpend(apiKeyId, cardInput.limits?.total);
    return card;
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

  async registerAccount(input: { email: string; name: string; password: string; currency?: import("@acard/core").Currency; accountType?: WorkspaceType }): Promise<RegisterResult> {
    const user = this.platform.auth.registerUser(input);
    const accountHolder = this.platform.signup({ email: input.email, name: input.name, currency: input.currency, accountType: input.accountType });
    const membership = this.platform.auth.addMembership(user.id, accountHolder.id, "owner");
    const { token, context } = this.platform.auth.openSession(user, membership);
    return { user: publicUser(user), accountHolder, sessionToken: token, context };
  }

  async createDepartment(input: { accountHolderId: string; name: string; monthlyBudget: number; lead?: string }) {
    return this.platform.createDepartment(input);
  }
  async updateDepartment(id: string, patch: { name?: string; monthlyBudget?: number; lead?: string }) {
    return this.platform.updateDepartment(id, patch);
  }
  async listDepartments(accountHolderId: string) {
    return this.platform.listDepartments(accountHolderId);
  }
  async listDepartmentSpend(accountHolderId: string) {
    return this.platform.listDepartmentSpend(accountHolderId);
  }
  async getPolicy(accountHolderId: string) {
    return this.platform.getPolicy(accountHolderId);
  }
  async setPolicy(accountHolderId: string, policy: OrgPolicy) {
    return this.platform.setPolicy(accountHolderId, policy);
  }

  async login(input: { email: string; password: string; accountHolderId?: string }): Promise<LoginOutcome> {
    const result = this.platform.auth.login(input);
    if (result.status === "mfa_required") return result;
    return { status: "authenticated", sessionToken: result.token, context: result.context };
  }

  async verifyMfaChallenge(challengeToken: string, code: string) {
    const { token, context } = this.platform.auth.verifyMfaChallenge(challengeToken, code);
    return { sessionToken: token, context };
  }

  async beginMfaEnrolment(userId: string) {
    return this.platform.auth.beginMfaEnrolment(userId);
  }

  async confirmMfaEnrolment(userId: string, code: string) {
    return this.platform.auth.confirmMfaEnrolment(userId, code);
  }

  async disableMfa(userId: string, password: string, code: string) {
    this.platform.auth.disableMfa(userId, password, code);
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

  async recordEmbeddedWallet(accountHolderId: string, chain: import("@acard/core").Chain, address: string) {
    return this.platform.recordEmbeddedWallet(accountHolderId, chain, address);
  }

  async linkExternalWallet(input: {
    accountHolderId: string;
    chain: import("@acard/core").Chain;
    address: string;
    connector: import("@acard/core").ExternalWalletConnector;
    label?: string;
  }) {
    return this.platform.linkExternalWallet(input);
  }

  async listLinkedWallets(accountHolderId: string) {
    return this.platform.listLinkedWallets(accountHolderId);
  }

  async setDefaultWallet(accountHolderId: string, id: string) {
    return this.platform.setDefaultWallet(accountHolderId, id);
  }

  async unlinkWallet(accountHolderId: string, id: string) {
    this.platform.unlinkWallet(accountHolderId, id);
  }

  onEvent(listener: (event: PlatformEvent) => void) {
    this.platform.onEvent(listener);
  }

  async close() {
    // Nothing to close for the in-memory path.
  }
}
