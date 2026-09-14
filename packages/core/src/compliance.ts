import { DomainError, InvalidStateError, NotFoundError } from "./errors.js";
import { newId } from "./ids.js";

/**
 * Compliance — KYC, KYB and AML state, as A-CARD's own record of it.
 *
 * The verification itself is somebody else's job. Didit runs the document
 * scan, the Home Affairs lookup, the liveness check, the CIPC registry pull
 * and the sanctions screening; this module is the platform's own ledger of
 * *what was decided, by whom, and when* — the thing that has to survive a
 * regulator asking "why did you let this account move money in March".
 *
 * Three decisions worth reading before changing anything:
 *
 * 1. **A provider decision and an operator decision are different records.**
 *    `providerDecision` is what Didit returned. `override` is what a human at
 *    A-CARD decided afterwards, with their name attached. Collapsing the two
 *    into one mutable status would destroy exactly the audit trail this
 *    exists to keep — you could no longer tell an automated approval from a
 *    human one, which is the first question anyone reviewing a bad account
 *    will ask.
 *
 * 2. **Gating is computed, never stored.** `canFund`/`canIssueCards` derive
 *    from the current record every time they are called. A stored boolean
 *    goes stale the moment a sanctions hit arrives on an account that was
 *    approved last month, and ongoing monitoring means that happens.
 *
 * 3. **Nothing here blocks anything by default.** A deployment with no
 *    compliance provider configured has no records, and the gate helpers are
 *    only consulted when the API is wired with a provider (see
 *    apps/api/src/compliance). Turning verification on is a deployment
 *    decision, the same discipline AFP follows — except here the reason is
 *    the reverse: switching it on *restricts* what existing accounts can do,
 *    and that must never happen by accident.
 */

/** Who is being verified. A person takes KYC; a business takes KYB. */
export type VerificationSubject = "account_holder" | "merchant";

/**
 * Mirrors Didit's own session vocabulary rather than inventing a parallel one
 * — a status here should mean exactly what it means in their console, so an
 * operator comparing the two never has to translate.
 */
export type VerificationStatus =
  | "not_started"
  | "pending" // session created, subject has not finished it
  | "in_review" // provider wants a human to look
  | "approved"
  | "declined"
  | "expired";

/** Screening outcome, independent of the identity decision. */
export type AmlRisk = "not_screened" | "clear" | "possible_match" | "hit";

/** A human decision recorded on top of the provider's. */
export interface ComplianceOverride {
  status: Extract<VerificationStatus, "approved" | "declined">;
  /** Required. A compliance decision with no name attached to it is not a control. */
  decidedBy: string;
  reason: string;
  decidedAt: string;
}

export interface VerificationRecord {
  id: string;
  subject: VerificationSubject;
  /** Account holder id, or merchant id. */
  subjectId: string;
  /** The provider's session id, once one exists. */
  providerSessionId?: string;
  /** The provider workflow this ran against — different for KYC and KYB. */
  providerWorkflowId?: string;
  /** Where to send the subject to complete verification. */
  verificationUrl?: string;
  /** What the provider decided. */
  providerDecision: VerificationStatus;
  /** Sanctions/PEP/adverse-media outcome, tracked separately from identity. */
  amlRisk: AmlRisk;
  /** Free-text reasons the provider gave — decline codes, review triggers. */
  providerReasons: string[];
  /** A human decision layered on top, never replacing `providerDecision`. */
  override?: ComplianceOverride;
  createdAt: string;
  updatedAt: string;
  /** Every status transition, append-only. */
  history: Array<{ status: VerificationStatus; at: string; source: "provider" | "operator"; note?: string }>;
}

/** The status that actually governs, once a human override is taken into account. */
export function effectiveStatus(record: VerificationRecord): VerificationStatus {
  return record.override?.status ?? record.providerDecision;
}

/**
 * Whether this subject may move real money.
 *
 * A sanctions hit blocks regardless of the identity decision: being
 * confidently, verifiably the right person is not a reason to let a
 * sanctioned party fund a wallet. An operator override can clear a *hit*
 * (that is what the override is for — a false positive on a common name),
 * but it has to be an explicit, attributed decision rather than a side
 * effect of the identity check passing.
 */
export function canMoveMoney(record: VerificationRecord | undefined): boolean {
  if (!record) return false;
  if (effectiveStatus(record) !== "approved") return false;
  if (record.amlRisk === "hit" && !record.override) return false;
  return true;
}

export interface SerializedComplianceService {
  records: VerificationRecord[];
}

export class ComplianceService {
  private readonly records = new Map<string, VerificationRecord>();
  /** `${subject}:${subjectId}` → record id. One live record per subject. */
  private readonly bySubject = new Map<string, string>();
  private readonly byProviderSession = new Map<string, string>();

  private key(subject: VerificationSubject, subjectId: string): string {
    return `${subject}:${subjectId}`;
  }

  /**
   * Open (or return) the verification record for a subject. Idempotent by
   * subject: asking twice while one is already in flight hands back the same
   * record rather than starting a second session the subject would have to
   * complete separately — and, on a live provider, pay for twice.
   */
  open(subject: VerificationSubject, subjectId: string): VerificationRecord {
    const existing = this.find(subject, subjectId);
    if (existing) return existing;
    const now = new Date().toISOString();
    const record: VerificationRecord = {
      id: newId("ver"),
      subject,
      subjectId,
      providerDecision: "not_started",
      amlRisk: "not_screened",
      providerReasons: [],
      createdAt: now,
      updatedAt: now,
      history: [{ status: "not_started", at: now, source: "provider" }],
    };
    this.records.set(record.id, record);
    this.bySubject.set(this.key(subject, subjectId), record.id);
    return record;
  }

  /** Attach the provider's session once it has been created. */
  attachSession(
    id: string,
    session: { providerSessionId: string; providerWorkflowId: string; verificationUrl?: string },
  ): VerificationRecord {
    const record = this.get(id);
    if (record.providerSessionId && record.providerSessionId !== session.providerSessionId) {
      throw new InvalidStateError(
        `verification ${id} is already bound to provider session ${record.providerSessionId}`,
      );
    }
    const next: VerificationRecord = {
      ...record,
      ...session,
      providerDecision: record.providerDecision === "not_started" ? "pending" : record.providerDecision,
      updatedAt: new Date().toISOString(),
    };
    if (record.providerDecision === "not_started") {
      next.history = [...record.history, { status: "pending", at: next.updatedAt, source: "provider" }];
    }
    this.records.set(id, next);
    this.byProviderSession.set(session.providerSessionId, id);
    return next;
  }

  /**
   * Record what the provider decided. Safe to replay — the same decision
   * arriving twice (a webhook redelivery) is a no-op rather than a second
   * history entry, because webhook delivery is at-least-once and a duplicated
   * audit trail is a corrupted one.
   */
  recordProviderDecision(
    id: string,
    decision: { status: VerificationStatus; amlRisk?: AmlRisk; reasons?: string[] },
  ): VerificationRecord {
    const record = this.get(id);
    const amlRisk = decision.amlRisk ?? record.amlRisk;
    const unchanged = record.providerDecision === decision.status && record.amlRisk === amlRisk;
    if (unchanged) return record;

    const now = new Date().toISOString();
    const next: VerificationRecord = {
      ...record,
      providerDecision: decision.status,
      amlRisk,
      providerReasons: decision.reasons ?? record.providerReasons,
      updatedAt: now,
      history: [...record.history, { status: decision.status, at: now, source: "provider" }],
    };
    this.records.set(id, next);
    return next;
  }

  /**
   * A human at A-CARD deciding differently from the provider — clearing a
   * false-positive sanctions match, or declining someone the automation
   * passed. Layered on top of the provider's decision, never replacing it.
   */
  override(id: string, override: Omit<ComplianceOverride, "decidedAt">): VerificationRecord {
    const record = this.get(id);
    if (!override.decidedBy) throw new DomainError("reviewer_required", "a compliance override must name its reviewer");
    if (!override.reason) throw new DomainError("reason_required", "a compliance override must record why");
    const now = new Date().toISOString();
    const next: VerificationRecord = {
      ...record,
      override: { ...override, decidedAt: now },
      updatedAt: now,
      history: [...record.history, { status: override.status, at: now, source: "operator", note: override.reason }],
    };
    this.records.set(id, next);
    return next;
  }

  get(id: string): VerificationRecord {
    const record = this.records.get(id);
    if (!record) throw new NotFoundError("verification record", id);
    return record;
  }

  find(subject: VerificationSubject, subjectId: string): VerificationRecord | undefined {
    const id = this.bySubject.get(this.key(subject, subjectId));
    return id ? this.records.get(id) : undefined;
  }

  findByProviderSession(providerSessionId: string): VerificationRecord | undefined {
    const id = this.byProviderSession.get(providerSessionId);
    return id ? this.records.get(id) : undefined;
  }

  list(filter: { subject?: VerificationSubject; status?: VerificationStatus } = {}): VerificationRecord[] {
    return [...this.records.values()]
      .filter((r) => (!filter.subject || r.subject === filter.subject) && (!filter.status || effectiveStatus(r) === filter.status))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Everything a human still has to look at — the compliance queue. */
  pendingReview(): VerificationRecord[] {
    return [...this.records.values()]
      .filter((r) => !r.override && (r.providerDecision === "in_review" || r.amlRisk === "possible_match" || r.amlRisk === "hit"))
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  }

  serialize(): SerializedComplianceService {
    return { records: [...this.records.values()] };
  }

  static hydrate(snapshot: SerializedComplianceService): ComplianceService {
    const service = new ComplianceService();
    for (const record of snapshot.records ?? []) {
      service.records.set(record.id, record);
      service.bySubject.set(service.key(record.subject, record.subjectId), record.id);
      if (record.providerSessionId) service.byProviderSession.set(record.providerSessionId, record.id);
    }
    return service;
  }
}
