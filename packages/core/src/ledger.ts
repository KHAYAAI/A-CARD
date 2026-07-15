import { newId } from "./ids.js";
import { DomainError, InsufficientFundsError, NotFoundError } from "./errors.js";
import { assertSameCurrency, type Currency, type Money } from "./money.js";

/**
 * A minimal double-entry ledger.
 *
 * Every movement of money is a balanced transaction: the sum of debits equals
 * the sum of credits in the same currency. Wallet spend is a two-phase flow —
 * an authorization places a HOLD (reducing available balance), which is later
 * CAPTURED (posted) or RELEASED (voided). Available balance can never go
 * negative: the hold is placed atomically against available funds, which is
 * what prevents agent overspend races.
 *
 * The store is an in-memory implementation of `LedgerStore`; a Postgres (or
 * TigerBeetle/Blnk) adapter can replace it behind the same interface.
 */

export type AccountType = "asset" | "liability";

export interface Account {
  id: string;
  name: string;
  type: AccountType;
  currency: Currency;
  ownerId?: string;
}

export type PostingDirection = "debit" | "credit";

export interface Posting {
  accountId: string;
  direction: PostingDirection;
  amount: number; // minor units, > 0
}

export type LedgerTxStatus = "posted" | "held" | "released";

export interface LedgerTransaction {
  id: string;
  status: LedgerTxStatus;
  postings: Posting[];
  currency: Currency;
  description: string;
  reference?: string;
  metadata: Record<string, string>;
  createdAt: string;
  settledAt?: string;
}

export interface LedgerStore {
  accounts: Map<string, Account>;
  transactions: Map<string, LedgerTransaction>;
}

export function createLedgerStore(): LedgerStore {
  return { accounts: new Map(), transactions: new Map() };
}

export interface SerializedLedgerStore {
  accounts: Account[];
  transactions: LedgerTransaction[];
}

export function serializeLedgerStore(store: LedgerStore): SerializedLedgerStore {
  return {
    accounts: [...store.accounts.values()],
    transactions: [...store.transactions.values()],
  };
}

export function hydrateLedgerStore(data: SerializedLedgerStore): LedgerStore {
  return {
    accounts: new Map(data.accounts.map((a) => [a.id, a])),
    transactions: new Map(data.transactions.map((t) => [t.id, t])),
  };
}

export class Ledger {
  constructor(readonly store: LedgerStore) {}

  createAccount(input: {
    name: string;
    type: AccountType;
    currency: Currency;
    ownerId?: string;
  }): Account {
    const account: Account = { id: newId("acct"), ...input };
    this.store.accounts.set(account.id, account);
    return account;
  }

  getAccount(id: string): Account {
    const account = this.store.accounts.get(id);
    if (!account) throw new NotFoundError("account", id);
    return account;
  }

  /**
   * Posted balance: sum of settled postings. Liability accounts (customer
   * wallets, from the platform's perspective) increase on credit; asset
   * accounts increase on debit.
   */
  postedBalance(accountId: string): number {
    return this.balanceWhere(accountId, (tx) => tx.status === "posted");
  }

  /** Amount currently locked by holds against this account. */
  heldAmount(accountId: string): number {
    const account = this.getAccount(accountId);
    let held = 0;
    for (const tx of this.store.transactions.values()) {
      if (tx.status !== "held") continue;
      for (const p of tx.postings) {
        if (p.accountId !== accountId) continue;
        // A hold "spends" from the account: for a liability wallet that is a
        // debit posting; for an asset account a credit posting.
        const spends =
          (account.type === "liability" && p.direction === "debit") ||
          (account.type === "asset" && p.direction === "credit");
        if (spends) held += p.amount;
      }
    }
    return held;
  }

  /** Balance a new spend can be authorized against. */
  availableBalance(accountId: string): number {
    return this.postedBalance(accountId) - this.heldAmount(accountId);
  }

  private balanceWhere(
    accountId: string,
    include: (tx: LedgerTransaction) => boolean,
  ): number {
    const account = this.getAccount(accountId);
    let balance = 0;
    for (const tx of this.store.transactions.values()) {
      if (!include(tx)) continue;
      for (const p of tx.postings) {
        if (p.accountId !== accountId) continue;
        const sign =
          account.type === "liability"
            ? p.direction === "credit"
              ? 1
              : -1
            : p.direction === "debit"
              ? 1
              : -1;
        balance += sign * p.amount;
      }
    }
    return balance;
  }

  /** Record an immediately-settled balanced transaction. */
  post(input: {
    postings: Posting[];
    currency: Currency;
    description: string;
    reference?: string;
    metadata?: Record<string, string>;
  }): LedgerTransaction {
    return this.record({ ...input, status: "posted" });
  }

  /**
   * Place a hold: records the postings in `held` status after verifying the
   * spending account has sufficient available balance.
   */
  hold(input: {
    postings: Posting[];
    currency: Currency;
    description: string;
    spendingAccountId: string;
    amount: number;
    reference?: string;
    metadata?: Record<string, string>;
  }): LedgerTransaction {
    const available = this.availableBalance(input.spendingAccountId);
    if (input.amount > available) {
      throw new InsufficientFundsError(
        `hold of ${input.amount} exceeds available balance ${available}`,
      );
    }
    return this.record({ ...input, status: "held" });
  }

  /** Settle a hold, optionally for a smaller final amount. */
  capture(holdId: string, finalAmount?: number): LedgerTransaction {
    const tx = this.getTransaction(holdId);
    if (tx.status !== "held") {
      throw new DomainError("invalid_state", `transaction ${holdId} is ${tx.status}, not held`, 409);
    }
    if (finalAmount !== undefined) {
      const original = tx.postings[0]?.amount ?? 0;
      if (finalAmount <= 0 || finalAmount > original) {
        throw new DomainError(
          "invalid_capture_amount",
          `capture amount ${finalAmount} must be > 0 and <= held amount ${original}`,
        );
      }
      tx.postings = tx.postings.map((p) => ({ ...p, amount: finalAmount }));
    }
    tx.status = "posted";
    tx.settledAt = new Date().toISOString();
    return tx;
  }

  /** Void a hold, returning the funds to available balance. */
  release(holdId: string): LedgerTransaction {
    const tx = this.getTransaction(holdId);
    if (tx.status !== "held") {
      throw new DomainError("invalid_state", `transaction ${holdId} is ${tx.status}, not held`, 409);
    }
    tx.status = "released";
    tx.settledAt = new Date().toISOString();
    return tx;
  }

  getTransaction(id: string): LedgerTransaction {
    const tx = this.store.transactions.get(id);
    if (!tx) throw new NotFoundError("ledger transaction", id);
    return tx;
  }

  listTransactions(filter?: { accountId?: string }): LedgerTransaction[] {
    const all = [...this.store.transactions.values()];
    const filtered = filter?.accountId
      ? all.filter((tx) => tx.postings.some((p) => p.accountId === filter.accountId))
      : all;
    return filtered.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  private record(input: {
    postings: Posting[];
    currency: Currency;
    description: string;
    status: LedgerTxStatus;
    reference?: string;
    metadata?: Record<string, string>;
  }): LedgerTransaction {
    this.validatePostings(input.postings, input.currency);
    const tx: LedgerTransaction = {
      id: newId("ltx"),
      status: input.status,
      postings: input.postings,
      currency: input.currency,
      description: input.description,
      reference: input.reference,
      metadata: input.metadata ?? {},
      createdAt: new Date().toISOString(),
    };
    this.store.transactions.set(tx.id, tx);
    return tx;
  }

  private validatePostings(postings: Posting[], currency: Currency): void {
    if (postings.length < 2) {
      throw new DomainError("unbalanced_transaction", "a transaction needs at least two postings");
    }
    let debits = 0;
    let credits = 0;
    for (const p of postings) {
      if (!Number.isSafeInteger(p.amount) || p.amount <= 0) {
        throw new DomainError("invalid_posting", `posting amount must be a positive integer, got ${p.amount}`);
      }
      const account = this.getAccount(p.accountId);
      if (account.currency !== currency) {
        throw new DomainError(
          "currency_mismatch",
          `account ${p.accountId} is ${account.currency}, transaction is ${currency}`,
        );
      }
      if (p.direction === "debit") debits += p.amount;
      else credits += p.amount;
    }
    if (debits !== credits) {
      throw new DomainError(
        "unbalanced_transaction",
        `debits (${debits}) must equal credits (${credits})`,
      );
    }
  }
}

export function moneyIn(m: Money, currency: Currency): number {
  assertSameCurrency(m, { amount: 0, currency });
  return m.amount;
}
