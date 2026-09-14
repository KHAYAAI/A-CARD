import { createHmac, timingSafeEqual } from "node:crypto";
import type { AmlRisk, VerificationStatus } from "@acard/core";
import type {
  AmlScreenInput,
  BlocklistEntry,
  BlocklistEntryType,
  ComplianceCase,
  MonitoredTransaction,
  MonitoringOutcome,
  MonitoringStatus,
  AmlScreenResult,
  CompliancePort,
  ProviderDecision,
  RegistryCandidate,
  RegistryRecord,
  StartedVerification,
  StartVerificationInput,
  WebhookEvent,
} from "./types.js";
import type {
  CryptoCompliancePort,
  InboundTransferRecord,
  ScreenableChain,
  Vasp,
  WalletRiskSeverity,
  WalletScreeningResult,
} from "./crypto.js";

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

/** The monitoring engine's own status vocabulary → ours. */
const MONITORING_STATUS_MAP: Record<string, MonitoringStatus> = {
  APPROVED: "approved",
  IN_REVIEW: "in_review",
  DECLINED: "declined",
  AWAITING_USER: "in_review",
};

export function mapMonitoringStatus(raw: string | undefined): MonitoringStatus {
  if (!raw) return "unknown";
  return MONITORING_STATUS_MAP[raw.toUpperCase()] ?? "unknown";
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

  /** Exposed to `DiditCryptoCompliance`, which shares this client's auth and base URL. */
  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
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
  // ---- transaction monitoring ----------------------------------------------

  async submitTransaction(input: MonitoredTransaction): Promise<MonitoringOutcome> {
    const body = await this.request<{
      status?: string;
      score?: number;
      triggered_rules?: Array<{ title?: string } | string>;
    }>("/v2/transactions/", {
      method: "POST",
      body: JSON.stringify({
        transaction_id: input.transactionId,
        transaction_category: "finance",
        transaction_at: input.occurredAt,
        subject: { vendor_data: input.accountHolderId },
        counterparty: { name: input.merchantName, country: input.merchantCountry },
        transaction_details: {
          // A card charge is money leaving the org's wallet, which is what
          // the outbound-velocity and in-and-out presets key on.
          direction: "OUTBOUND",
          amount: input.amount,
          currency: input.currency,
          payment_details: input.merchantName,
        },
        custom_properties: {
          card_id: input.cardId,
          merchant_name: input.merchantName,
          merchant_category: input.merchantCategory,
          sanctions_hit: input.sanctionsHit ?? false,
          pep_counterparty: input.pepCounterparty ?? false,
        },
      }),
    });
    return {
      transactionId: input.transactionId,
      status: mapMonitoringStatus(body.status),
      score: body.score,
      triggeredRules: (body.triggered_rules ?? []).map((r) => (typeof r === "string" ? r : (r.title ?? "rule"))),
    };
  }

  // ---- cases ----------------------------------------------------------------

  async listCases(filter: { status?: string } = {}): Promise<ComplianceCase[]> {
    const query = filter.status ? `?status=${encodeURIComponent(filter.status)}` : "";
    const body = await this.request<{ results?: unknown[] }>(`/v2/cases/${query}`);
    return (body.results ?? []).map((row) => toCase(row as Record<string, unknown>));
  }

  async getCase(caseId: string): Promise<ComplianceCase> {
    return toCase(await this.request<Record<string, unknown>>(`/v2/cases/${encodeURIComponent(caseId)}/`));
  }

  // ---- blocklist ------------------------------------------------------------

  async listBlocklist(): Promise<BlocklistEntry[]> {
    const body = await this.request<{ results?: unknown[] }>("/v2/blocklist/");
    return (body.results ?? []).map((row) => toBlocklistEntry(row as Record<string, unknown>));
  }

  async addToBlocklist(entry: Omit<BlocklistEntry, "addedAt">): Promise<BlocklistEntry> {
    const body = await this.request<Record<string, unknown>>("/v2/blocklist/", {
      method: "POST",
      body: JSON.stringify({ entry_type: entry.entryType, value: entry.value, comment: entry.reason }),
    });
    return toBlocklistEntry(body);
  }

  async isBlocked(
    candidates: Array<{ entryType: BlocklistEntryType; value: string }>,
  ): Promise<BlocklistEntry | undefined> {
    // Read-and-compare rather than a per-candidate lookup: the blocklist is
    // small by nature (it holds the people you have already decided about),
    // and one request at signup beats N.
    const entries = await this.listBlocklist();
    return matchBlocklist(entries, candidates);
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

function toCase(row: Record<string, unknown>): ComplianceCase {
  return {
    caseId: String(row.uuid ?? row.id ?? row.case_id ?? ""),
    status: String(row.status ?? "unknown"),
    title: typeof row.title === "string" ? row.title : undefined,
    subjectId: typeof row.vendor_data === "string" ? row.vendor_data : undefined,
    openedAt: typeof row.created_at === "string" ? row.created_at : undefined,
    updatedAt: typeof row.updated_at === "string" ? row.updated_at : undefined,
  };
}

function toBlocklistEntry(row: Record<string, unknown>): BlocklistEntry {
  return {
    entryType: (row.entry_type ?? "user") as BlocklistEntryType,
    value: String(row.value ?? ""),
    reason: typeof row.comment === "string" ? row.comment : undefined,
    addedAt: typeof row.created_at === "string" ? row.created_at : undefined,
  };
}

/**
 * Shared by both providers so "is this identifier blocked" means exactly one
 * thing. Comparison is case-insensitive and trimmed: a blocklist that misses
 * because someone typed a capital letter is not a blocklist.
 */
export function matchBlocklist(
  entries: BlocklistEntry[],
  candidates: Array<{ entryType: BlocklistEntryType; value: string }>,
): BlocklistEntry | undefined {
  const norm = (v: string) => v.trim().toLowerCase();
  return entries.find((entry) =>
    candidates.some((c) => c.entryType === entry.entryType && norm(c.value) === norm(entry.value)),
  );
}

// ---- crypto compliance (dormant until AFP's crypto rails carry real value) --

/**
 * Travel Rule and wallet screening against Didit.
 *
 * ⚠️ Two things confirmed against the live account rather than assumed:
 * wallet screening returns 409 unless a transaction-monitoring provider key
 * is configured, and the Travel Rule settings endpoint is permission-gated —
 * these credentials are refused outright. So even once AFP's rails are real,
 * turning this on needs a Didit-side provider connection and elevated
 * permissions, not just a code flag. `evaluateCryptoGate` deliberately does
 * not pretend otherwise: it decides whether the obligation *applies*, not
 * whether the account is *provisioned* for it.
 */
export class DiditCryptoCompliance implements CryptoCompliancePort {
  constructor(private readonly request: <T>(path: string, init?: RequestInit) => Promise<T>) {}

  async screenWallet(input: {
    address: string;
    chain: ScreenableChain;
    direction?: "inbound" | "outbound";
  }): Promise<WalletScreeningResult> {
    const body = await this.request<{
      risk_score?: number;
      severity?: string;
      sanctions_hit?: boolean;
      source_of_funds?: Array<{ category?: string; percentage?: number }>;
      destination_of_funds?: Array<{ category?: string; percentage?: number }>;
    }>("/v2/transactions/screen-wallet/", {
      method: "POST",
      body: JSON.stringify({ wallet_address: input.address, blockchain: input.chain, direction: input.direction }),
    });
    const severity = (body.severity ?? "unknown").toLowerCase();
    return {
      address: input.address,
      chain: input.chain,
      riskScore: body.risk_score,
      severity: (["low", "medium", "high", "severe"].includes(severity) ? severity : "unknown") as WalletRiskSeverity,
      sanctionsHit: body.sanctions_hit === true,
      sourceOfFunds: (body.source_of_funds ?? []).map((f) => ({ category: f.category ?? "unknown", percentage: f.percentage })),
      destinationOfFunds: (body.destination_of_funds ?? []).map((f) => ({ category: f.category ?? "unknown", percentage: f.percentage })),
    };
  }

  async searchVasps(search?: string): Promise<Vasp[]> {
    const query = search ? `?search=${encodeURIComponent(search)}` : "";
    const body = await this.request<{ results?: Array<{ name?: string; travel_address?: string; lei?: string; due_diligence_score?: number }> }>(
      `/v2/travel-rule/vasps/${query}`,
    );
    return (body.results ?? []).map((v) => ({
      name: v.name ?? "unknown",
      travelAddress: v.travel_address,
      lei: v.lei,
      dueDiligenceScore: v.due_diligence_score,
    }));
  }

  async registerInboundTransfer(input: InboundTransferRecord): Promise<{ registered: boolean; transferId?: string }> {
    const body = await this.request<{ transaction_id?: string }>("/v2/travel-rule/inbound/", {
      method: "POST",
      body: JSON.stringify({
        txid: input.txid,
        wallet_address: input.walletAddress,
        chain: input.chain,
        currency: input.currency,
        amount: input.amount,
        originating_vasp: input.originatingVasp,
      }),
    });
    return { registered: true, transferId: body.transaction_id };
  }
}
