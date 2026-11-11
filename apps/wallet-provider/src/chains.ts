import type { Chain, Network } from "./types.js";

/**
 * Test networks by default. These are Circle's documented test USDC
 * deployments; they carry no real value.
 */
export const TESTNETS: Record<Chain, Omit<Network, "rpcUrl">> = {
  ethereum: { chain: "ethereum", kind: "evm", name: "sepolia", chainId: 11155111, usdc: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238", testnet: true },
  polygon: { chain: "polygon", kind: "evm", name: "amoy", chainId: 80002, usdc: "0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582", testnet: true },
  solana: { chain: "solana", kind: "solana", name: "devnet", usdc: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", testnet: true },
};

export interface NetworkEnv {
  PROVIDER_RPC_ETHEREUM?: string;
  PROVIDER_RPC_POLYGON?: string;
  PROVIDER_RPC_SOLANA?: string;
  /** JSON array replacing the defaults, for a different network (e.g. Base Sepolia, or mainnet). */
  PROVIDER_NETWORKS_JSON?: string;
  PROVIDER_ALLOW_MAINNET?: string;
}

/**
 * Resolves the networks this provider serves. A network that is not a testnet
 * is refused unless the operator has set PROVIDER_ALLOW_MAINNET=true, and the
 * check happens here, at startup, so a mistake in the JSON cannot quietly
 * point the provider at real funds.
 */
export function loadNetworks(env: NetworkEnv): Record<Chain, Network> {
  const allowMainnet = env.PROVIDER_ALLOW_MAINNET === "true";
  const base: Record<Chain, Network> = {
    ethereum: { ...TESTNETS.ethereum, rpcUrl: env.PROVIDER_RPC_ETHEREUM },
    polygon: { ...TESTNETS.polygon, rpcUrl: env.PROVIDER_RPC_POLYGON },
    solana: { ...TESTNETS.solana, rpcUrl: env.PROVIDER_RPC_SOLANA },
  };
  if (env.PROVIDER_NETWORKS_JSON) {
    const list = JSON.parse(env.PROVIDER_NETWORKS_JSON) as Network[];
    for (const n of list) {
      if (!base[n.chain]) throw new Error(`PROVIDER_NETWORKS_JSON: unknown chain ${n.chain}`);
      if (n.kind === "evm" && !Number.isInteger(n.chainId)) throw new Error(`PROVIDER_NETWORKS_JSON: ${n.chain} needs a numeric chainId`);
      if (typeof n.testnet !== "boolean") throw new Error(`PROVIDER_NETWORKS_JSON: ${n.chain} must say whether it is a testnet`);
      base[n.chain] = n;
    }
  }
  for (const n of Object.values(base)) {
    if (!n.testnet && !allowMainnet) {
      throw new Error(`${n.chain}/${n.name} is not a test network. Refusing to start: set PROVIDER_ALLOW_MAINNET=true only if you mean to hold and move real funds.`);
    }
  }
  return base;
}
