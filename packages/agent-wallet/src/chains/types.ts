import type { SignedTx } from "../types.js";

/** What the wallet needs from a chain. MockChain implements it; real adapters (Base, Solana) will too. */
export interface Chain {
  balance(address: string, asset: string): bigint;
  balances(address: string): Record<string, string>;
  encodeTransfer(from: string, to: string, asset: string, amount: bigint): Uint8Array;
  broadcast(tx: SignedTx): Promise<string>;
}
