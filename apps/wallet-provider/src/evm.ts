import { createPublicClient, createWalletClient, defineChain, getAddress, http, isAddress, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ProviderError } from "./errors.js";
import type { Network } from "./types.js";

const ERC20 = parseAbi(["function balanceOf(address) view returns (uint256)", "function transfer(address to, uint256 amount) returns (bool)"]);

const chainFor = (n: Network) =>
  defineChain({ id: n.chainId!, name: n.name, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [n.rpcUrl!] } } });
const transport = (n: Network) => http(n.rpcUrl!, { retryCount: 0, timeout: 20_000 });

export const isEvmAddress = (a: string) => isAddress(a, { strict: false });
export const checksum = (a: string) => getAddress(a);

export async function evmBalance(n: Network, address: string): Promise<bigint> {
  try {
    const client = createPublicClient({ chain: chainFor(n), transport: transport(n) });
    return await client.readContract({ address: getAddress(n.usdc), abi: ERC20, functionName: "balanceOf", args: [getAddress(address)] });
  } catch (e) {
    throw new ProviderError(502, "rpc_error", `balance lookup failed: ${(e as Error).message.split("\n")[0]}`);
  }
}

/**
 * Signs an ERC-20 transfer of USDC with the wallet's own key and broadcasts it.
 * `confirmed` is false when the transaction was broadcast but no receipt showed
 * up in time: the transfer may still land, so the caller must treat it as
 * unknown rather than failed.
 */
export async function evmTransfer(n: Network, secretHex: `0x${string}`, to: string, amount: bigint, confirmTimeoutMs = 30_000): Promise<{ txHash: string; confirmed: boolean }> {
  const chain = chainFor(n);
  const account = privateKeyToAccount(secretHex);
  const wallet = createWalletClient({ account, chain, transport: transport(n) });
  let hash: `0x${string}`;
  try {
    hash = await wallet.writeContract({ address: getAddress(n.usdc), abi: ERC20, functionName: "transfer", args: [getAddress(to), amount] });
  } catch (e) {
    const msg = (e as Error).message.split("\n")[0] ?? "send failed";
    if (/insufficient|exceeds balance|reverted/i.test(msg)) throw new ProviderError(422, "transfer_rejected", `the network rejected the transfer: ${msg}`);
    throw new ProviderError(502, "rpc_error", `broadcast failed: ${msg}`);
  }
  try {
    const client = createPublicClient({ chain, transport: transport(n) });
    const receipt = await client.waitForTransactionReceipt({ hash, timeout: confirmTimeoutMs, pollingInterval: 400 });
    if (receipt.status === "reverted") throw new ProviderError(422, "transfer_reverted", `transaction ${hash} reverted on chain`);
    return { txHash: hash, confirmed: true };
  } catch (e) {
    if (e instanceof ProviderError) throw e;
    return { txHash: hash, confirmed: false };
  }
}
