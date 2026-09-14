import { createHash } from "node:crypto";
import type { AmlRisk } from "@acard/core";
import { matchBlocklist, parseWebhookBody } from "./didit.js";
import type {
  AmlScreenInput,
  BlocklistEntry,
  BlocklistEntryType,
  ComplianceCase,
  MonitoredTransaction,
  MonitoringOutcome,
  AmlScreenResult,
  CompliancePort,
  ProviderDecision,
  RegistryCandidate,
  RegistryRecord,
  StartedVerification,
  StartVerificationInput,
  WebhookEvent,
} from "./types.js";

/**
 * A deterministic local stand-in for Didit — the same relationship the mock
 * issuer has to a real BIN sponsor. No network, no credentials, no billing,
 * and every outcome is a pure function of the subject id, so a test that
 * wants a sanctions hit just asks for one by name.
 *
 * Deterministic outcome rules, chosen so every branch is reachable from a
 * test without stubbing:
 *   - subject id contains "decline" → Declined
 *   - subject id contains "review"  → In Review
 *   - subject id contains "aml"     → Approved, but a sanctions hit
 *   - subject id contains "match"   → Approved, possible match
 *   - anything else                 → Approved and clear
 *
 * `verifyWebhook` accepts anything here on purpose: there is no secret to
 * check against, and refusing events would make the sandbox untestable. That
 * is exactly why `isLive` is false and why the API logs loudly on boot when
 * this provider is the one mounted.
 */
export class SandboxComplianceProvider implements CompliancePort {
  readonly label = "sandbox (deterministic, no real verification)";
  readonly isLive = false;

  private readonly sessions = new Map<string, { subjectId: string; subject: string }>();
  private readonly transactions = new Map<string, MonitoredTransaction>();
  private readonly merchantsByCard = new Map<string, Set<string>>();
  private readonly cases = new Map<string, ComplianceCase>();
  private readonly blocklist: BlocklistEntry[] = [];

  private outcome(subjectId: string): { status: ProviderDecision["status"]; amlRisk: AmlRisk; reasons: string[] } {
    const id = subjectId.toLowerCase();
    if (id.includes("decline")) return { status: "declined", amlRisk: "clear", reasons: ["sandbox: forced decline"] };
    if (id.includes("review")) return { status: "in_review", amlRisk: "clear", reasons: ["sandbox: forced review"] };
    if (id.includes("aml")) return { status: "approved", amlRisk: "hit", reasons: ["sandbox: forced sanctions hit"] };
    if (id.includes("match")) return { status: "approved", amlRisk: "possible_match", reasons: ["sandbox: forced possible match"] };
    return { status: "approved", amlRisk: "clear", reasons: [] };
  }

  async startVerification(input: StartVerificationInput): Promise<StartedVerification> {
    // Deterministic session id: the same subject asked twice gets the same
    // session, mirroring the real provider's vendor_data grouping.
    const providerSessionId = `sbx_${createHash("sha256").update(`${input.subject}:${input.subjectId}`).digest("hex").slice(0, 24)}`;
    this.sessions.set(providerSessionId, { subjectId: input.subjectId, subject: input.subject });
    return {
      providerSessionId,
      providerWorkflowId: input.subject === "merchant" ? "sandbox_kyb" : "sandbox_kyc",
      verificationUrl: `https://sandbox.invalid/verify/${providerSessionId}`,
    };
  }

  async fetchDecision(providerSessionId: string): Promise<ProviderDecision> {
    const session = this.sessions.get(providerSessionId);
    if (!session) throw new Error(`sandbox: unknown session ${providerSessionId}`);
    return { providerSessionId, ...this.outcome(session.subjectId) };
  }

  async screenAml(input: AmlScreenInput): Promise<AmlScreenResult> {
    const { amlRisk } = this.outcome(input.fullName);
    return {
      risk: amlRisk,
      score: amlRisk === "clear" ? 0 : 85,
      matches:
        amlRisk === "clear" ? [] : [{ name: input.fullName, listName: "SANDBOX-LIST", matchScore: 85 }],
    };
  }

  async searchRegistry(input: { countryCode: string; name?: string; registrationNumber?: string }): Promise<RegistryCandidate[]> {
    const name = input.name ?? "Sandbox Holdings";
    return [
      {
        providerCandidateId: `sbxkyb_${createHash("sha256").update(name).digest("hex").slice(0, 16)}`,
        name,
        registrationNumber: input.registrationNumber ?? "2019/123456/07",
        status: "active",
        address: `1 Sandbox Road, ${input.countryCode}`,
      },
    ];
  }

  async selectRegistryCandidate(providerCandidateId: string): Promise<RegistryRecord> {
    return {
      name: "Sandbox Holdings (Pty) Ltd",
      registrationNumber: "2019/123456/07",
      status: "active",
      incorporatedAt: "2019-04-01",
      address: "1 Sandbox Road, Johannesburg",
      officers: [{ name: "Thandi Nkosi", role: "director" }],
      beneficialOwners: [{ name: "Thandi Nkosi", ownershipPercent: 100 }],
      raw: { providerCandidateId, sandbox: true },
    };
  }

  verifyWebhook(rawBody: string): WebhookEvent | undefined {
    return parseWebhookBody(rawBody);
  }

  // ---- transaction monitoring ----------------------------------------------

  /**
   * Deterministic stand-in for the rules engine, mirroring the shape of the
   * presets actually installed: a large round amount reviews, a sanctions or
   * PEP signal declines, and one card fanning out across many merchants in a
   * short window reviews. Enough to exercise every branch of the calling code
   * without a network round trip.
   */
  async submitTransaction(input: MonitoredTransaction): Promise<MonitoringOutcome> {
    const seen = this.merchantsByCard.get(input.cardId) ?? new Set<string>();
    seen.add(input.merchantName);
    this.merchantsByCard.set(input.cardId, seen);
    this.transactions.set(input.transactionId, input);

    const triggeredRules: string[] = [];
    let status: MonitoringOutcome["status"] = "approved";
    let score = 0;

    if (input.sanctionsHit) {
      triggeredRules.push("Sanctions counterparty");
      status = "declined";
      score += 90;
    }
    if (input.pepCounterparty) {
      triggeredRules.push("PEP counterparty exposure");
      if (status !== "declined") status = "in_review";
      score += 40;
    }
    if (ROUND_AMOUNTS.has(input.amount)) {
      triggeredRules.push("Round-amount layering");
      score += 20;
    }
    if (seen.size >= 8) {
      triggeredRules.push("Agent card merchant fan-out");
      if (status !== "declined") status = "in_review";
      score += 55;
      this.cases.set(`sbxcase_${input.cardId}`, {
        caseId: `sbxcase_${input.cardId}`,
        status: "open",
        title: `Agent card merchant fan-out — ${input.cardId}`,
        subjectId: input.accountHolderId,
        openedAt: new Date().toISOString(),
      });
    }
    return { transactionId: input.transactionId, status, score, triggeredRules };
  }

  // ---- cases ----------------------------------------------------------------

  async listCases(filter: { status?: string } = {}): Promise<ComplianceCase[]> {
    return [...this.cases.values()].filter((c) => !filter.status || c.status === filter.status);
  }

  async getCase(caseId: string): Promise<ComplianceCase> {
    const found = this.cases.get(caseId);
    if (!found) throw new Error(`sandbox: unknown case ${caseId}`);
    return found;
  }

  // ---- blocklist ------------------------------------------------------------

  async listBlocklist(): Promise<BlocklistEntry[]> {
    return [...this.blocklist];
  }

  async addToBlocklist(entry: Omit<BlocklistEntry, "addedAt">): Promise<BlocklistEntry> {
    const stored: BlocklistEntry = { ...entry, addedAt: new Date().toISOString() };
    this.blocklist.push(stored);
    return stored;
  }

  async isBlocked(
    candidates: Array<{ entryType: BlocklistEntryType; value: string }>,
  ): Promise<BlocklistEntry | undefined> {
    // Same matcher the real provider uses, so "blocked" means one thing.
    return matchBlocklist(this.blocklist, candidates);
  }
}

/** The amounts the round-amount-layering preset keys on, in minor units. */
const ROUND_AMOUNTS = new Set([
  1_000_000, 1_500_000, 2_000_000, 2_500_000, 5_000_000, 7_500_000, 10_000_000, 25_000_000, 50_000_000, 100_000_000,
]);
