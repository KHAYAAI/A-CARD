import { ProviderError } from "./errors.js";
import type { Network } from "./types.js";

/** USDC held by an owner, in base units, summed over their token accounts for the network's mint. */
export async function solanaBalance(n: Network, owner: string): Promise<bigint> {
  let res: Response;
  try {
    res = await fetch(n.rpcUrl!, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTokenAccountsByOwner", params: [owner, { mint: n.usdc }, { encoding: "jsonParsed" }] }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    throw new ProviderError(502, "rpc_error", `balance lookup failed: ${(e as Error).message}`);
  }
  const j = (await res.json().catch(() => ({}))) as any;
  if (!res.ok || j.error) throw new ProviderError(502, "rpc_error", `balance lookup failed: ${j?.error?.message ?? res.status}`);
  return ((j.result?.value ?? []) as any[]).reduce((a, v) => a + BigInt(v?.account?.data?.parsed?.info?.tokenAmount?.amount ?? "0"), 0n);
}

export function solanaTransfer(): never {
  throw new ProviderError(501, "not_implemented", "USDC transfers on Solana are not implemented yet. Keys, addresses and balances are.");
}
