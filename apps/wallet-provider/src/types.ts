/** The chains the A-CARD platform links wallets on (packages/core/src/wallets.ts). */
export type Chain = "ethereum" | "polygon" | "solana";
export const CHAINS: readonly Chain[] = ["ethereum", "polygon", "solana"];
export const isChain = (v: unknown): v is Chain => typeof v === "string" && (CHAINS as readonly string[]).includes(v);

export interface Network {
  chain: Chain;
  kind: "evm" | "solana";
  /** Human name, e.g. "sepolia". */
  name: string;
  chainId?: number;
  /** JSON-RPC endpoint. Without it, balance and transfer answer 503 (key generation still works). */
  rpcUrl?: string;
  /** The USDC contract (EVM) or mint (Solana) on this network. */
  usdc: string;
  /** Test network: no real value. Anything else needs PROVIDER_ALLOW_MAINNET=true. */
  testnet: boolean;
}

export interface WalletRecord {
  id: string;
  userId: string;
  chain: Chain;
  address: string;
  sealed: import("./crypto.js").SealedKey;
  createdAt: string;
}

export interface TransferRecord {
  key: string;
  fromAddress: string;
  chain: Chain;
  to: string;
  amount: string; // USDC base units
  txHash: string;
  confirmed: boolean;
  at: string;
}
