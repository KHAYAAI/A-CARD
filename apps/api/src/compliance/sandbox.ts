import { createHash } from "node:crypto";
import type { AmlRisk } from "@acard/core";
import { parseWebhookBody } from "./didit.js";
import type {
  AmlScreenInput,
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
}
