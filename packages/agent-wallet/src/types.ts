export type ChainId = "mock" | "base-sepolia" | "base" | "solana-devnet" | "solana";

export const TESTNETS: ReadonlySet<ChainId> = new Set(["mock", "base-sepolia", "solana-devnet"]);

/** Amounts are integers in the asset's smallest unit. Never floats. */
export type Amount = bigint;

export interface TransferRequest {
  walletId: string;
  chain: ChainId;
  asset: string; // e.g. "USDC", "ETH", "ZARP"
  to: string;
  amount: Amount;
  memo?: string;
}

export type Decision = "allow" | "require_approval" | "deny";

export interface PolicyResult {
  decision: Decision;
  reasons: string[];
}

export interface SignRequest {
  chain: ChainId;
  payload: Uint8Array; // chain-specific unsigned transaction bytes
}

export interface SignedTx {
  chain: ChainId;
  payload: Uint8Array;
  signature: string; // hex
  signerId: string;
}

export type PreviewKind = "transfer" | "x402" | "swap";

export interface Preview {
  id: string;
  kind: PreviewKind;
  request: TransferRequest;
  policy: PolicyResult;
  createdAt: number;
  expiresAt: number;
  used: boolean;
  approvalId?: string;
}
