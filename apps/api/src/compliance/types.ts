import type { AmlRisk, VerificationStatus, VerificationSubject } from "@acard/core";

/**
 * The compliance provider boundary.
 *
 * Two implementations: `DiditComplianceProvider` (didit.ts) talks to the real
 * Didit API; `SandboxComplianceProvider` (sandbox.ts) is deterministic, local,
 * and never bills — the same relationship the mock issuer has to a real BIN
 * sponsor. Every route and every test depends on this interface, never on
 * which one is behind it.
 */

export interface StartVerificationInput {
  subject: VerificationSubject;
  /** Our own id for the subject — Didit calls this `vendor_data` and groups sessions by it. */
  subjectId: string;
  /** Pre-fills the provider's UI so the subject types less. */
  contact?: { email?: string; phone?: string };
  /** Where to send the subject once they are finished. */
  callbackUrl?: string;
  /** Echoed back on every webhook for this session. */
  metadata?: Record<string, string>;
}

export interface StartedVerification {
  providerSessionId: string;
  providerWorkflowId: string;
  verificationUrl: string;
}

/** A provider decision, already translated out of the provider's own vocabulary. */
export interface ProviderDecision {
  providerSessionId: string;
  status: VerificationStatus;
  amlRisk: AmlRisk;
  reasons: string[];
}

export interface AmlScreenInput {
  fullName: string;
  entityType?: "person" | "company";
  dateOfBirth?: string;
  nationality?: string;
  documentNumber?: string;
  includeAdverseMedia?: boolean;
  /** Keep screening after approval — a watchlist someone joins later is the point. */
  ongoingMonitoring?: boolean;
}

export interface AmlScreenResult {
  risk: AmlRisk;
  /** 0–100 where the provider gives one. */
  score?: number;
  matches: Array<{ name: string; listName?: string; matchScore?: number }>;
}

/** One candidate company from a registry search. */
export interface RegistryCandidate {
  providerCandidateId: string;
  name: string;
  registrationNumber?: string;
  status?: string;
  address?: string;
}

export interface RegistryRecord {
  name: string;
  registrationNumber?: string;
  status?: string;
  incorporatedAt?: string;
  address?: string;
  officers: Array<{ name: string; role?: string }>;
  beneficialOwners: Array<{ name: string; ownershipPercent?: number }>;
  raw: unknown;
}

/**
 * A settled card charge, handed to the monitoring engine AFTER the fact.
 *
 * Deliberately not part of the authorization decision: A-CARD answers the
 * issuer inside a ~2-second window, and a network call to a monitoring
 * provider has no place in it. This is the AML layer — pattern detection and
 * reporting over what already happened — sitting alongside the hot-path rules
 * engine, never in front of it.
 */
export interface MonitoredTransaction {
  /** Our own transaction id. The provider dedupes on it. */
  transactionId: string;
  accountHolderId: string;
  cardId: string;
  amount: number;
  currency: string;
  merchantName: string;
  merchantCategory: string;
  merchantCountry?: string;
  occurredAt: string;
  /** Screening signals the rules can act on — see the sanctions/PEP presets. */
  sanctionsHit?: boolean;
  pepCounterparty?: boolean;
}

export type MonitoringStatus = "approved" | "in_review" | "declined" | "unknown";

export interface MonitoringOutcome {
  transactionId: string;
  status: MonitoringStatus;
  /** Cumulative risk score the rules assigned, where the provider gives one. */
  score?: number;
  /** Titles of the rules that fired. */
  triggeredRules: string[];
}

/** An investigation opened by a screening hit or a monitoring rule. */
export interface ComplianceCase {
  caseId: string;
  status: string;
  title?: string;
  /** Our own subject id, when the case is traceable to one. */
  subjectId?: string;
  openedAt?: string;
  updatedAt?: string;
}

export type BlocklistEntryType = "user" | "business" | "email" | "phone" | "document" | "ip_address";

export interface BlocklistEntry {
  entryType: BlocklistEntryType;
  value: string;
  reason?: string;
  addedAt?: string;
}

export interface CompliancePort {
  /** Which provider this is, for logging and for the honesty banner on boot. */
  readonly label: string;
  /** True when decisions are real; false for the deterministic sandbox. */
  readonly isLive: boolean;

  startVerification(input: StartVerificationInput): Promise<StartedVerification>;
  fetchDecision(providerSessionId: string): Promise<ProviderDecision>;

  screenAml(input: AmlScreenInput): Promise<AmlScreenResult>;

  searchRegistry(input: { countryCode: string; name?: string; registrationNumber?: string }): Promise<RegistryCandidate[]>;
  selectRegistryCandidate(providerCandidateId: string): Promise<RegistryRecord>;

  /**
   * Verify a webhook actually came from the provider. Returns the parsed body
   * on success and `undefined` on a bad signature — never throws, so a forged
   * request is a 401 rather than a 500 that pages someone at 3am.
   */
  verifyWebhook(rawBody: string, headers: Record<string, string | undefined>): WebhookEvent | undefined;

  /**
   * Submit a settled charge for monitoring. Never called on the authorization
   * path — see `MonitoredTransaction`.
   */
  submitTransaction(input: MonitoredTransaction): Promise<MonitoringOutcome>;

  /** Investigations the provider opened, for the operator console to read. */
  listCases(filter?: { status?: string }): Promise<ComplianceCase[]>;
  getCase(caseId: string): Promise<ComplianceCase>;

  /** Known-bad identifiers, checked at signup so they are refused before re-screening. */
  listBlocklist(): Promise<BlocklistEntry[]>;
  addToBlocklist(entry: Omit<BlocklistEntry, "addedAt">): Promise<BlocklistEntry>;
  isBlocked(candidates: Array<{ entryType: BlocklistEntryType; value: string }>): Promise<BlocklistEntry | undefined>;
}

export interface WebhookEvent {
  providerSessionId: string;
  status: VerificationStatus;
  amlRisk: AmlRisk;
  reasons: string[];
  /** Our own subject id, echoed back by the provider. */
  subjectId?: string;
}
