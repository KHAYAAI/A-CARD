import { ApprovalService, type ApprovalRequest } from "./approvals.js";
import { ApiKeyService } from "./apikeys.js";
import { AuthService, type Membership, type Session, type SessionContext, type User } from "./auth.js";
import {
  EnterpriseService,
  type WorkspaceType,
  type Department,
  type DepartmentSpend,
  type OrgPolicy,
} from "./enterprise.js";
import { createCard, redactCard, type Card, type CreateCardInput } from "./cards.js";
import { DomainError, InsufficientFundsError, InvalidStateError, NotFoundError } from "./errors.js";
import { newId } from "./ids.js";
import { IdempotencyStore } from "./idempotency.js";
import {
  createLedgerStore,
  hydrateLedgerStore,
  Ledger,
  serializeLedgerStore,
  type LedgerTransaction,
  type SerializedLedgerStore,
} from "./ledger.js";
import type { Currency } from "./money.js";
import { evaluateRules, type AuthorizationContext } from "./rules.js";
import { applyCardCap, currentBillingPeriod, SUBSCRIPTION_TIERS, type SubscriptionTier } from "./billing.js";
import { WalletLinkService, type Chain, type ExternalWalletConnector, type LinkedWallet } from "./wallets.js";

/**
 * The platform service: everything the API, MCP server, and CLI need, backed
 * by the double-entry ledger. In-memory for the sandbox; each collaborator
 * (ledger store, approvals, keys) sits behind a small interface so a
 * Postgres/Blnk adapter can replace it without touching business logic.
 */

export interface AccountHolder {
  id: string;
  email: string;
  name: string;
  currency: Currency;
  walletAccountId: string;
  subscriptionTier: SubscriptionTier;
  /** personal (default) or enterprise workspace — chosen at sign-up. */
  accountType: WorkspaceType;
  /** WorkOS Organization ID, set once an org owner completes SSO setup. */
  workosOrganizationId?: string;
  /** Email domain routed to this org's SSO connection (lowercased). */
  ssoDomain?: string;
  createdAt: string;
}

export type CardTransactionType = "authorization" | "capture" | "refund" | "declined";
export type CardTransactionStatus = "pending" | "completed" | "declined" | "reversed";

export interface CardTransaction {
  id: string;
  cardId: string;
  accountHolderId: string;
  type: CardTransactionType;
  status: CardTransactionStatus;
  amount: number;
  currency: Currency;
  merchantName: string;
  merchantCategory: string;
  declineReason?: string;
  approvalId?: string;
  ledgerTransactionId?: string;
  createdAt: string;
}

export interface AuthorizationRequest {
  /** Issuer-side authorization/event id — used for exactly-once processing. */
  authorizationId: string;
  cardId: string;
  amount: number;
  currency: Currency;
  merchant: { name: string; category: string; country?: string };
}

export interface AuthorizationDecision {
  approved: boolean;
  declineReason?: string;
  approvalId?: string;
  transaction: CardTransaction;
}

export interface PlatformEvent {
  id: string;
  type: string;
  createdAt: string;
  data: Record<string, unknown>;
}

export interface WalletBalance {
  available: number;
  posted: number;
  held: number;
  currency: Currency;
}

export interface PlatformSnapshot {
  ledger: SerializedLedgerStore;
  approvals: ApprovalRequest[];
  apiKeys: ReturnType<ApiKeyService["serialize"]>;
  auth?: { users: User[]; memberships: Membership[]; sessions: Session[] };
  enterprise?: { departments: Department[]; policies: Array<[string, OrgPolicy]> };
  linkedWallets?: LinkedWallet[];
  accountHolders: AccountHolder[];
  cards: Card[];
  transactions: CardTransaction[];
  openHolds: Array<[string, { ledgerTxId: string; transactionId: string }]>;
  events: PlatformEvent[];
  settlementAccounts: Array<[Currency, string]>;
  /** wallet accounts keyed `${accountHolderId}:${currency}`. */
  wallets?: Array<[string, string]>;
}

export class Platform {
  readonly ledger = new Ledger(createLedgerStore());
  readonly approvals = new ApprovalService();
  readonly apiKeys = new ApiKeyService();
  readonly auth = new AuthService();
  readonly enterprise = new EnterpriseService();
  readonly idempotency = new IdempotencyStore();
  readonly linkedWallets = new WalletLinkService();

  private readonly accountHolders = new Map<string, AccountHolder>();
  private readonly cards = new Map<string, Card>();
  /** issuerCardId -> our card id — how a real issuer's webhook resolves to a card. Rebuilt on hydrate, not separately serialized. */
  private readonly cardsByIssuerId = new Map<string, string>();
  private readonly transactions = new Map<string, CardTransaction>();
  /** Open ledger holds by authorization id, awaiting capture/release. */
  private readonly openHolds = new Map<string, { ledgerTxId: string; transactionId: string }>();
  private readonly events: PlatformEvent[] = [];
  /** Platform settlement account per currency (double-entry counterparty). */
  private readonly settlementAccounts = new Map<Currency, string>();
  /** Wallet ledger account per (account holder, currency), keyed `${holderId}:${currency}`. */
  private readonly wallets = new Map<string, string>();

  /**
   * Whole-platform state as a plain JSON object, for durability across
   * process restarts (see `apps/api/src/persistence.ts`). This is a
   * single-writer snapshot model, not a distributed ledger — correct for one
   * API instance, and the documented next step before scaling to several.
   */
  serialize(): PlatformSnapshot {
    return {
      ledger: serializeLedgerStore(this.ledger.store),
      approvals: this.approvals.serialize(),
      apiKeys: this.apiKeys.serialize(),
      auth: this.auth.serialize(),
      enterprise: this.enterprise.serialize(),
      linkedWallets: this.linkedWallets.serialize(),
      accountHolders: [...this.accountHolders.values()],
      cards: [...this.cards.values()],
      transactions: [...this.transactions.values()],
      openHolds: [...this.openHolds.entries()],
      events: this.events,
      settlementAccounts: [...this.settlementAccounts.entries()],
      wallets: [...this.wallets.entries()],
    };
  }

  static hydrate(snapshot: PlatformSnapshot): Platform {
    const platform = new Platform();
    (platform as { ledger: Ledger }).ledger = new Ledger(hydrateLedgerStore(snapshot.ledger));
    (platform as { approvals: ApprovalService }).approvals = ApprovalService.hydrate(snapshot.approvals);
    (platform as { apiKeys: ApiKeyService }).apiKeys = ApiKeyService.hydrate(snapshot.apiKeys);
    if (snapshot.auth) (platform as { auth: AuthService }).auth = AuthService.hydrate(snapshot.auth);
    if (snapshot.enterprise) (platform as { enterprise: EnterpriseService }).enterprise = EnterpriseService.hydrate(snapshot.enterprise);
    if (snapshot.linkedWallets) {
      (platform as { linkedWallets: WalletLinkService }).linkedWallets = WalletLinkService.hydrate(snapshot.linkedWallets);
    }
    for (const holder of snapshot.accountHolders) {
      // Back-compat: snapshots from before enterprise default to personal.
      if (!holder.accountType) holder.accountType = "personal";
      platform.accountHolders.set(holder.id, holder);
    }
    for (const card of snapshot.cards) {
      platform.cards.set(card.id, card);
      if (card.issuerCardId) platform.cardsByIssuerId.set(card.issuerCardId, card.id);
    }
    for (const tx of snapshot.transactions) platform.transactions.set(tx.id, tx);
    for (const [authId, hold] of snapshot.openHolds) platform.openHolds.set(authId, hold);
    platform.events.push(...snapshot.events);
    for (const [currency, accountId] of snapshot.settlementAccounts) {
      platform.settlementAccounts.set(currency, accountId);
    }
    if (snapshot.wallets) {
      for (const [key, accountId] of snapshot.wallets) platform.wallets.set(key, accountId);
    } else {
      // Back-compat: pre-multi-currency snapshots only had the default wallet.
      for (const holder of snapshot.accountHolders) {
        platform.wallets.set(`${holder.id}:${holder.currency}`, holder.walletAccountId);
      }
    }
    return platform;
  }

  // ---- account holders & wallets ------------------------------------------

  signup(input: { email: string; name: string; currency?: Currency; accountType?: WorkspaceType }): AccountHolder {
    const currency = input.currency ?? "ZAR";
    for (const holder of this.accountHolders.values()) {
      if (holder.email === input.email) {
        throw new InvalidStateError(`an account for ${input.email} already exists`);
      }
    }
    const wallet = this.ledger.createAccount({
      name: `wallet:${input.email}:${currency}`,
      type: "liability",
      currency,
    });
    const holder: AccountHolder = {
      id: newId("ah"),
      email: input.email,
      name: input.name,
      currency,
      walletAccountId: wallet.id,
      subscriptionTier: "free",
      accountType: input.accountType ?? "personal",
      createdAt: new Date().toISOString(),
    };
    this.accountHolders.set(holder.id, holder);
    this.wallets.set(`${holder.id}:${currency}`, wallet.id);
    this.emit("account_holder.created", { accountHolderId: holder.id });
    return holder;
  }

  getAccountHolder(id: string): AccountHolder {
    const holder = this.accountHolders.get(id);
    if (!holder) throw new NotFoundError("account holder", id);
    return holder;
  }

  /** Called by the Stripe webhook once a subscription payment settles. */
  setSubscriptionTier(accountHolderId: string, tier: SubscriptionTier): AccountHolder {
    const holder = this.getAccountHolder(accountHolderId);
    holder.subscriptionTier = tier;
    this.emit("subscription.updated", { accountHolderId, tier });
    return holder;
  }

  // ---- SSO (WorkOS) --------------------------------------------------------
  //
  // Existing email/password login (with its own TOTP MFA) stays primary for
  // every account. This is purely an additive door scoped to organizations
  // that have configured SAML/OIDC via their own identity provider — an
  // org owner runs setup once (`setSsoOrganization`), after which any of
  // their people can sign in through it. A WorkOS profile never becomes a
  // second source of identity: `completeSsoLogin` resolves it onto the same
  // User/Membership/Session model password login and MFA already use.

  /** Record the WorkOS Organization an account has configured for SSO, once. */
  setSsoOrganization(accountHolderId: string, input: { workosOrganizationId: string; ssoDomain: string }): AccountHolder {
    const holder = this.getAccountHolder(accountHolderId);
    const domain = input.ssoDomain.toLowerCase();
    for (const other of this.accountHolders.values()) {
      if (other.id !== holder.id && other.ssoDomain === domain) {
        throw new InvalidStateError(`the domain ${domain} is already configured for SSO on a different account`);
      }
    }
    holder.workosOrganizationId = input.workosOrganizationId;
    holder.ssoDomain = domain;
    this.emit("sso.configured", { accountHolderId, domain });
    return holder;
  }

  /** Which account (if any) a work email's domain routes SSO login to. */
  getAccountHolderBySsoDomain(domain: string): AccountHolder | undefined {
    const lower = domain.toLowerCase();
    return [...this.accountHolders.values()].find((h) => h.ssoDomain === lower);
  }

  /**
   * Which account a WorkOS Organization ID belongs to. Used on the SSO
   * callback, where the organization id comes from WorkOS's own signed
   * profile rather than anything the caller supplied — the trustworthy end
   * of the flow, unlike the email domain used to kick it off.
   */
  getAccountHolderByWorkosOrganizationId(workosOrganizationId: string): AccountHolder | undefined {
    return [...this.accountHolders.values()].find((h) => h.workosOrganizationId === workosOrganizationId);
  }

  /**
   * Complete an SSO login: find-or-create the user and their membership on
   * this account, then open a session exactly the way password login does.
   * New SSO users default to `member` — the org already has an owner from
   * whoever registered it and ran SSO setup.
   */
  completeSsoLogin(input: { accountHolderId: string; email: string; name: string }): {
    token: string;
    session: Session;
    context: SessionContext;
  } {
    const holder = this.getAccountHolder(input.accountHolderId);
    const user = this.auth.findOrCreateSsoUser({ email: input.email, name: input.name });
    const membership = this.auth.getMembership(user.id, holder.id) ?? this.auth.addMembership(user.id, holder.id, "member");
    this.emit("sso.login", { accountHolderId: holder.id, userId: user.id });
    return this.auth.openSession(user, membership);
  }

  /** Wallet ledger account for a (holder, currency), created on first use. */
  private walletAccountFor(holder: AccountHolder, currency: Currency): string {
    const key = `${holder.id}:${currency}`;
    let id = this.wallets.get(key);
    if (!id) {
      id = this.ledger.createAccount({
        name: `wallet:${holder.email}:${currency}`,
        type: "liability",
        currency,
      }).id;
      this.wallets.set(key, id);
    }
    return id;
  }

  /**
   * Fund a wallet (sandbox: instant settle; production: driven by a
   * PayFast/EFT top-up webhook). Double entry: debit the platform settlement
   * asset account, credit the customer's wallet liability account. Currency
   * defaults to the holder's primary currency; any supported currency creates
   * (or tops up) that currency's wallet.
   */
  fundWallet(accountHolderId: string, amount: number, currency?: Currency, reference?: string): LedgerTransaction {
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      throw new DomainError("invalid_amount", "funding amount must be a positive integer of minor units");
    }
    const holder = this.getAccountHolder(accountHolderId);
    const ccy = currency ?? holder.currency;
    const walletAccountId = this.walletAccountFor(holder, ccy);
    const settlement = this.settlementAccount(ccy);
    const tx = this.ledger.post({
      currency: ccy,
      description: `wallet top-up for ${holder.email} (${ccy})`,
      reference,
      postings: [
        { accountId: settlement, direction: "debit", amount },
        { accountId: walletAccountId, direction: "credit", amount },
      ],
      metadata: { accountHolderId },
    });
    this.emit("wallet.funded", { accountHolderId, amount, currency: ccy });
    return tx;
  }

  private balanceOf(walletAccountId: string, currency: Currency): WalletBalance {
    return {
      available: this.ledger.availableBalance(walletAccountId),
      posted: this.ledger.postedBalance(walletAccountId),
      held: this.ledger.heldAmount(walletAccountId),
      currency,
    };
  }

  walletBalance(accountHolderId: string, currency?: Currency): WalletBalance {
    const holder = this.getAccountHolder(accountHolderId);
    const ccy = currency ?? holder.currency;
    const walletAccountId = this.wallets.get(`${holder.id}:${ccy}`);
    if (!walletAccountId) return { available: 0, posted: 0, held: 0, currency: ccy };
    return this.balanceOf(walletAccountId, ccy);
  }

  /** Every currency wallet this holder has, primary currency first. */
  walletBalances(accountHolderId: string): WalletBalance[] {
    const holder = this.getAccountHolder(accountHolderId);
    const prefix = `${holder.id}:`;
    const balances: WalletBalance[] = [];
    for (const [key, walletAccountId] of this.wallets) {
      if (!key.startsWith(prefix)) continue;
      const currency = key.slice(prefix.length) as Currency;
      balances.push(this.balanceOf(walletAccountId, currency));
    }
    if (balances.length === 0) balances.push({ available: 0, posted: 0, held: 0, currency: holder.currency });
    return balances.sort((a, b) => (a.currency === holder.currency ? -1 : b.currency === holder.currency ? 1 : a.currency.localeCompare(b.currency)));
  }

  // ---- cards ----------------------------------------------------------------

  createCard(input: Omit<CreateCardInput, "walletAccountId" | "currency"> & { currency?: Currency }): Card {
    const holder = this.getAccountHolder(input.accountHolderId);
    const currency = input.currency ?? holder.currency;
    if (input.departmentId) {
      const dept = this.enterprise.findDepartment(input.departmentId);
      if (!dept || dept.accountHolderId !== holder.id) {
        throw new DomainError("invalid_department", "department does not belong to this account");
      }
    }
    // A card draws from its currency's wallet, provisioned on demand — an org
    // can hold ZAR and USD (and any other supported currency) side by side.
    const walletAccountId = this.walletAccountFor(holder, currency);
    const tierLimit = SUBSCRIPTION_TIERS[holder.subscriptionTier].cardsPerMonth;
    const period = currentBillingPeriod();
    const createdThisPeriod = [...this.cards.values()].filter(
      (c) => c.accountHolderId === holder.id && currentBillingPeriod(new Date(c.createdAt)) === period,
    ).length;
    if (createdThisPeriod >= tierLimit) {
      throw new DomainError(
        "plan_limit_exceeded",
        `${holder.subscriptionTier} plan allows ${tierLimit} cards/month; upgrade to create more`,
        402,
      );
    }
    if (input.issuerCardId && this.cardsByIssuerId.has(input.issuerCardId)) {
      throw new InvalidStateError(`issuer card ${input.issuerCardId} is already linked to a different card`);
    }
    const limits = applyCardCap(holder.subscriptionTier, currency, input.limits);
    const card = createCard({ ...input, currency, walletAccountId, limits });
    this.cards.set(card.id, card);
    if (card.issuerCardId) this.cardsByIssuerId.set(card.issuerCardId, card.id);
    this.emit("card.created", { cardId: card.id, accountHolderId: holder.id });
    return card;
  }

  getCard(id: string): Card {
    const card = this.cards.get(id);
    if (!card) throw new NotFoundError("card", id);
    return card;
  }

  /** Look up a card by the issuing partner's own reference (e.g. Sudo's card token). */
  getCardByIssuerCardId(issuerCardId: string): Card | undefined {
    const cardId = this.cardsByIssuerId.get(issuerCardId);
    return cardId ? this.cards.get(cardId) : undefined;
  }

  /**
   * Attach (or update) the issuing partner's reference for a card provisioned
   * after creation — e.g. issuer provisioning is a separate call that can
   * fail independently of the card record itself.
   */
  linkIssuerCard(cardId: string, issuerCardId: string): Card {
    const card = this.getCard(cardId);
    const existingOwner = this.cardsByIssuerId.get(issuerCardId);
    if (existingOwner && existingOwner !== cardId) {
      throw new InvalidStateError(`issuer card ${issuerCardId} is already linked to a different card`);
    }
    if (card.issuerCardId && card.issuerCardId !== issuerCardId) {
      this.cardsByIssuerId.delete(card.issuerCardId);
    }
    card.issuerCardId = issuerCardId;
    this.cardsByIssuerId.set(issuerCardId, cardId);
    this.emit("card.issuer_linked", { cardId, issuerCardId });
    return card;
  }

  listCards(accountHolderId: string): Card[] {
    return [...this.cards.values()]
      .filter((c) => c.accountHolderId === accountHolderId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  closeCard(id: string, reason = "closed_by_user"): Card {
    const card = this.getCard(id);
    if (card.status === "closed") return card;
    card.status = "closed";
    card.closedAt = new Date().toISOString();
    card.closeReason = reason;
    this.emit("card.closed", { cardId: card.id, reason });
    return card;
  }

  // ---- real-time authorization (the hot path) --------------------------------

  /**
   * Decide an issuer authorization request. Synchronous and allocation-light:
   * this is the code that must answer inside the issuer's real-time window.
   *
   * Order of operations:
   *   1. exactly-once guard on the issuer authorization id
   *   2. rules pass (card state, MCC, limits, velocity, approval threshold)
   *   3. approval-grant consumption for previously human-approved charges
   *   4. atomic hold against wallet available balance
   */
  authorize(request: AuthorizationRequest): AuthorizationDecision {
    const existing = this.transactions.get(`ctx_${request.authorizationId}`);
    if (existing) {
      return {
        approved: existing.status !== "declined",
        declineReason: existing.declineReason,
        transaction: existing,
      };
    }

    // Resolve by our id first (the mock issuer echoes it back, so this is
    // the common case and stays a single Map lookup); a real issuer's
    // webhook instead carries *their* card reference, so fall back to that.
    const card = this.cards.get(request.cardId) ?? this.getCardByIssuerCardId(request.cardId);
    if (!card) {
      return this.declineRecord(request, undefined, "card_not_found");
    }

    const spend = this.cardSpend(card.id);
    const grant = this.approvals.findGrant(card.id, request.merchant.name, request.amount);

    // ---- org-wide policy, enforced ahead of per-card rules --------------------
    const policy = this.enterprise.getPolicy(card.accountHolderId);
    if (policy.blockedMerchantCategories.includes(request.merchant.category)) {
      return this.declineRecord(request, card, "merchant_category_blocked_by_policy");
    }

    const ctx: AuthorizationContext = {
      card,
      amount: request.amount,
      currency: request.currency,
      merchant: request.merchant,
      cardSpendToDate: spend.total,
      cardSpendInWindow: spend.inWindow(card.limits.velocity?.windowSeconds ?? 0),
      hasApprovalGrant: grant !== undefined,
    };

    let outcome = evaluateRules(ctx);

    // Org approval threshold: route to review even if the card has none.
    if (
      outcome.decision === "approve" &&
      policy.approvalThreshold !== undefined &&
      request.amount >= policy.approvalThreshold &&
      grant === undefined
    ) {
      outcome = { decision: "review", reason: "amount_requires_org_approval" };
    }

    if (outcome.decision === "decline") {
      return this.declineRecord(request, card, outcome.reason);
    }

    // Department monthly budget: a hard cap across all of a department's agents.
    if (outcome.decision === "approve" && card.departmentId) {
      const dept = this.enterprise.findDepartment(card.departmentId);
      if (dept && this.departmentSpendThisPeriod(dept.id) + request.amount > dept.monthlyBudget) {
        return this.declineRecord(request, card, "department_budget_exceeded");
      }
    }

    if (outcome.decision === "review") {
      const approval = this.approvals.open({
        cardId: card.id,
        accountHolderId: card.accountHolderId,
        amount: request.amount,
        currency: card.currency,
        merchantName: request.merchant.name,
        merchantCategory: request.merchant.category,
        reason: outcome.reason,
      });
      this.emit("approval.requested", { approvalId: approval.id, cardId: card.id, amount: request.amount });
      const decision = this.declineRecord(request, card, "pending_human_approval");
      decision.transaction.approvalId = approval.id;
      return { ...decision, approvalId: approval.id };
    }

    // Place the hold. This is the atomic overspend guard.
    let hold: LedgerTransaction;
    try {
      hold = this.ledger.hold({
        currency: card.currency,
        description: `authorization at ${request.merchant.name}`,
        spendingAccountId: card.walletAccountId,
        amount: request.amount,
        reference: request.authorizationId,
        postings: [
          { accountId: card.walletAccountId, direction: "debit", amount: request.amount },
          { accountId: this.settlementAccount(card.currency), direction: "credit", amount: request.amount },
        ],
        metadata: { cardId: card.id, authorizationId: request.authorizationId },
      });
    } catch (error) {
      if (error instanceof InsufficientFundsError) {
        return this.declineRecord(request, card, "insufficient_funds");
      }
      throw error;
    }

    if (grant) this.approvals.consume(grant.id);

    const transaction: CardTransaction = {
      id: `ctx_${request.authorizationId}`,
      cardId: card.id,
      accountHolderId: card.accountHolderId,
      type: "authorization",
      status: "pending",
      amount: request.amount,
      currency: card.currency,
      merchantName: request.merchant.name,
      merchantCategory: request.merchant.category,
      approvalId: grant?.id,
      ledgerTransactionId: hold.id,
      createdAt: new Date().toISOString(),
    };
    this.transactions.set(transaction.id, transaction);
    this.openHolds.set(request.authorizationId, { ledgerTxId: hold.id, transactionId: transaction.id });
    this.emit("authorization.approved", { cardId: card.id, authorizationId: request.authorizationId, amount: request.amount });
    return { approved: true, transaction };
  }

  /** Settle a previously approved authorization (issuer clearing event). */
  capture(authorizationId: string, finalAmount?: number): CardTransaction {
    const open = this.openHolds.get(authorizationId);
    if (!open) throw new NotFoundError("open authorization", authorizationId);
    const transaction = this.transactions.get(open.transactionId);
    if (!transaction) throw new NotFoundError("transaction", open.transactionId);

    this.ledger.capture(open.ledgerTxId, finalAmount);
    transaction.status = "completed";
    transaction.type = "capture";
    if (finalAmount !== undefined) transaction.amount = finalAmount;
    this.openHolds.delete(authorizationId);

    const card = this.getCard(transaction.cardId);
    if (card.singleUse && card.status === "active") {
      this.closeCard(card.id, "single_use_completed");
    }
    this.emit("transaction.captured", { cardId: card.id, authorizationId, amount: transaction.amount });
    return transaction;
  }

  /** Reverse a previously approved authorization (expiry or merchant void). */
  reverse(authorizationId: string): CardTransaction {
    const open = this.openHolds.get(authorizationId);
    if (!open) throw new NotFoundError("open authorization", authorizationId);
    const transaction = this.transactions.get(open.transactionId);
    if (!transaction) throw new NotFoundError("transaction", open.transactionId);

    this.ledger.release(open.ledgerTxId);
    transaction.status = "reversed";
    this.openHolds.delete(authorizationId);
    this.emit("authorization.reversed", { authorizationId });
    return transaction;
  }

  listTransactions(filter: { accountHolderId?: string; cardId?: string }): CardTransaction[] {
    return [...this.transactions.values()]
      .filter((t) => !filter.accountHolderId || t.accountHolderId === filter.accountHolderId)
      .filter((t) => !filter.cardId || t.cardId === filter.cardId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  decideApproval(approvalId: string, decision: "approved" | "denied", decidedBy: string): ApprovalRequest {
    const approval = this.approvals.decide(approvalId, decision, decidedBy);
    this.emit(`approval.${decision}`, { approvalId, decidedBy });
    return approval;
  }

  // ---- enterprise: departments & policy ------------------------------------

  createDepartment(input: { accountHolderId: string; name: string; monthlyBudget: number; lead?: string }): Department {
    this.getAccountHolder(input.accountHolderId);
    const department = this.enterprise.createDepartment(input);
    this.emit("department.created", { departmentId: department.id, accountHolderId: input.accountHolderId });
    return department;
  }

  updateDepartment(id: string, patch: { name?: string; monthlyBudget?: number; lead?: string }): Department {
    return this.enterprise.updateDepartment(id, patch);
  }

  listDepartments(accountHolderId: string): Department[] {
    return this.enterprise.listDepartments(accountHolderId);
  }

  /** Departments with their spend this billing period — the finance/overview view. */
  listDepartmentSpend(accountHolderId: string): DepartmentSpend[] {
    const holder = this.getAccountHolder(accountHolderId);
    return this.enterprise.listDepartments(accountHolderId).map((department) => ({
      department,
      spentThisMonth: this.departmentSpendThisPeriod(department.id),
      cardCount: [...this.cards.values()].filter((c) => c.departmentId === department.id).length,
      currency: holder.currency,
    }));
  }

  getPolicy(accountHolderId: string): OrgPolicy {
    return this.enterprise.getPolicy(accountHolderId);
  }

  setPolicy(accountHolderId: string, policy: OrgPolicy): OrgPolicy {
    this.getAccountHolder(accountHolderId);
    const saved = this.enterprise.setPolicy(accountHolderId, policy);
    this.emit("policy.updated", { accountHolderId });
    return saved;
  }

  // ---- crypto wallets: embedded (default) + optional external linking ------

  /** Called by the API after it provisions an embedded wallet with the wallet provider. */
  recordEmbeddedWallet(accountHolderId: string, chain: Chain, address: string): LinkedWallet {
    this.getAccountHolder(accountHolderId);
    const wallet = this.linkedWallets.recordEmbeddedWallet(accountHolderId, chain, address);
    this.emit("wallet.embedded_provisioned", { accountHolderId, chain, address: wallet.address });
    return wallet;
  }

  linkExternalWallet(input: {
    accountHolderId: string;
    chain: Chain;
    address: string;
    connector: ExternalWalletConnector;
    label?: string;
  }): LinkedWallet {
    this.getAccountHolder(input.accountHolderId);
    const wallet = this.linkedWallets.linkExternalWallet(input);
    this.emit("wallet.external_linked", { accountHolderId: input.accountHolderId, chain: input.chain, connector: input.connector });
    return wallet;
  }

  listLinkedWallets(accountHolderId: string): LinkedWallet[] {
    return this.linkedWallets.list(accountHolderId);
  }

  setDefaultWallet(accountHolderId: string, id: string): LinkedWallet {
    return this.linkedWallets.setDefault(accountHolderId, id);
  }

  unlinkWallet(accountHolderId: string, id: string): void {
    this.linkedWallets.unlink(accountHolderId, id);
    this.emit("wallet.unlinked", { accountHolderId, walletId: id });
  }

  private departmentSpendThisPeriod(departmentId: string): number {
    const period = currentBillingPeriod();
    const cardIds = new Set(
      [...this.cards.values()].filter((c) => c.departmentId === departmentId).map((c) => c.id),
    );
    return [...this.transactions.values()]
      .filter(
        (t) =>
          cardIds.has(t.cardId) &&
          (t.status === "pending" || t.status === "completed") &&
          currentBillingPeriod(new Date(t.createdAt)) === period,
      )
      .reduce((sum, t) => sum + t.amount, 0);
  }

  listEvents(): PlatformEvent[] {
    return [...this.events];
  }

  redactCard = redactCard;

  // ---- internals -------------------------------------------------------------

  private settlementAccount(currency: Currency): string {
    let id = this.settlementAccounts.get(currency);
    if (!id) {
      id = this.ledger.createAccount({
        name: `platform-settlement-${currency}`,
        type: "asset",
        currency,
      }).id;
      this.settlementAccounts.set(currency, id);
    }
    return id;
  }

  private cardSpend(cardId: string): { total: number; inWindow: (windowSeconds: number) => number } {
    const relevant = [...this.transactions.values()].filter(
      (t) => t.cardId === cardId && (t.status === "pending" || t.status === "completed"),
    );
    const total = relevant.reduce((sum, t) => sum + t.amount, 0);
    return {
      total,
      inWindow: (windowSeconds: number) => {
        if (windowSeconds <= 0) return 0;
        const cutoff = Date.now() - windowSeconds * 1000;
        return relevant
          .filter((t) => Date.parse(t.createdAt) >= cutoff)
          .reduce((sum, t) => sum + t.amount, 0);
      },
    };
  }

  private declineRecord(
    request: AuthorizationRequest,
    card: Card | undefined,
    reason: string,
  ): AuthorizationDecision {
    const transaction: CardTransaction = {
      id: `ctx_${request.authorizationId}`,
      // Prefer the resolved card's own id — request.cardId may be the
      // issuing partner's reference (see the issuerCardId fallback in
      // authorize()), and every other transaction listing keys on our id.
      cardId: card?.id ?? request.cardId,
      accountHolderId: card?.accountHolderId ?? "unknown",
      type: "declined",
      status: "declined",
      amount: request.amount,
      currency: request.currency,
      merchantName: request.merchant.name,
      merchantCategory: request.merchant.category,
      declineReason: reason,
      createdAt: new Date().toISOString(),
    };
    this.transactions.set(transaction.id, transaction);
    this.emit("authorization.declined", { authorizationId: request.authorizationId, reason });
    return { approved: false, declineReason: reason, transaction };
  }

  private readonly listeners: Array<(event: PlatformEvent) => void> = [];

  /** Subscribe to platform events (e.g. to forward `approval.requested` to Slack). Not persisted. */
  onEvent(listener: (event: PlatformEvent) => void): void {
    this.listeners.push(listener);
  }

  private emit(type: string, data: Record<string, unknown>): void {
    const event: PlatformEvent = { id: newId("evt"), type, createdAt: new Date().toISOString(), data };
    this.events.push(event);
    for (const listener of this.listeners) listener(event);
  }
}
