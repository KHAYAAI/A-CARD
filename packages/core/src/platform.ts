import { ApprovalService, type ApprovalRequest } from "./approvals.js";
import { ApiKeyService } from "./apikeys.js";
import { createCard, redactCard, type Card, type CreateCardInput } from "./cards.js";
import { DomainError, InsufficientFundsError, InvalidStateError, NotFoundError } from "./errors.js";
import { newId } from "./ids.js";
import { IdempotencyStore } from "./idempotency.js";
import { createLedgerStore, Ledger, type LedgerTransaction } from "./ledger.js";
import type { Currency } from "./money.js";
import { evaluateRules, type AuthorizationContext } from "./rules.js";

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

export class Platform {
  readonly ledger = new Ledger(createLedgerStore());
  readonly approvals = new ApprovalService();
  readonly apiKeys = new ApiKeyService();
  readonly idempotency = new IdempotencyStore();

  private readonly accountHolders = new Map<string, AccountHolder>();
  private readonly cards = new Map<string, Card>();
  private readonly transactions = new Map<string, CardTransaction>();
  /** Open ledger holds by authorization id, awaiting capture/release. */
  private readonly openHolds = new Map<string, { ledgerTxId: string; transactionId: string }>();
  private readonly events: PlatformEvent[] = [];
  /** Platform settlement account per currency (double-entry counterparty). */
  private readonly settlementAccounts = new Map<Currency, string>();

  // ---- account holders & wallets ------------------------------------------

  signup(input: { email: string; name: string; currency?: Currency }): AccountHolder {
    const currency = input.currency ?? "ZAR";
    for (const holder of this.accountHolders.values()) {
      if (holder.email === input.email) {
        throw new InvalidStateError(`an account for ${input.email} already exists`);
      }
    }
    const wallet = this.ledger.createAccount({
      name: `wallet:${input.email}`,
      type: "liability",
      currency,
    });
    const holder: AccountHolder = {
      id: newId("ah"),
      email: input.email,
      name: input.name,
      currency,
      walletAccountId: wallet.id,
      createdAt: new Date().toISOString(),
    };
    this.accountHolders.set(holder.id, holder);
    this.emit("account_holder.created", { accountHolderId: holder.id });
    return holder;
  }

  getAccountHolder(id: string): AccountHolder {
    const holder = this.accountHolders.get(id);
    if (!holder) throw new NotFoundError("account holder", id);
    return holder;
  }

  /**
   * Fund the wallet (sandbox: instant settle; production: driven by a
   * Paystack/EFT top-up webhook). Double entry: debit the platform settlement
   * asset account, credit the customer's wallet liability account.
   */
  fundWallet(accountHolderId: string, amount: number, reference?: string): LedgerTransaction {
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      throw new DomainError("invalid_amount", "funding amount must be a positive integer of minor units");
    }
    const holder = this.getAccountHolder(accountHolderId);
    const settlement = this.settlementAccount(holder.currency);
    const tx = this.ledger.post({
      currency: holder.currency,
      description: `wallet top-up for ${holder.email}`,
      reference,
      postings: [
        { accountId: settlement, direction: "debit", amount },
        { accountId: holder.walletAccountId, direction: "credit", amount },
      ],
      metadata: { accountHolderId },
    });
    this.emit("wallet.funded", { accountHolderId, amount, currency: holder.currency });
    return tx;
  }

  walletBalance(accountHolderId: string): { available: number; posted: number; held: number; currency: Currency } {
    const holder = this.getAccountHolder(accountHolderId);
    return {
      available: this.ledger.availableBalance(holder.walletAccountId),
      posted: this.ledger.postedBalance(holder.walletAccountId),
      held: this.ledger.heldAmount(holder.walletAccountId),
      currency: holder.currency,
    };
  }

  // ---- cards ----------------------------------------------------------------

  createCard(input: Omit<CreateCardInput, "walletAccountId" | "currency"> & { currency?: Currency }): Card {
    const holder = this.getAccountHolder(input.accountHolderId);
    const currency = input.currency ?? holder.currency;
    if (currency !== holder.currency) {
      throw new DomainError("currency_mismatch", `wallet is ${holder.currency}; multi-currency cards need a ${currency} wallet`);
    }
    const card = createCard({ ...input, currency, walletAccountId: holder.walletAccountId });
    this.cards.set(card.id, card);
    this.emit("card.created", { cardId: card.id, accountHolderId: holder.id });
    return card;
  }

  getCard(id: string): Card {
    const card = this.cards.get(id);
    if (!card) throw new NotFoundError("card", id);
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

    const card = this.cards.get(request.cardId);
    if (!card) {
      return this.declineRecord(request, undefined, "card_not_found");
    }

    const spend = this.cardSpend(card.id);
    const grant = this.approvals.findGrant(card.id, request.merchant.name, request.amount);
    const ctx: AuthorizationContext = {
      card,
      amount: request.amount,
      currency: request.currency,
      merchant: request.merchant,
      cardSpendToDate: spend.total,
      cardSpendInWindow: spend.inWindow(card.limits.velocity?.windowSeconds ?? 0),
      hasApprovalGrant: grant !== undefined,
    };

    const outcome = evaluateRules(ctx);

    if (outcome.decision === "decline") {
      return this.declineRecord(request, card, outcome.reason);
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
      cardId: request.cardId,
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

  private emit(type: string, data: Record<string, unknown>): void {
    this.events.push({ id: newId("evt"), type, createdAt: new Date().toISOString(), data });
  }
}
