import { DomainError, InvalidStateError, NotFoundError } from "./errors.js";
import { newId } from "./ids.js";
import type { Currency } from "./money.js";

/**
 * AFP — the Agent Financial Platform. Where A-CARD decides *whether* an
 * agent may spend and A-MERCHANT decides *where* it can buy, AFP decides
 * *how the money actually moves* once both of those have said yes: which
 * rail carries a given payment, and the one ledger that stays truthful once
 * three rails with three different definitions of "done" are all writing
 * into it.
 *
 * This module is the routing engine and the ledger — pure, synchronous
 * domain logic, no network I/O, same discipline as the rest of `core`. Rail
 * adapters (the code that actually calls a card processor, an x402
 * counterparty, or a chain) live in `apps/api/src/rails/` because they do
 * real I/O; this module only ever sees the `RailQuote`/`RailReceipt`
 * shapes they produce.
 *
 * Two design decisions are worth reading before changing anything:
 *
 * 1. **Routing is retrieval-then-score, not a black box.** `routeIntent`
 *    takes quotes already gathered from every candidate rail and scores them
 *    deterministically — same "evaluate every candidate, report why the
 *    losers lost" discipline as A-MERCHANT's `evaluateOffers`. An agent (or
 *    the human who owns the budget) can see exactly why a rail was chosen,
 *    not just which one was.
 *
 * 2. **Finality is a fact about the rail, not an afterthought.** A card
 *    authorization can be charged back for up to 120 days. A stablecoin
 *    transfer is irreversible the moment it confirms. An EFT settles same-day
 *    but isn't card-instant either. `RailFinality` makes this a typed
 *    property every rail must declare, and `AfpLedger` uses it to decide
 *    when a transaction is allowed to call itself `settled` versus merely
 *    `posted` — conflating those two is exactly how money goes missing in a
 *    multi-rail ledger.
 */

// ---- rails -------------------------------------------------------------

export type RailId = "card" | "x402" | "stablecoin";

/**
 * How final "done" actually is on this rail:
 *  - `instant`: final the moment execution returns (a stablecoin transfer
 *    once it has the confirmations the adapter requires).
 *  - `reversal_window`: execution succeeds now, but the counterparty (or a
 *    card network) can still claw it back for `reversalWindowDays`.
 *  - `settlement_delay`: execution succeeds now, but funds don't actually
 *    move until `settlesAfterHours` later (EFT-style) — final once it does,
 *    no reversal risk, just latency.
 */
export type FinalityKind = "instant" | "reversal_window" | "settlement_delay";

export interface RailFinality {
  kind: FinalityKind;
  reversalWindowDays?: number;
  settlesAfterHours?: number;
}

export interface RailProfile {
  id: RailId;
  label: string;
  finality: RailFinality;
}

// ---- intents -------------------------------------------------------------

export interface AfpIntent {
  id: string;
  accountHolderId: string;
  amount: number; // minor units
  currency: Currency;
  /** What this pays for — a merchant name, an API endpoint, a counterparty label. Shown to the human who owns the budget. */
  purpose: string;
  /** Opaque to AFP: a merchant id, a URL, a wallet address — whatever the chosen rail needs to actually execute. */
  counterparty: string;
  /** Narrows which rails may even be considered — set by policy before routing ever runs, not a rail's own opinion. */
  allowedRails?: RailId[];
  createdAt: string;
}

export interface CreateIntentInput {
  accountHolderId: string;
  amount: number;
  currency: Currency;
  purpose: string;
  counterparty: string;
  allowedRails?: RailId[];
}

export function createIntent(input: CreateIntentInput): AfpIntent {
  if (!Number.isSafeInteger(input.amount) || input.amount <= 0) {
    throw new DomainError("invalid_amount", "amount must be a positive integer of minor units");
  }
  return {
    id: newId("afpi"),
    accountHolderId: input.accountHolderId,
    amount: input.amount,
    currency: input.currency,
    purpose: input.purpose,
    counterparty: input.counterparty,
    allowedRails: input.allowedRails,
    createdAt: new Date().toISOString(),
  };
}

// ---- routing ---------------------------------------------------------------

export interface RailQuote {
  rail: RailId;
  available: boolean;
  /** Fee estimate for this payment, minor units. Only meaningful when available. */
  costCents: number;
  /** Estimated time to execution accepting, in seconds. Only meaningful when available. */
  etaSeconds: number;
  /** Why this rail can't carry this intent, when available is false. */
  reason?: string;
}

/**
 * Scoring weights. Exported so they're tunable and testable rather than
 * magic numbers, same reasoning as A-MERCHANT's `OFFER_WEIGHTS` — whoever
 * owns the budget should be able to see why a rail won, not just that one did.
 */
export const ROUTING_WEIGHTS = {
  cost: 0.45,
  speed: 0.35,
  /** Reward for finality that closes fast (instant/settlement_delay) over one that carries a standing reversal risk (reversal_window). */
  finality: 0.2,
} as const;

const FINALITY_SCORE: Record<FinalityKind, number> = {
  instant: 1,
  settlement_delay: 0.7,
  reversal_window: 0.4,
};

export interface ScoredRail {
  rail: RailId;
  score: number;
  quote: RailQuote;
  finality: RailFinality;
  matchReasons: string[];
}

export interface RejectedRail {
  rail: RailId;
  reason: string;
}

export interface RoutingDecision {
  intentId: string;
  chosenRail?: RailId;
  scored: ScoredRail[];
  rejected: RejectedRail[];
}

/**
 * Retrieval already happened — `quotes` is one `RailQuote` per candidate
 * rail, gathered by the API layer calling each adapter. This function only
 * scores and explains; it never calls a rail itself, so it stays exactly as
 * testable as `evaluateOffers`.
 */
export function routeIntent(intent: AfpIntent, quotes: Array<{ quote: RailQuote; profile: RailProfile }>): RoutingDecision {
  const rejected: RejectedRail[] = [];
  const candidates: Array<{ quote: RailQuote; profile: RailProfile }> = [];

  for (const entry of quotes) {
    const { quote, profile } = entry;
    if (intent.allowedRails?.length && !intent.allowedRails.includes(profile.id)) {
      rejected.push({ rail: profile.id, reason: "not in this intent's allowed rails" });
      continue;
    }
    if (!quote.available) {
      rejected.push({ rail: profile.id, reason: quote.reason ?? "rail reported unavailable" });
      continue;
    }
    candidates.push(entry);
  }

  if (candidates.length === 0) {
    return { intentId: intent.id, scored: [], rejected };
  }

  const best = {
    cost: Math.min(...candidates.map((c) => c.quote.costCents)),
    eta: Math.min(...candidates.map((c) => c.quote.etaSeconds)),
  };
  // Same proportional-ratio scoring as A-MERCHANT's rankOffers, and for the
  // same reason: normalising against the result set's own spread hands a
  // one-cent fee difference the entire cost weight, which would let a rail
  // with a 120-day reversal window beat an instant one on a rounding error.
  const ratio = (value: number, bestValue: number, offset = 0) => (bestValue + offset) / (value + offset || 1);

  const scored: ScoredRail[] = candidates.map(({ quote, profile }) => {
    const costScore = ratio(quote.costCents, best.cost, 1);
    const speedScore = ratio(quote.etaSeconds, best.eta, 1);
    const finalityScore = FINALITY_SCORE[profile.finality.kind];
    const score =
      Math.round(
        (costScore * ROUTING_WEIGHTS.cost + speedScore * ROUTING_WEIGHTS.speed + finalityScore * ROUTING_WEIGHTS.finality) * 1000,
      ) / 1000;

    const matchReasons: string[] = [];
    if (quote.costCents === best.cost) matchReasons.push("lowest fee");
    if (quote.etaSeconds === best.eta) matchReasons.push("fastest execution");
    if (profile.finality.kind === "instant") matchReasons.push("instant finality — no standing reversal risk");
    if (profile.finality.kind === "reversal_window") {
      matchReasons.push(`reversible for ${profile.finality.reversalWindowDays ?? "?"} days`);
    }
    return { rail: profile.id, score, quote, finality: profile.finality, matchReasons };
  });

  scored.sort((a, b) => b.score - a.score || a.quote.costCents - b.quote.costCents);
  return { intentId: intent.id, chosenRail: scored[0]!.rail, scored, rejected };
}

// ---- the cross-rail ledger -------------------------------------------------

export type AfpTransactionStatus =
  | "pending" // routed, execution requested, rail hasn't confirmed yet
  | "settled" // final — money has actually moved and cannot un-move (instant), or the settlement delay has elapsed
  | "posted" // execution succeeded but finality carries a standing reversal window — not yet "safe to treat as done"
  | "reversed" // a posted transaction was clawed back (chargeback, dispute) — the compensating entry
  | "failed" // execution never took effect; no compensation needed, nothing moved
  | "reconciling"; // execution's outcome is ambiguous (e.g. a timeout after the rail may have already run) — needs a status check before it can resolve

export interface AfpTransaction {
  id: string;
  intentId: string;
  accountHolderId: string;
  rail: RailId;
  amount: number;
  currency: Currency;
  status: AfpTransactionStatus;
  finality: RailFinality;
  /** The rail's own reference for this payment (its transaction id / tx hash / payment token) — never invented, only ever what the rail returned. */
  railReference?: string;
  /** The idempotency key this execution was requested under — a second request with the same key returns this same transaction, never a duplicate. */
  idempotencyKey: string;
  createdAt: string;
  updatedAt: string;
  /** Set once a reversal_window transaction's window has genuinely elapsed with no reversal, or a settlement_delay's delay has elapsed. */
  settledAt?: string;
  /** Set on reversed — why, and (for a card-style rail) the network's own reference for the reversal. */
  reversalReason?: string;
  /** History of every status transition, for audit — same discipline as A-CARD's own transaction/event log. */
  history: Array<{ status: AfpTransactionStatus; at: string; note?: string }>;
}

export interface RailExecutionResult {
  railReference: string;
  /** Did the rail itself consider this done immediately, or is it still in flight? Independent of `finality` — a "done" x402 payment is still only as final as its rail's finality kind says. */
  immediate: boolean;
}

/**
 * The ledger every rail's outcome gets posted into. Synchronous and
 * in-memory here (the sandbox and single-writer snapshot path); a
 * Postgres-backed implementation is the natural next step once this needs
 * to run multi-instance, following the exact adapter-port pattern
 * `MerchantDirectory`/`apps/api/src/merchant/postgres.ts` already
 * established for A-MERCHANT.
 */
export class AfpLedger {
  private readonly intents = new Map<string, AfpIntent>();
  private readonly transactions = new Map<string, AfpTransaction>();
  /** idempotencyKey -> transaction id, so a repeated execution request is a lookup, never a second write. */
  private readonly byIdempotencyKey = new Map<string, string>();

  /** Records a routed intent so `/execute` can reference it by id instead of the caller resending the full payload. */
  recordIntent(intent: AfpIntent): void {
    this.intents.set(intent.id, intent);
  }

  getIntent(id: string): AfpIntent {
    const intent = this.intents.get(id);
    if (!intent) throw new NotFoundError("AFP intent", id);
    return intent;
  }

  /**
   * Records that execution was *requested* — before the rail adapter is
   * even called. This is what makes the "network call succeeded but the
   * ledger write never happened" failure mode impossible: the pending
   * record exists first, and everything downstream only ever transitions it.
   */
  beginExecution(intent: AfpIntent, rail: RailId, finality: RailFinality, idempotencyKey: string): AfpTransaction {
    const existingId = this.byIdempotencyKey.get(idempotencyKey);
    if (existingId) return this.get(existingId);

    const now = new Date().toISOString();
    const tx: AfpTransaction = {
      id: newId("afptx"),
      intentId: intent.id,
      accountHolderId: intent.accountHolderId,
      rail,
      amount: intent.amount,
      currency: intent.currency,
      status: "pending",
      finality,
      idempotencyKey,
      createdAt: now,
      updatedAt: now,
      history: [{ status: "pending", at: now }],
    };
    this.transactions.set(tx.id, tx);
    this.byIdempotencyKey.set(idempotencyKey, tx.id);
    return tx;
  }

  /**
   * The rail adapter returned a result. Idempotent by the transaction's own
   * idempotency key — completing an already-completed transaction with the
   * same key is a no-op returning the existing record, never a second
   * posting. Completing one with a *different* result than what's on file
   * is refused outright: that's not a retry, that's two different answers
   * about what happened to the same money, and this ledger will not guess
   * which one is true.
   */
  completeExecution(transactionId: string, result: RailExecutionResult): AfpTransaction {
    const tx = this.get(transactionId);
    if (tx.status !== "pending" && tx.status !== "reconciling") {
      if (tx.railReference === result.railReference) return tx; // already recorded, same outcome — safe replay
      throw new InvalidStateError(
        `transaction ${transactionId} is already ${tx.status} with reference ${tx.railReference}; refusing to overwrite with ${result.railReference}`,
      );
    }
    const now = new Date().toISOString();
    // instant finality is settled the moment the rail confirms; the other
    // two kinds are only "posted" — a claim, not yet an irrevocable fact —
    // until their own clock (the reversal window, or the settlement delay)
    // actually elapses. See settle()/reverse() below.
    const status: AfpTransactionStatus = tx.finality.kind === "instant" ? "settled" : "posted";
    const next: AfpTransaction = {
      ...tx,
      status,
      railReference: result.railReference,
      updatedAt: now,
      settledAt: status === "settled" ? now : undefined,
      history: [...tx.history, { status, at: now, note: `rail reference ${result.railReference}` }],
    };
    this.transactions.set(tx.id, next);
    return next;
  }

  /** Execution's outcome is genuinely unknown (a timeout, a dropped connection after the request left) — parks the transaction for a status check rather than guessing. */
  markReconciling(transactionId: string, note: string): AfpTransaction {
    return this.transition(transactionId, "reconciling", ["pending"], note);
  }

  /** Execution never took effect — no money moved, nothing to compensate. */
  markFailed(transactionId: string, note: string): AfpTransaction {
    return this.transition(transactionId, "failed", ["pending", "reconciling"], note);
  }

  /**
   * A `reversal_window` or `settlement_delay` transaction's clock has
   * genuinely elapsed with nothing else happening — now it really is final.
   */
  settle(transactionId: string): AfpTransaction {
    const tx = this.get(transactionId);
    if (tx.status !== "posted") throw new InvalidStateError(`only a posted transaction can settle (${transactionId} is ${tx.status})`);
    const now = new Date().toISOString();
    const next: AfpTransaction = { ...tx, status: "settled", settledAt: now, updatedAt: now, history: [...tx.history, { status: "settled", at: now }] };
    this.transactions.set(tx.id, next);
    return next;
  }

  /**
   * The compensating transaction: a `posted` payment got clawed back inside
   * its reversal window (a card chargeback, a disputed x402 payment). Only
   * legal on a rail whose finality actually allows it — calling this on an
   * `instant` rail's transaction is refused, because a reversal there isn't
   * a compensation, it's a second, independent transfer AFP hasn't been
   * told about, and pretending otherwise is exactly the kind of guess this
   * ledger is built not to make.
   */
  reverse(transactionId: string, reason: string): AfpTransaction {
    const tx = this.get(transactionId);
    // Checked ahead of the status guard deliberately: an instant-finality
    // transaction never sits in `posted` at all (completeExecution takes it
    // straight to `settled`), so if this ran after the status check it
    // would never fire — the caller would see "only a posted transaction
    // can be reversed" and reasonably wonder why settling it instantly
    // seemed to be the problem, when the real reason is that this rail's
    // finality makes reversal meaningless in the first place.
    if (tx.finality.kind === "instant") {
      throw new DomainError("not_reversible", `${tx.rail} settles instantly — this ledger cannot reverse it, only record a new offsetting transfer`);
    }
    if (tx.status !== "posted") throw new InvalidStateError(`only a posted transaction can be reversed (${transactionId} is ${tx.status})`);
    const now = new Date().toISOString();
    const next: AfpTransaction = {
      ...tx,
      status: "reversed",
      reversalReason: reason,
      updatedAt: now,
      history: [...tx.history, { status: "reversed", at: now, note: reason }],
    };
    this.transactions.set(tx.id, next);
    return next;
  }

  private transition(id: string, to: AfpTransactionStatus, from: AfpTransactionStatus[], note?: string): AfpTransaction {
    const tx = this.get(id);
    if (!from.includes(tx.status)) {
      throw new InvalidStateError(`cannot move transaction ${id} to ${to} from ${tx.status}`);
    }
    const now = new Date().toISOString();
    const next: AfpTransaction = { ...tx, status: to, updatedAt: now, history: [...tx.history, { status: to, at: now, note }] };
    this.transactions.set(id, next);
    return next;
  }

  get(id: string): AfpTransaction {
    const tx = this.transactions.get(id);
    if (!tx) throw new NotFoundError("AFP transaction", id);
    return tx;
  }

  getByIdempotencyKey(key: string): AfpTransaction | undefined {
    const id = this.byIdempotencyKey.get(key);
    return id ? this.transactions.get(id) : undefined;
  }

  list(accountHolderId: string): AfpTransaction[] {
    return [...this.transactions.values()]
      .filter((t) => t.accountHolderId === accountHolderId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /** Transactions whose window has genuinely elapsed and are still `posted` — what a settlement sweep would call `settle()` on. */
  dueForSettlement(now = Date.now()): AfpTransaction[] {
    return [...this.transactions.values()].filter((t) => {
      if (t.status !== "posted") return false;
      if (t.finality.kind === "reversal_window") {
        const windowMs = (t.finality.reversalWindowDays ?? 0) * 24 * 60 * 60 * 1000;
        return Date.parse(t.updatedAt) + windowMs <= now;
      }
      if (t.finality.kind === "settlement_delay") {
        const delayMs = (t.finality.settlesAfterHours ?? 0) * 60 * 60 * 1000;
        return Date.parse(t.updatedAt) + delayMs <= now;
      }
      return false;
    });
  }

  serialize(): { intents: AfpIntent[]; transactions: AfpTransaction[] } {
    return { intents: [...this.intents.values()], transactions: [...this.transactions.values()] };
  }

  static hydrate(snapshot: { intents: AfpIntent[]; transactions: AfpTransaction[] }): AfpLedger {
    const ledger = new AfpLedger();
    for (const intent of snapshot.intents) ledger.intents.set(intent.id, intent);
    for (const tx of snapshot.transactions) {
      ledger.transactions.set(tx.id, tx);
      ledger.byIdempotencyKey.set(tx.idempotencyKey, tx.id);
    }
    return ledger;
  }
}
