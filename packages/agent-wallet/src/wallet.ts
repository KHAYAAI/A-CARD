import { randomUUID } from "node:crypto";
import { evaluate, type SanctionsCheck, type SpendLedger, type WalletPolicy } from "./policy/engine.js";
import type { Signer } from "./signer/index.js";
import type { MockChain } from "./chains/mock.js";
import { makeEvent, type EventSink } from "./events.js";
import { MemoryApprovalStore, type ApprovalState, type ApprovalStore } from "./approvals.js";
import type { ChainId, Preview, TransferRequest } from "./types.js";

const PREVIEW_TTL_MS = 5 * 60 * 1000;

interface Executed {
  walletId: string;
  asset: string;
  amount: bigint;
  at: number;
}

export interface WalletServiceDeps {
  agentId: string;
  signer: Signer;
  chain: MockChain;
  policies: Record<string, WalletPolicy>;
  sanctions: SanctionsCheck;
  sink: EventSink;
  /** Defaults to an in-memory store. */
  approvals?: ApprovalStore;
  now?: () => number;
}

/**
 * Orchestrates every money movement:
 * preview → policy → (approval) → execute re-checks policy → sign → broadcast → event.
 */
export class WalletService implements SpendLedger {
  #previews = new Map<string, Preview>();
  readonly #approvals: ApprovalStore;
  #executed: Executed[] = [];
  readonly #now: () => number;

  constructor(private readonly d: WalletServiceDeps) {
    this.#now = d.now ?? Date.now;
    this.#approvals = d.approvals ?? new MemoryApprovalStore();
  }

  spentSince(walletId: string, asset: string, sinceMs: number): bigint {
    return this.#executed
      .filter((e) => e.walletId === walletId && e.asset === asset && e.at >= sinceMs)
      .reduce((s, e) => s + e.amount, 0n);
  }

  async address(chain: ChainId): Promise<string> {
    return this.d.signer.address(chain);
  }

  async status() {
    return Object.entries(this.d.policies).map(([walletId, p]) => ({
      walletId,
      signer: this.d.signer.id,
      chains: p.allowedChains,
      assets: Object.fromEntries(
        Object.entries(p.assets).map(([a, l]) => [
          a,
          { perTx: l.perTx.toString(), per24h: l.per24h.toString(), approvalAbove: l.approvalAbove?.toString() ?? null },
        ]),
      ),
    }));
  }

  async balances(chain: ChainId) {
    return this.d.chain.balances(await this.d.signer.address(chain));
  }

  async sendPreview(req: TransferRequest): Promise<Preview> {
    const policy = await evaluate(req, this.d.policies[req.walletId], this, this.d.sanctions, this.#now());
    const now = this.#now();
    const preview: Preview = { id: randomUUID(), request: req, policy, createdAt: now, expiresAt: now + PREVIEW_TTL_MS, used: false };
    if (policy.decision === "require_approval") {
      const approvalId = randomUUID();
      preview.approvalId = approvalId;
      this.#approvals.open(approvalId);
    }
    this.#previews.set(preview.id, preview);
    await this.#emit(policy.decision === "deny" ? "agent_wallet.transfer.denied" : "agent_wallet.transfer.previewed", req, {
      decision: policy.decision,
      reasons: policy.reasons,
    });
    return preview;
  }

  /** Operator-only. Never exposed as an agent tool. */
  decideApproval(approvalId: string, approve: boolean): void {
    this.#approvals.decide(approvalId, approve);
  }

  approvalStatus(approvalId: string): ApprovalState | "unknown" {
    return this.#approvals.status(approvalId);
  }

  async sendExecute(previewId: string): Promise<{ txHash: string }> {
    const p = this.#previews.get(previewId);
    if (!p) throw new Error("unknown_preview");
    if (p.used) throw new Error("preview_already_used");
    if (this.#now() > p.expiresAt) throw new Error("preview_expired");

    if (p.policy.decision === "deny") throw new Error(`denied:${p.policy.reasons.join(",")}`);
    if (p.policy.decision === "require_approval") {
      const approval = this.approvalStatus(p.approvalId!);
      // Asking before the human has decided doesn't spend the preview: the
      // agent can come back with the same preview_id once they have.
      if (approval === "rejected") throw new Error("approval_rejected");
      if (approval !== "approved") throw new Error("approval_required");
    }
    p.used = true; // single use, even if what follows fails

    // Re-check: limits or lists may have changed since the preview.
    const recheck = await evaluate(p.request, this.d.policies[p.request.walletId], this, this.d.sanctions, this.#now());
    if (recheck.decision === "deny") {
      await this.#emit("agent_wallet.transfer.denied", p.request, { decision: "deny", reasons: recheck.reasons });
      throw new Error(`denied:${recheck.reasons.join(",")}`);
    }

    const r = p.request;
    try {
      const from = await this.d.signer.address(r.chain);
      const payload = this.d.chain.encodeTransfer(from, r.to, r.asset, r.amount);
      const signed = await this.d.signer.sign({ chain: r.chain, payload });
      const txHash = await this.d.chain.broadcast(signed);
      this.#executed.push({ walletId: r.walletId, asset: r.asset, amount: r.amount, at: this.#now() });
      await this.#emit("agent_wallet.transfer.executed", r, { decision: "allow", txHash });
      return { txHash };
    } catch (err) {
      await this.#emit("agent_wallet.transfer.failed", r, { reasons: [(err as Error).message] });
      throw err;
    }
  }

  async #emit(
    type: Parameters<typeof makeEvent>[0]["type"],
    r: TransferRequest,
    extra: { decision?: string; reasons?: string[]; txHash?: string },
  ) {
    await this.d.sink(
      makeEvent({
        type,
        agentId: this.d.agentId,
        walletId: r.walletId,
        chain: r.chain,
        asset: r.asset,
        amount: r.amount.toString(),
        counterparty: r.to,
        ...extra,
      }),
    );
  }
}
