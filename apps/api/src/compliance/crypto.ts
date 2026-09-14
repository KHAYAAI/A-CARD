import type { RailAdapter } from "../rails/types.js";

/**
 * Crypto-specific compliance: Travel Rule and wallet screening.
 *
 * **Built, and deliberately dormant.** Both obligations attach to moving real
 * crypto value, and A-CARD moves none today: AFP's x402 rail signs with
 * `SANDBOX_SIGNER` and its stablecoin rail transfers through
 * `createSandboxStablecoinClient`. Screening a wallet that will never be paid,
 * or filing Travel Rule data for a transfer that moves nothing, is not
 * compliance — it is theatre that costs money per call and produces records
 * asserting things that did not happen.
 *
 * So this layer is gated on `RailAdapter.carriesRealValue`, which each rail
 * computes from what was *injected* rather than from configuration. The
 * practical consequence: nobody can switch this on with an environment
 * variable, and nobody has to remember to switch it on either. The day a real
 * signer or a custody client replaces the sandbox one, these obligations
 * start applying by themselves, which is the only ordering that is ever
 * correct — the alternative is discovering on go-live day that the Travel
 * Rule flow was never wired.
 *
 * ## Why Travel Rule may still not apply even then
 *
 * The Travel Rule binds Virtual Asset Service Providers transmitting value
 * between institutions. A-CARD paying an API provider over x402 is a
 * *customer paying a merchant*, not a VASP-to-VASP transfer, and very likely
 * falls outside it. Whether it applies is a legal determination about what
 * A-CARD is, not something this file can decide — which is why
 * `travelRuleRequired` is an explicit, separate assertion an operator makes,
 * on top of the rails being real. Wallet screening has no such ambiguity: if
 * you are sending real value to an address, screening it is prudent whether
 * or not a regulator compels it.
 */

/** The chains Didit's screening provider covers. */
export type ScreenableChain =
  | "BTC" | "ETH" | "LTC" | "XRP" | "BCH" | "DOGE" | "TRX" | "SOL" | "MATIC" | "BNB" | "USDT" | "USDC";

export type WalletRiskSeverity = "low" | "medium" | "high" | "severe" | "unknown";

export interface WalletScreeningResult {
  address: string;
  chain: ScreenableChain;
  /** 0–100 where the provider gives one. */
  riskScore?: number;
  severity: WalletRiskSeverity;
  sanctionsHit: boolean;
  /** Where the provider believes the funds came from / are going. */
  sourceOfFunds: Array<{ category: string; percentage?: number }>;
  destinationOfFunds: Array<{ category: string; percentage?: number }>;
}

/** A counterparty institution in the VASP directory. */
export interface Vasp {
  name: string;
  travelAddress?: string;
  lei?: string;
  /** The provider's own due-diligence score, where published. */
  dueDiligenceScore?: number;
}

/** Travel Rule data for a crypto deposit that already settled on-chain. */
export interface InboundTransferRecord {
  txid: string;
  walletAddress: string;
  chain?: string;
  currency?: string;
  amount?: string;
  originatingVasp?: { name?: string; lei?: string; travelAddress?: string };
}

export interface CryptoCompliancePort {
  screenWallet(input: {
    address: string;
    chain: ScreenableChain;
    direction?: "inbound" | "outbound";
  }): Promise<WalletScreeningResult>;

  searchVasps(search?: string): Promise<Vasp[]>;

  /** Register a settled inbound deposit for the Travel Rule sunrise flow. */
  registerInboundTransfer(input: InboundTransferRecord): Promise<{ registered: boolean; transferId?: string }>;
}

/**
 * Why crypto compliance is or is not active, as a value rather than a
 * boolean — an operator asking "why is wallet screening off?" gets a
 * sentence, not a shrug.
 */
export interface CryptoComplianceGate {
  /** Screening is live. */
  screeningActive: boolean;
  /** Travel Rule filing is live. Requires `screeningActive` AND the operator's own assertion. */
  travelRuleActive: boolean;
  /** Rails that currently move real crypto value. */
  liveCryptoRails: string[];
  reason: string;
}

/** The crypto rails, by profile id. The card rail is not one of them. */
const CRYPTO_RAIL_IDS = new Set(["x402", "stablecoin"]);

/**
 * Decide whether crypto compliance applies, from the rails actually wired.
 *
 * `operatorAssertsVasp` is the one part a human must supply: whether this
 * deployment considers itself a VASP subject to the Travel Rule. It cannot be
 * inferred from code, and asserting it while every crypto rail is still
 * sandboxed does nothing — the rails gate comes first.
 */
export function evaluateCryptoGate(
  rails: readonly RailAdapter[] | undefined,
  operatorAssertsVasp = false,
): CryptoComplianceGate {
  const liveCryptoRails = (rails ?? [])
    .filter((r) => CRYPTO_RAIL_IDS.has(r.profile.id) && r.carriesRealValue)
    .map((r) => r.profile.id);

  if (liveCryptoRails.length === 0) {
    const anyCrypto = (rails ?? []).some((r) => CRYPTO_RAIL_IDS.has(r.profile.id));
    return {
      screeningActive: false,
      travelRuleActive: false,
      liveCryptoRails: [],
      reason: anyCrypto
        ? "crypto rails are configured but still sandboxed — they move no real value, so there is nothing to screen or file"
        : "no crypto rails are configured",
    };
  }

  return {
    screeningActive: true,
    travelRuleActive: operatorAssertsVasp,
    liveCryptoRails,
    reason: operatorAssertsVasp
      ? `crypto rails carrying real value: ${liveCryptoRails.join(", ")} — screening and Travel Rule filing both active`
      : `crypto rails carrying real value: ${liveCryptoRails.join(", ")} — screening active; Travel Rule filing is off until this deployment asserts it is a VASP subject to it`,
  };
}
