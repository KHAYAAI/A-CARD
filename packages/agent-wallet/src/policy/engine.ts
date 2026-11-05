import type { ChainId, PolicyResult, TransferRequest } from "../types.js";

export interface AssetLimits {
  perTx: bigint;
  per24h: bigint;
  approvalAbove?: bigint; // amounts strictly above need human approval
}

export interface WalletPolicy {
  allowedChains: ChainId[];
  assets: Record<string, AssetLimits>; // assets not listed are denied
  allowList?: string[]; // if set, only these recipients
  denyList?: string[];
  /** Paying HTTP 402 services. Absent = x402 is off for this wallet (fails closed). */
  x402?: {
    maxPricePerRequest: bigint; // asset smallest units (USDC)
    allowedDomains?: string[]; // "api.example.com" or ".example.com" for subdomains; unset = any public host
  };
  /** Swaps. Absent = swaps are off for this wallet. */
  swap?: {
    allowedPairs?: string[]; // "USDC>ZARP"; unset = any pair the provider routes
    maxSlippageBps: number;
  };
}

/** x402 rules that need no network: is it on, and is this host allowed? */
export function checkX402Host(policy: WalletPolicy | undefined, host: string): PolicyResult | undefined {
  if (!policy?.x402) return { decision: "deny", reasons: ["x402_not_enabled"] };
  const allowed = policy.x402.allowedDomains;
  const h = host.toLowerCase();
  if (allowed?.length && !allowed.some((d) => (d.startsWith(".") ? h.endsWith(d.toLowerCase()) || h === d.slice(1).toLowerCase() : h === d.toLowerCase()))) {
    return { decision: "deny", reasons: [`x402_domain_not_allowed:${host}`] };
  }
  return undefined;
}

/** x402 rule that needs the quoted price. */
export function checkX402Price(policy: WalletPolicy | undefined, price: bigint): PolicyResult | undefined {
  if (!policy?.x402) return { decision: "deny", reasons: ["x402_not_enabled"] };
  return price > policy.x402.maxPricePerRequest ? { decision: "deny", reasons: ["x402_price_above_policy_max"] } : undefined;
}

/** Swap rules: enabled, pair allowed, slippage within bounds. */
export function checkSwap(policy: WalletPolicy | undefined, q: { assetIn: string; assetOut: string; amountOut: bigint; minAmountOut: bigint }): PolicyResult | undefined {
  if (!policy?.swap) return { decision: "deny", reasons: ["swaps_not_enabled"] };
  const pair = `${q.assetIn}>${q.assetOut}`;
  if (policy.swap.allowedPairs && !policy.swap.allowedPairs.includes(pair)) return { decision: "deny", reasons: [`pair_not_allowed:${pair}`] };
  if (q.amountOut <= 0n) return { decision: "deny", reasons: ["quote_returns_nothing"] };
  const slippageBps = ((q.amountOut - q.minAmountOut) * 10_000n) / q.amountOut;
  if (slippageBps > BigInt(policy.swap.maxSlippageBps)) return { decision: "deny", reasons: ["slippage_above_policy"] };
  return undefined;
}

/** Hook for compliance-monitor. Must throw or return "hit" to block. */
export type SanctionsCheck = (address: string) => Promise<"clear" | "hit">;

export interface SpendLedger {
  /** Sum of executed amounts for wallet+asset in the window ending now. */
  spentSince(walletId: string, asset: string, sinceMs: number): bigint;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Evaluates a transfer against policy. Fails closed: any exception → deny.
 * Order: structural checks → lists → sanctions → limits → approval threshold.
 */
export async function evaluate(
  req: TransferRequest,
  policy: WalletPolicy | undefined,
  ledger: SpendLedger,
  sanctions: SanctionsCheck,
  now: number = Date.now(),
): Promise<PolicyResult> {
  try {
    if (!policy) return deny("no_policy_for_wallet");
    if (req.amount <= 0n) return deny("amount_must_be_positive");
    if (!policy.allowedChains.includes(req.chain)) return deny(`chain_not_allowed:${req.chain}`);

    const limits = policy.assets[req.asset];
    if (!limits) return deny(`asset_not_allowed:${req.asset}`);

    const to = req.to.toLowerCase();
    if (policy.denyList?.some((a) => a.toLowerCase() === to)) return deny("recipient_on_deny_list");
    if (policy.allowList && !policy.allowList.some((a) => a.toLowerCase() === to)) {
      return deny("recipient_not_on_allow_list");
    }

    if ((await sanctions(req.to)) !== "clear") return deny("sanctions_hit");

    if (req.amount > limits.perTx) return deny("exceeds_per_tx_limit");
    const spent = ledger.spentSince(req.walletId, req.asset, now - DAY_MS);
    if (spent + req.amount > limits.per24h) return deny("exceeds_24h_limit");

    if (limits.approvalAbove !== undefined && req.amount > limits.approvalAbove) {
      return { decision: "require_approval", reasons: ["above_approval_threshold"] };
    }
    return { decision: "allow", reasons: [] };
  } catch (err) {
    return deny(`policy_error:${(err as Error).message}`);
  }
}

function deny(reason: string): PolicyResult {
  return { decision: "deny", reasons: [reason] };
}
