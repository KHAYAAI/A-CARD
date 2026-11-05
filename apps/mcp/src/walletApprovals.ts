import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ApprovalState, ApprovalStore } from "@acard/agent-wallet";

/**
 * Wallet approvals shared between the MCP server (which opens them) and the
 * operator, who decides from a separate terminal:
 *
 *   acard-mcp wallet-approvals            list pending approvals
 *   acard-mcp wallet-approve <id>         approve
 *   acard-mcp wallet-reject <id>          reject
 *
 * Stored in ~/.acard/wallet-approvals.json (owner-only). This is a sandbox
 * channel: an agent with a shell on the same machine could run the same
 * commands, so it only proves the flow. A real deployment must route
 * approvals to a channel the agent can't reach (the A-CARD dashboard).
 */

export const WALLET_APPROVALS_FILE = join(homedir(), ".acard", "wallet-approvals.json");

type Entries = Record<string, { state: ApprovalState; at: string }>;

export class FileApprovalStore implements ApprovalStore {
  constructor(private readonly file: string = WALLET_APPROVALS_FILE) {}

  #read(): Entries {
    return existsSync(this.file) ? (JSON.parse(readFileSync(this.file, "utf8")) as Entries) : {};
  }

  #write(entries: Entries): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(entries, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file); // atomic: a reader never sees half a file
  }

  open(approvalId: string): void {
    const entries = this.#read();
    entries[approvalId] = { state: "pending", at: new Date().toISOString() };
    this.#write(entries);
  }

  status(approvalId: string): ApprovalState | "unknown" {
    return this.#read()[approvalId]?.state ?? "unknown";
  }

  decide(approvalId: string, approve: boolean): void {
    const entries = this.#read();
    if (entries[approvalId]?.state !== "pending") throw new Error("approval_not_pending");
    entries[approvalId] = { state: approve ? "approved" : "rejected", at: new Date().toISOString() };
    this.#write(entries);
  }

  pending(): string[] {
    return Object.entries(this.#read())
      .filter(([, e]) => e.state === "pending")
      .map(([id]) => id);
  }
}
