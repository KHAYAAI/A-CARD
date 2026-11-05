import { randomUUID } from "node:crypto";

/** Subset of FORGE's canonical ForgePayEvent, emitted for every wallet action. */
export interface ForgePayEvent {
  id: string;
  type:
    | "agent_wallet.transfer.previewed"
    | "agent_wallet.transfer.executed"
    | "agent_wallet.transfer.denied"
    | "agent_wallet.transfer.failed"
    | "agent_wallet.x402.previewed"
    | "agent_wallet.x402.paid"
    | "agent_wallet.x402.denied"
    | "agent_wallet.x402.failed"
    | "agent_wallet.swap.previewed"
    | "agent_wallet.swap.executed"
    | "agent_wallet.swap.denied"
    | "agent_wallet.swap.failed";
  occurredAt: string;
  agentId: string;
  walletId: string;
  chain: string;
  asset: string;
  amount: string;
  counterparty: string;
  decision?: string;
  reasons?: string[];
  txHash?: string;
}

export type EventSink = (e: ForgePayEvent) => void | Promise<void>;

/** Dev sink: JSONL to stderr (stdout is reserved for the MCP protocol). */
export const stderrSink: EventSink = (e) => {
  process.stderr.write(JSON.stringify(e) + "\n");
};

export function makeEvent(fields: Omit<ForgePayEvent, "id" | "occurredAt">): ForgePayEvent {
  return { id: randomUUID(), occurredAt: new Date().toISOString(), ...fields };
}
