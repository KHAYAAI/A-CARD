import { newId } from "./ids.js";
import { InvalidStateError, NotFoundError } from "./errors.js";
import type { Currency } from "./money.js";

/**
 * Human-in-the-loop approvals.
 *
 * The real-time authorization window is too short to wait for a human, so a
 * "review" outcome declines the authorization and opens an approval request.
 * When the human approves, an approval *grant* is stored; the next matching
 * authorization (same card + merchant, amount within the approved bound)
 * consumes the grant and goes through. This mirrors Agentcard's inline
 * approval flow and works with any notification channel (Slack, ntfy, email).
 */

export type ApprovalStatus = "pending" | "approved" | "denied" | "consumed";

export interface ApprovalRequest {
  id: string;
  cardId: string;
  accountHolderId: string;
  amount: number;
  currency: Currency;
  merchantName: string;
  merchantCategory: string;
  reason: string;
  status: ApprovalStatus;
  createdAt: string;
  decidedAt?: string;
  decidedBy?: string;
}

export class ApprovalService {
  private readonly requests = new Map<string, ApprovalRequest>();

  serialize(): ApprovalRequest[] {
    return [...this.requests.values()];
  }

  static hydrate(data: ApprovalRequest[]): ApprovalService {
    const service = new ApprovalService();
    for (const request of data) service.requests.set(request.id, request);
    return service;
  }

  open(input: {
    cardId: string;
    accountHolderId: string;
    amount: number;
    currency: Currency;
    merchantName: string;
    merchantCategory: string;
    reason: string;
  }): ApprovalRequest {
    // Reuse an identical pending request instead of piling up duplicates on
    // authorization retries.
    for (const existing of this.requests.values()) {
      if (
        existing.status === "pending" &&
        existing.cardId === input.cardId &&
        existing.merchantName === input.merchantName &&
        existing.amount === input.amount
      ) {
        return existing;
      }
    }
    const request: ApprovalRequest = {
      id: newId("appr"),
      ...input,
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    this.requests.set(request.id, request);
    return request;
  }

  get(id: string): ApprovalRequest {
    const request = this.requests.get(id);
    if (!request) throw new NotFoundError("approval", id);
    return request;
  }

  list(filter?: { accountHolderId?: string; status?: ApprovalStatus }): ApprovalRequest[] {
    return [...this.requests.values()]
      .filter((r) => !filter?.accountHolderId || r.accountHolderId === filter.accountHolderId)
      .filter((r) => !filter?.status || r.status === filter.status)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  decide(id: string, decision: "approved" | "denied", decidedBy: string): ApprovalRequest {
    const request = this.get(id);
    if (request.status !== "pending") {
      throw new InvalidStateError(`approval ${id} already ${request.status}`);
    }
    request.status = decision;
    request.decidedAt = new Date().toISOString();
    request.decidedBy = decidedBy;
    return request;
  }

  /**
   * Find an unconsumed grant covering this authorization. Amount may be
   * slightly above the approved amount is NOT allowed — the grant covers up
   * to the approved amount only.
   */
  findGrant(cardId: string, merchantName: string, amount: number): ApprovalRequest | undefined {
    for (const r of this.requests.values()) {
      if (
        r.status === "approved" &&
        r.cardId === cardId &&
        r.merchantName === merchantName &&
        amount <= r.amount
      ) {
        return r;
      }
    }
    return undefined;
  }

  consume(id: string): void {
    const request = this.get(id);
    request.status = "consumed";
  }
}
