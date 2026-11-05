import { createHash } from "node:crypto";
import type { SignedTx } from "../types.js";
import type { Chain } from "./types.js";

/** In-memory chain for development and tests. Real adapters (Base, Solana) follow the same shape. */
export class MockChain implements Chain {
  #balances = new Map<string, bigint>(); // key: address|asset

  credit(address: string, asset: string, amount: bigint): void {
    const k = `${address}|${asset}`;
    this.#balances.set(k, (this.#balances.get(k) ?? 0n) + amount);
  }

  /** Sandbox only: remove funds, e.g. the input side of a mock swap. */
  debit(address: string, asset: string, amount: bigint): void {
    if (this.balance(address, asset) < amount) throw new Error("insufficient_funds");
    this.credit(address, asset, -amount);
  }

  balance(address: string, asset: string): bigint {
    return this.#balances.get(`${address}|${asset}`) ?? 0n;
  }

  balances(address: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of this.#balances) {
      const [addr, asset] = k.split("|") as [string, string];
      if (addr === address) out[asset] = v.toString();
    }
    return out;
  }

  encodeTransfer(from: string, to: string, asset: string, amount: bigint): Uint8Array {
    return new TextEncoder().encode(JSON.stringify({ from, to, asset, amount: amount.toString() }));
  }

  async broadcast(tx: SignedTx): Promise<string> {
    const { from, to, asset, amount } = JSON.parse(new TextDecoder().decode(tx.payload));
    const amt = BigInt(amount);
    if (this.balance(from, asset) < amt) throw new Error("insufficient_funds");
    this.credit(from, asset, -amt);
    this.credit(to, asset, amt);
    return "0x" + createHash("sha256").update(tx.signature).digest("hex");
  }
}
