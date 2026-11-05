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
