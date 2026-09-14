import { createHmac, timingSafeEqual } from "node:crypto";
import type { AmlRisk, VerificationStatus } from "@acard/core";
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
 * Didit — the KYC/KYB/AML provider.
 *
 * What is VERIFIED against the live API (checked September 2026, against this
 * org's own account, not from documentation alone):
 *
 *   - The session status vocabulary below is Didit's own, exactly as their
 *     API enumerates it: Not Started, In Progress, In Review, Approved,
 *     Declined, Expired, Abandoned, Kyc Expired, Resubmitted, Awaiting User.
 *   - The AML response shape — `{ aml: { status, total_hits, hits[], score,
 *     warnings[] } }` — was observed from a real screening call.
 *   - `nationality` is ISO 3166-1 **alpha-2**, not alpha-3. The alpha-3 code
 *     is rejected outright. (The ID-verification catalog, confusingly, keys
 *     countries by alpha-3 and the KYB registry catalog by alpha-2.)
 *   - The South African ID lookup source is `zaf_africa_national_id`, backed
 *     by the Department of Home Affairs at ~100% coverage, and it needs a
 *     selfie because it face-matches against the registry portrait.
 *
 * ⚠️ What is NOT verified and needs confirming against Didit's API reference
 * before this carries real verifications: the REST base URL and paths below,
 * and the webhook signature scheme in `verifyWebhook`. Both are isolated here
 * deliberately — the same containment `sudo.ts` uses for the card issuer — so
 * correcting them is a small edit rather than a rewrite. Everything that
 * depends on this file depends on `CompliancePort`, not on these paths.
 */

/** Didit's own session vocabulary → ours. Anything unrecognised is treated as pending, never as approved. */
const STATUS_MAP: Record<string, VerificationStatus> = {
  "Not Started": "not_started",
  "In Progress": "pending",
  "Awaiting User": "pending",
  Resubmitted: "pending",
  "In Review": "in_review",
  Approved: "approved",
  Declined: "declined",
  Expired: "expired",
  "Kyc Expired": "expired",
  Abandoned: "expired",
};

export function mapDiditStatus(raw: string | undefined): VerificationStatus {
  if (!raw) return "pending";
  // Defaulting an unknown status to `pending` rather than `approved` is the
  // whole safety property here: a provider that adds a status we have never
  // seen must never accidentally unlock money movement.
  return STATUS_MAP[raw] ?? "pending";
}

/** The AML block's own status, which is scored separately from the identity decision. */
export function mapAmlRisk(aml: { status?: string; total_hits?: number } | undefined): AmlRisk {
  if (!aml) return "not_screened";
  if (aml.status === "Declined") return "hit";
  if (aml.status === "In Review") return "possible_match";
  if (aml.status === "Approved") return (aml.total_hits ?? 0) > 0 ? "possible_match" : "clear";
  return "not_screened";
}

export interface DiditConfig {
  apiKey: string;
  /** The KYC workflow for account holders. */
  kycWorkflowId: string;
  /** The KYB workflow for merchants. */
  kybWorkflowId: string;
  /** Verifies inbound webhooks. */
  webhookSecret?: string;
  /** Override for testing or a future API version. */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

const DEFAULT_BASE_URL = "https://verification.didit.me";

export class DiditComplianceProvider implements CompliancePort {
  readonly label = "Didit";
  readonly isLive = true;

  private readonly baseUrl: string;
  private readonly doFetch: typeof fetch;

  constructor(private readonly config: DiditConfig) {
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.doFetch = config.fetchImpl ?? fetch;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await this.doFetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        "x-api-key": this.config.apiKey,
        "content-type": "application/json",
        ...(init.headers ?? {}),
      },
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const detail = typeof body.detail === "string" ? body.detail : JSON.stringify(body);
      throw new Error(`didit ${path} failed (${res.status}): ${detail}`);
    }
    return body as T;
  }

  async startVerification(input: StartVerificationInput): Promise<StartedVerification> {
    const workflowId = input.subject === "merchant" ? this.config.kybWorkflowId : this.config.kycWorkflowId;
    const body = await this.request<{ session_id: string; url: string }>("/v2/session/", {
      method: "POST",
      body: JSON.stringify({
        workflow_id: workflowId,
        // Didit groups sessions by vendor_data, so passing our own subject id
        // means a returning subject's history is already linked on their side.
        vendor_data: input.subjectId,
        contact_details: input.contact,
        callback: input.callbackUrl,
        metadata: { ...input.metadata, acard_subject: input.subject, acard_subject_id: input.subjectId },
      }),
    });
    return { providerSessionId: body.session_id, providerWorkflowId: workflowId, verificationUrl: body.url };
  }

  async fetchDecision(providerSessionId: string): Promise<ProviderDecision> {
    const body = await this.request<{
      status?: string;
      aml?: { status?: string; total_hits?: number; hits?: unknown[] };
      warnings?: Array<{ risk?: string; additional_data?: string } | string>;
    }>(`/v2/session/${encodeURIComponent(providerSessionId)}/decision/`);

    return {
      providerSessionId,
      status: mapDiditStatus(body.status),
      amlRisk: mapAmlRisk(body.aml),
      reasons: (body.warnings ?? []).map((w) => (typeof w === "string" ? w : (w.risk ?? w.additional_data ?? "warning"))),
    };
  }

  async screenAml(input: AmlScreenInput): Promise<AmlScreenResult> {
    const body = await this.request<{
      aml?: {
        status?: string;
        total_hits?: number;
        score?: number;
        hits?: Array<{ name?: string; list_name?: string; match_score?: number }>;
      };
    }>("/v2/aml/", {
      method: "POST",
      body: JSON.stringify({
        full_name: input.fullName,
        entity_type: input.entityType ?? "person",
        date_of_birth: input.dateOfBirth,
        // Alpha-2 only — alpha-3 is rejected by the API. See the header note.
        nationality: input.nationality,
        document_number: input.documentNumber,
        include_adverse_media: input.includeAdverseMedia,
        include_ongoing_monitoring: input.ongoingMonitoring,
      }),
    });
    return {
      risk: mapAmlRisk(body.aml),
      score: body.aml?.score,
      matches: (body.aml?.hits ?? []).map((h) => ({
        name: h.name ?? "unknown",
        listName: h.list_name,
        matchScore: h.match_score,
      })),
    };
  }

  async searchRegistry(input: {
    countryCode: string;
    name?: string;
    registrationNumber?: string;
  }): Promise<RegistryCandidate[]> {
    const body = await this.request<{
      results?: Array<{ kyb_response_id?: string; name?: string; registration_number?: string; status?: string; address?: string }>;
    }>("/v2/kyb/search/", {
      method: "POST",
      body: JSON.stringify({
        country_code: input.countryCode,
        name: input.name,
        registration_number: input.registrationNumber,
      }),
    });
    return (body.results ?? []).map((r) => ({
      providerCandidateId: r.kyb_response_id ?? "",
      name: r.name ?? "unknown",
      registrationNumber: r.registration_number,
      status: r.status,
      address: r.address,
    }));
  }

  async selectRegistryCandidate(providerCandidateId: string): Promise<RegistryRecord> {
    const body = await this.request<{
      name?: string;
      registration_number?: string;
      status?: string;
      incorporation_date?: string;
      address?: string;
      officers?: Array<{ name?: string; role?: string }>;
      beneficial_owners?: Array<{ name?: string; ownership_percentage?: number }>;
    }>("/v2/kyb/select/", {
      method: "POST",
      body: JSON.stringify({ kyb_response_id: providerCandidateId }),
    });
    return {
      name: body.name ?? "unknown",
      registrationNumber: body.registration_number,
      status: body.status,
      incorporatedAt: body.incorporation_date,
      address: body.address,
      officers: (body.officers ?? []).map((o) => ({ name: o.name ?? "unknown", role: o.role })),
      beneficialOwners: (body.beneficial_owners ?? []).map((o) => ({
        name: o.name ?? "unknown",
        ownershipPercent: o.ownership_percentage,
      })),
      raw: body,
    };
  }

  /**
   * ⚠️ Unverified wire detail: the header names and the exact signing string.
   * Implemented as HMAC-SHA256 over the raw body, compared timing-safely,
   * with a replay window — the same scheme A-CARD's own issuer webhook uses,
   * because it is the near-universal shape. Confirm against Didit's webhook
   * reference before this is trusted in production; a wrong scheme fails
   * closed (every event rejected), which is the safe direction to be wrong in.
   */
  verifyWebhook(rawBody: string, headers: Record<string, string | undefined>): WebhookEvent | undefined {
    const secret = this.config.webhookSecret;
    if (!secret) return undefined;

    const signature = headers["x-signature"] ?? headers["x-didit-signature"];
    const timestamp = headers["x-timestamp"] ?? headers["x-didit-timestamp"];
    if (!signature) return undefined;

    if (timestamp) {
      const skewSeconds = Math.abs(Date.now() / 1000 - Number(timestamp));
      if (!Number.isFinite(skewSeconds) || skewSeconds > 300) return undefined;
    }

    const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
    const given = Buffer.from(signature, "utf8");
    const mine = Buffer.from(expected, "utf8");
    if (given.length !== mine.length || !timingSafeEqual(given, mine)) return undefined;

    return parseWebhookBody(rawBody);
  }
}

/** Exported so the sandbox provider and the tests parse an event the identical way. */
export function parseWebhookBody(rawBody: string): WebhookEvent | undefined {
  try {
    const body = JSON.parse(rawBody) as {
      session_id?: string;
      status?: string;
      aml?: { status?: string; total_hits?: number };
      vendor_data?: string;
      warnings?: Array<{ risk?: string } | string>;
    };
    if (!body.session_id) return undefined;
    return {
      providerSessionId: body.session_id,
      status: mapDiditStatus(body.status),
      amlRisk: mapAmlRisk(body.aml),
      reasons: (body.warnings ?? []).map((w) => (typeof w === "string" ? w : (w.risk ?? "warning"))),
      subjectId: body.vendor_data,
    };
  } catch {
    return undefined;
  }
}
