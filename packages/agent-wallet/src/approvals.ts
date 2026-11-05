export type ApprovalState = "pending" | "approved" | "rejected";

/**
 * Where human approvals live. The service only ever asks "what is the state of
 * this approval?" and opens new ones; deciding is done by an operator through
 * whatever channel the host provides, never through an agent tool.
 *
 * The default is in-memory (fine for tests and a single process). A host that
 * runs the wallet in one process and lets an operator decide from another
 * supplies its own store — see `FileApprovalStore` in apps/mcp.
 */
export interface ApprovalStore {
  open(approvalId: string): void;
  status(approvalId: string): ApprovalState | "unknown";
  /** Operator-only. Throws `approval_not_pending` unless the approval is pending. */
  decide(approvalId: string, approve: boolean): void;
  /** Approvals still waiting for a person. */
  pending(): string[];
}

export class MemoryApprovalStore implements ApprovalStore {
  #states = new Map<string, ApprovalState>();

  open(approvalId: string): void {
    this.#states.set(approvalId, "pending");
  }

  status(approvalId: string): ApprovalState | "unknown" {
    return this.#states.get(approvalId) ?? "unknown";
  }

  decide(approvalId: string, approve: boolean): void {
    if (this.#states.get(approvalId) !== "pending") throw new Error("approval_not_pending");
    this.#states.set(approvalId, approve ? "approved" : "rejected");
  }

  pending(): string[] {
    return [...this.#states].filter(([, s]) => s === "pending").map(([id]) => id);
  }
}
