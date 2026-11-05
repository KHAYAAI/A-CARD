#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { WalletService } from "./wallet.js";
import { DevSigner } from "./signer/index.js";
import { MockChain } from "./chains/mock.js";
import { stderrSink } from "./events.js";
import type { WalletPolicy } from "./policy/engine.js";

const CHAINS = ["mock", "base-sepolia", "solana-devnet"] as const;

export function buildServer(wallet: WalletService): McpServer {
  const server = new McpServer({ name: "forge-agent-wallet", version: "0.1.0" });
  const json = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v, null, 2) }] });
  const fail = (e: unknown) => ({ isError: true, content: [{ type: "text" as const, text: (e as Error).message }] });

  server.registerTool(
    "wallet_status",
    { description: "List wallets, signer, allowed chains and spending limits.", annotations: { readOnlyHint: true } },
    async () => json(await wallet.status()),
  );

  server.registerTool(
    "get_balances",
    {
      description: "Balances for the agent's address on a chain. Amounts are integer strings in the asset's smallest unit.",
      inputSchema: { chain: z.enum(CHAINS) },
      annotations: { readOnlyHint: true },
    },
    async ({ chain }) => json({ chain, address: await wallet.address(chain), balances: await wallet.balances(chain) }),
  );

  server.registerTool(
    "receive_info",
    { description: "Address to receive funds on a chain.", inputSchema: { chain: z.enum(CHAINS) }, annotations: { readOnlyHint: true } },
    async ({ chain }) => json({ chain, address: await wallet.address(chain) }),
  );

  server.registerTool(
    "send_preview",
    {
      description:
        "Step 1 of a transfer. Checks policy and returns a preview_id and decision (allow, require_approval, deny). Nothing moves yet.",
      inputSchema: {
        wallet_id: z.string(),
        chain: z.enum(CHAINS),
        asset: z.string(),
        to: z.string(),
        amount: z.string().regex(/^\d+$/, "integer string in smallest unit"),
        memo: z.string().max(140).optional(),
      },
    },
    async (a) => {
      try {
        const p = await wallet.sendPreview({ walletId: a.wallet_id, chain: a.chain, asset: a.asset, to: a.to, amount: BigInt(a.amount), memo: a.memo });
        return json({ preview_id: p.id, decision: p.policy.decision, reasons: p.policy.reasons, approval_id: p.approvalId ?? null, expires_at: new Date(p.expiresAt).toISOString() });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "send_execute",
    {
      description: "Step 2 of a transfer. Executes a previewed transfer if policy allows (and approval was granted when required). Single use.",
      inputSchema: { preview_id: z.string().uuid() },
      annotations: { destructiveHint: true },
    },
    async ({ preview_id }) => {
      try {
        return json(await wallet.sendExecute(preview_id));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "approval_status",
    { description: "Check whether a human has approved a pending transfer.", inputSchema: { approval_id: z.string().uuid() }, annotations: { readOnlyHint: true } },
    async ({ approval_id }) => json({ approval_id, status: wallet.approvalStatus(approval_id) }),
  );

  return server;
}

/** Dev defaults: mock chain, dev signer, a funded wallet with conservative limits. */
export async function devWallet(): Promise<WalletService> {
  const policies: Record<string, WalletPolicy> = {
    default: {
      allowedChains: ["mock"],
      assets: { USDC: { perTx: 50_000_000n, per24h: 200_000_000n, approvalAbove: 10_000_000n } }, // 6 decimals
    },
  };
  const chain = new MockChain();
  const signer = new DevSigner();
  const wallet = new WalletService({ agentId: "dev-agent", signer, chain, policies, sanctions: async () => "clear", sink: stderrSink });
  chain.credit(await signer.address("mock"), "USDC", 500_000_000n);
  return wallet;
}

const isMain = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("server.ts");
if (isMain) {
  const server = buildServer(await devWallet());
  await server.connect(new StdioServerTransport());
}
