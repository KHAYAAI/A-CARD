import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { WalletService } from "../wallet.js";

export const CHAINS = ["mock", "base-sepolia", "solana-devnet"] as const;

const json = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v, null, 2) }] });
const fail = (e: unknown) => ({ isError: true as const, content: [{ type: "text" as const, text: (e as Error).message }] });

/**
 * Registers the wallet's tools on an MCP server. Used by this package's own
 * stdio server and by A-CARD's MCP server, so both offer identical tools.
 * Approval decisions are deliberately not among them: an agent must not be
 * able to approve its own spending.
 */
export function registerWalletTools(server: McpServer, wallet: WalletService): void {
  server.registerTool(
    "wallet_status",
    { description: "On-chain agent wallet (sandbox: test chains only, no real funds). Lists wallets, signer, allowed chains and spending limits. For A-CARD's fiat wallet use get_wallet.", annotations: { readOnlyHint: true } },
    async () => json(await wallet.status()),
  );

  server.registerTool(
    "get_balances",
    {
      description: "On-chain wallet balances (sandbox) for the agent's address on a chain. Amounts are integer strings in the asset's smallest unit.",
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
        "Step 1 of an on-chain transfer (sandbox). Checks policy and returns a preview_id and decision (allow, require_approval, deny). Nothing moves yet.",
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
}
