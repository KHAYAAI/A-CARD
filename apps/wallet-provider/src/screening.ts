import { ProviderError } from "./errors.js";
import type { Chain } from "./types.js";

/**
 * Checks run before a transfer is signed: wallet screening (sanctions and
 * risk of the destination) and the FATF Travel Rule (originator and
 * beneficiary details above a threshold). Both fail closed: if the screening
 * provider can't be reached, the transfer is refused, not waved through.
 */
export type Severity = "low" | "medium" | "high" | "severe" | "unknown";

export interface ScreenResult {
  sanctionsHit: boolean;
  severity: Severity;
  riskScore?: number;
}

export interface Screener {
  readonly name: string;
  screen(address: string, chain: Chain): Promise<ScreenResult>;
}

export interface TravelRuleInfo {
  originatorName: string;
  beneficiaryName: string;
  /** Set when the destination is held at another exchange or custodian. */
  beneficiaryVasp?: string;
}

/** Didit names assets, not networks. Base and other EVM L2s use ETH. */
const DIDIT_CHAIN: Record<Chain, string> = { ethereum: "ETH", polygon: "MATIC", solana: "SOL" };

/** Didit transaction-monitoring wallet screening (POST /v2/transactions/screen-wallet/). */
export class DiditScreener implements Screener {
  readonly name = "didit";
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl = "https://verification.didit.me",
    private readonly doFetch: typeof fetch = fetch,
  ) {}
  async screen(address: string, chain: Chain): Promise<ScreenResult> {
    const res = await this.doFetch(`${this.baseUrl.replace(/\/$/, "")}/v2/transactions/screen-wallet/`, {
      method: "POST",
      headers: { "x-api-key": this.apiKey, "content-type": "application/json" },
      body: JSON.stringify({ wallet_address: address, blockchain: DIDIT_CHAIN[chain], direction: "outbound" }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`screening returned ${res.status}`);
    const b = (await res.json()) as { sanctions_hit?: boolean; severity?: string; risk_score?: number; status?: string };
    if (b.status && b.status !== "SCREENED") throw new Error(`screening status ${b.status}`);
    const s = (b.severity ?? "unknown").toLowerCase();
    return { sanctionsHit: b.sanctions_hit === true, severity: (["low", "medium", "high", "severe"].includes(s) ? s : "unknown") as Severity, riskScore: b.risk_score };
  }
}

export interface ComplianceConfig {
  screener?: Screener;
  /** Block destinations at or above this severity. Default "high". */
  blockAt?: Exclude<Severity, "unknown">;
  /** "unknown" means screened but no history (normal for new wallets). Allowed unless this is true. */
  blockUnknown?: boolean;
  /** Transfers at or above this (USDC base units) need Travel Rule details. */
  travelRuleThreshold?: bigint;
}

const RANK: Record<Exclude<Severity, "unknown">, number> = { low: 1, medium: 2, high: 3, severe: 4 };

export async function checkTransfer(cfg: ComplianceConfig, chain: Chain, to: string, amount: bigint, travel?: TravelRuleInfo): Promise<{ screening?: ScreenResult & { by: string }; travelRule: boolean }> {
  let travelRule = false;
  if (cfg.travelRuleThreshold !== undefined && amount >= cfg.travelRuleThreshold) {
    const ok = (s?: string) => typeof s === "string" && s.trim().length >= 2 && s.length <= 200;
    if (!travel || !ok(travel.originatorName) || !ok(travel.beneficiaryName) || (travel.beneficiaryVasp !== undefined && !ok(travel.beneficiaryVasp)))
      throw new ProviderError(422, "travel_rule_required", `transfers of ${Number(cfg.travelRuleThreshold) / 1e6} USDC or more need travelRule.originatorName and travelRule.beneficiaryName`);
    travelRule = true;
  }
  if (!cfg.screener) return { travelRule };
  let r: ScreenResult;
  try {
    r = await cfg.screener.screen(to, chain);
  } catch (e) {
    throw new ProviderError(503, "screening_unavailable", `destination could not be screened, so the transfer was not sent: ${(e as Error).message}`);
  }
  if (r.sanctionsHit) throw new ProviderError(403, "destination_blocked", "destination wallet matches a sanctions list");
  if (r.severity === "unknown") {
    if (cfg.blockUnknown) throw new ProviderError(403, "destination_blocked", "destination wallet has no risk history and unknown wallets are blocked");
  } else if (RANK[r.severity] >= RANK[cfg.blockAt ?? "high"]) throw new ProviderError(403, "destination_blocked", `destination wallet risk is ${r.severity}`);
  return { screening: { ...r, by: cfg.screener.name }, travelRule };
}
