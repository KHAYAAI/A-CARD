import { WalletService } from "./wallet.js";
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
export async function devWallet(options: { approvals?: ApprovalStore; sink?: EventSink } = {}): Promise<WalletService> {
  const policies: Record<string, WalletPolicy> = {
    default: {
      allowedChains: ["mock"],
      assets: { USDC: { perTx: 50_000_000n, per24h: 200_000_000n, approvalAbove: 10_000_000n } },
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
  });
  chain.credit(await signer.address("mock"), "USDC", 500_000_000n);
  return wallet;
}
