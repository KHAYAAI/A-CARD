import { WalletService } from "./wallet.js";
import { MockSwapProvider } from "./swap.js";
import { SandboxDefiProvider } from "./defi.js";
import { DevSigner } from "./signer/index.js";
import { MockChain } from "./chains/mock.js";
import { stderrSink, type EventSink } from "./events.js";
import type { ApprovalStore } from "./approvals.js";
import type { WalletPolicy } from "./policy/engine.js";

/**
 * Dev defaults: mock chain, dev signer, a funded wallet with conservative
 * limits (USDC, 6 decimals: 10 needs approval, 50 per transfer, 200 per day).
 * Nothing here can touch a real chain: DevSigner refuses non-testnets.
 */
export async function devWallet(options: { approvals?: ApprovalStore; sink?: EventSink; x402AllowPrivateNetworks?: boolean; fetchImpl?: typeof fetch } = {}): Promise<WalletService> {
  const policies: Record<string, WalletPolicy> = {
    default: {
      allowedChains: ["mock"],
      assets: { USDC: { perTx: 50_000_000n, per24h: 200_000_000n, approvalAbove: 10_000_000n } },
      x402: { maxPricePerRequest: 1_000_000n }, // 1 USDC a request
      swap: { maxSlippageBps: 100 },
    },
  };
  const chain = new MockChain();
  const signer = new DevSigner();
  const wallet = new WalletService({
    agentId: "dev-agent",
    signer,
    chain,
    policies,
    sanctions: async () => "clear",
    sink: options.sink ?? stderrSink,
    approvals: options.approvals,
    swap: new MockSwapProvider(chain),
    defi: new SandboxDefiProvider(),
    // Base Sepolia is stood in for by the mock chain.
    x402: { networks: { "eip155:84532": "mock" }, allowPrivateNetworks: options.x402AllowPrivateNetworks, fetchImpl: options.fetchImpl },
  });
  chain.credit(await signer.address("mock"), "USDC", 500_000_000n);
  return wallet;
}
