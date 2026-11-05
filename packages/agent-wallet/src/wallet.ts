import { randomBytes, randomUUID } from "node:crypto";
import {
  checkSwap,
  checkX402Host,
  checkX402Price,
  evaluate,
  type SanctionsCheck,
  type SpendLedger,
  type WalletPolicy,
} from "./policy/engine.js";
import type { Signer } from "./signer/index.js";
import type { Chain } from "./chains/types.js";
import { makeEvent, type EventSink, type ForgePayEvent } from "./events.js";
import { MemoryApprovalStore, type ApprovalState, type ApprovalStore } from "./approvals.js";
import type { SwapProvider, SwapQuote } from "./swap.js";
import type { DefiPosition, DefiProvider } from "./defi.js";
import { assertFetchableUrl, UnsafeUrlError } from "./x402/guard.js";
import {
  chooseRequirement,
  paymentHeader,
  readPaymentRequired,
  readSettlement,
  type PaymentRequired,
  type PaymentRequirement,
  type SettlementResponse,
} from "./x402/protocol.js";
import { TESTNETS, type ChainId, type PolicyResult, type Preview, type PreviewKind, type TransferRequest } from "./types.js";

const PREVIEW_TTL_MS = 5 * 60 * 1000;
const MAX_BODY_BYTES = 64 * 1024;

interface Executed {
  walletId: string;
  asset: string;
  amount: bigint;
  at: number;
}

export interface WalletServiceDeps {
  agentId: string;
  signer: Signer;
  chain: Chain;
  policies: Record<string, WalletPolicy>;
  sanctions: SanctionsCheck;
  sink: EventSink;
  /** Defaults to an in-memory store. */
  approvals?: ApprovalStore;
  swap?: SwapProvider;
  defi?: DefiProvider;
  /**
   * x402 networks this wallet pays on (CAIP-2 → the chain the payment is
   * debited on). The sandbox maps Base Sepolia to the mock chain.
   */
  x402?: { networks: Record<string, ChainId>; allowPrivateNetworks?: boolean; fetchImpl?: typeof fetch; timeoutMs?: number };
  /** Mainnet needs the openfireblocks signer AND this flag, both. */
  allowMainnet?: boolean;
  now?: () => number;
}

interface X402Plan {
  url: string;
  required: PaymentRequired;
  requirement: PaymentRequirement;
  host: string;
}

export interface X402Result {
  txHash: string;
  status: number;
  contentType?: string;
  body?: string;
  truncated?: boolean;
  settlement?: SettlementResponse;
}

const EVENT_TYPES: Record<PreviewKind, Record<"previewed" | "executed" | "denied" | "failed", ForgePayEvent["type"]>> = {
  transfer: {
    previewed: "agent_wallet.transfer.previewed",
    executed: "agent_wallet.transfer.executed",
    denied: "agent_wallet.transfer.denied",
    failed: "agent_wallet.transfer.failed",
  },
  x402: {
    previewed: "agent_wallet.x402.previewed",
    executed: "agent_wallet.x402.paid",
    denied: "agent_wallet.x402.denied",
    failed: "agent_wallet.x402.failed",
  },
  swap: {
    previewed: "agent_wallet.swap.previewed",
    executed: "agent_wallet.swap.executed",
    denied: "agent_wallet.swap.denied",
    failed: "agent_wallet.swap.failed",
  },
};

/**
 * Orchestrates every money movement, whatever its kind:
 * preview → policy → (approval) → execute re-checks policy → sign → settle → event.
 * Transfers, x402 payments and swaps differ only in how they are planned and
 * settled; the gate in front of them is the same.
 */
export class WalletService implements SpendLedger {
  #previews = new Map<string, Preview>();
  #plans = new Map<string, { x402?: X402Plan; swap?: SwapQuote; rules?: () => PolicyResult | undefined }>();
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
      x402: p.x402 ? { maxPricePerRequest: p.x402.maxPricePerRequest.toString(), allowedDomains: p.x402.allowedDomains ?? null } : null,
      swap: p.swap ?? null,
    }));
  }

  async balances(chain: ChainId) {
    return this.d.chain.balances(await this.d.signer.address(chain));
  }

  async defiPositions(chain: ChainId): Promise<DefiPosition[]> {
    if (!this.d.defi) return [];
    return this.d.defi.positions(await this.d.signer.address(chain), chain);
  }

  // ---- the shared gate -----------------------------------------------------------------------

  async #evaluate(req: TransferRequest, rules?: () => PolicyResult | undefined): Promise<PolicyResult> {
    if (!TESTNETS.has(req.chain) && !(this.d.signer.id === "openfireblocks" && this.d.allowMainnet === true)) {
      return { decision: "deny", reasons: ["mainnet_disabled"] };
    }
    const own = rules?.();
    if (own) return own;
    return evaluate(req, this.d.policies[req.walletId], this, this.d.sanctions, this.#now());
  }

  async #open(
    kind: PreviewKind,
    req: TransferRequest,
    plan: { x402?: X402Plan; swap?: SwapQuote; rules?: () => PolicyResult | undefined } = {},
  ): Promise<Preview> {
    const policy = await this.#evaluate(req, plan.rules);
    const now = this.#now();
    const preview: Preview = { id: randomUUID(), kind, request: req, policy, createdAt: now, expiresAt: now + PREVIEW_TTL_MS, used: false };
    if (policy.decision === "require_approval") {
      preview.approvalId = randomUUID();
      this.#approvals.open(preview.approvalId);
    }
    this.#previews.set(preview.id, preview);
    this.#plans.set(preview.id, plan);
    await this.#emit(EVENT_TYPES[kind][policy.decision === "deny" ? "denied" : "previewed"], req, { decision: policy.decision, reasons: policy.reasons });
    return preview;
  }

  /** Validates a preview for execution, enforces approval, re-checks policy, and spends it. */
  async #take(previewId: string, kind: PreviewKind): Promise<Preview> {
    const p = this.#previews.get(previewId);
    if (!p || p.kind !== kind) throw new Error("unknown_preview");
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
    const recheck = await this.#evaluate(p.request, this.#plans.get(p.id)?.rules);
    if (recheck.decision === "deny") {
      await this.#emit(EVENT_TYPES[kind].denied, p.request, { decision: "deny", reasons: recheck.reasons });
      throw new Error(`denied:${recheck.reasons.join(",")}`);
    }
    return p;
  }

  /** Operator-only. Never exposed as an agent tool. */
  decideApproval(approvalId: string, approve: boolean): void {
    this.#approvals.decide(approvalId, approve);
  }

  approvalStatus(approvalId: string): ApprovalState | "unknown" {
    return this.#approvals.status(approvalId);
  }

  // ---- transfers -----------------------------------------------------------------------------

  async sendPreview(req: TransferRequest): Promise<Preview> {
    return this.#open("transfer", req);
  }

  async sendExecute(previewId: string): Promise<{ txHash: string }> {
    const p = await this.#take(previewId, "transfer");
    const r = p.request;
    try {
      const txHash = await this.#settleTransfer(r);
      await this.#emit(EVENT_TYPES.transfer.executed, r, { decision: "allow", txHash });
      return { txHash };
    } catch (err) {
      await this.#emit(EVENT_TYPES.transfer.failed, r, { reasons: [(err as Error).message] });
      throw err;
    }
  }

  async #settleTransfer(r: TransferRequest): Promise<string> {
    const from = await this.d.signer.address(r.chain);
    const payload = this.d.chain.encodeTransfer(from, r.to, r.asset, r.amount);
    const signed = await this.d.signer.sign({ chain: r.chain, payload });
    const txHash = await this.d.chain.broadcast(signed);
    this.#executed.push({ walletId: r.walletId, asset: r.asset, amount: r.amount, at: this.#now() });
    return txHash;
  }

  // ---- x402 ----------------------------------------------------------------------------------

  /**
   * Step 1 of paying an HTTP 402 service. Reads the price the server asks and
   * checks it against `maxAmount` (the most the agent will pay, USDC smallest
   * units) and the wallet's x402 policy. Nothing is paid. GET only: a probe of
   * a POST endpoint could have side effects.
   */
  async x402Preview(input: { walletId: string; url: string; maxAmount: bigint }): Promise<Preview> {
    const cfg = this.d.x402;
    const policy = this.d.policies[input.walletId];
    const denied = (reasons: string[], chain: ChainId, to: string, amount = input.maxAmount) =>
      this.#open("x402", { walletId: input.walletId, chain, asset: "USDC", to, amount }, { rules: () => ({ decision: "deny", reasons }) });
    const firstChain = Object.values(cfg?.networks ?? {})[0] ?? "mock";

    if (!cfg) return denied(["x402_not_configured"], firstChain, input.url);
    let url: URL;
    try {
      url = await assertFetchableUrl(input.url, { allowPrivateNetworks: cfg.allowPrivateNetworks });
    } catch (e) {
      throw new Error(`x402_url_not_allowed:${e instanceof UnsafeUrlError ? e.message : String(e)}`);
    }
    const hostDecision = checkX402Host(policy, url.hostname);
    if (hostDecision) return denied(hostDecision.reasons, firstChain, url.hostname); // refused before the host is contacted

    const doFetch = cfg.fetchImpl ?? fetch;
    let first: Response;
    try {
      first = await doFetch(url, { redirect: "manual", signal: AbortSignal.timeout(cfg.timeoutMs ?? 30_000), headers: { accept: "application/json, text/plain;q=0.9, */*;q=0.5" } });
    } catch (e) {
      throw new Error(`x402_resource_unreachable:${e instanceof Error ? e.message : e}`);
    }
    if (first.status !== 402) throw new Error(`x402_not_required:${first.status}`);
    const required = await readPaymentRequired(first);
    if (!required) throw new Error("x402_invalid_payment_required");
    const requirement = chooseRequirement(required, Object.keys(cfg.networks));
    if (!requirement) return denied(["x402_no_supported_payment_option"], firstChain, url.hostname);

    const chain = cfg.networks[requirement.network]!;
    const price = BigInt(requirement.amount);
    const rules = () =>
      checkX402Host(policy, url.hostname) ?? (price > input.maxAmount ? { decision: "deny" as const, reasons: ["x402_price_above_max"] } : undefined) ?? checkX402Price(policy, price);
    return this.#open("x402", { walletId: input.walletId, chain, asset: "USDC", to: requirement.payTo, amount: price }, {
      x402: { url: url.toString(), required, requirement, host: url.hostname },
      rules,
    });
  }

  /**
   * Step 2: sign the payment and retry. In the sandbox the signature is the
   * dev signer's, which a real x402 server would reject, and settlement is
   * simulated on the mock chain once the server answers 2xx.
   */
  async x402Pay(previewId: string): Promise<X402Result> {
    const p = await this.#take(previewId, "x402");
    const plan = this.#plans.get(p.id)!.x402!;
    const cfg = this.d.x402!;
    const r = p.request;
    try {
      const from = await this.d.signer.address(r.chain);
      if (this.d.chain.balance(from, "USDC") < r.amount) throw new Error("insufficient_funds");

      const now = Math.floor(this.#now() / 1000);
      const authorization = {
        from,
        to: r.to,
        value: plan.requirement.amount,
        validAfter: String(now - 60),
        validBefore: String(now + Math.max(30, plan.requirement.maxTimeoutSeconds)),
        nonce: `0x${randomBytes(32).toString("hex")}`,
      };
      const signed = await this.d.signer.sign({ chain: r.chain, payload: new TextEncoder().encode(JSON.stringify(authorization)) });
      const header = paymentHeader(plan.required, plan.requirement, authorization, `0x${signed.signature}`);

      let paid: Response;
      try {
        paid = await (cfg.fetchImpl ?? fetch)(plan.url, { redirect: "manual", signal: AbortSignal.timeout(cfg.timeoutMs ?? 30_000), headers: { accept: "*/*", [header.name]: header.value } });
      } catch (e) {
        // The server may have received a signed payment: unknown, not failed. Nothing was debited here.
        throw new Error(`x402_outcome_unknown:${e instanceof Error ? e.message : e}`);
      }
      const settlement = readSettlement(paid);
      if (paid.status >= 500) throw new Error(`x402_outcome_unknown:server answered ${paid.status}`);
      if (paid.status < 200 || paid.status >= 300) throw new Error(`x402_payment_rejected:${paid.status}${settlement?.errorReason ? `:${settlement.errorReason}` : ""}`);

      const txHash = await this.#settleTransfer(r);
      const buf = Buffer.from(await paid.arrayBuffer());
      const contentType = paid.headers.get("content-type") ?? undefined;
      const result: X402Result = {
        txHash: settlement?.transaction || txHash,
        status: paid.status,
        contentType,
        body: contentType && /^(text\/|application\/(json|xml)|[^;]*\+json)/i.test(contentType) ? buf.subarray(0, MAX_BODY_BYTES).toString("utf8") : undefined,
        truncated: buf.length > MAX_BODY_BYTES || undefined,
        settlement,
      };
      await this.#emit(EVENT_TYPES.x402.executed, r, { decision: "allow", txHash: result.txHash });
      return result;
    } catch (err) {
      await this.#emit(EVENT_TYPES.x402.failed, r, { reasons: [(err as Error).message] });
      throw err;
    }
  }

  // ---- swaps ---------------------------------------------------------------------------------

  /** Quote a swap and check it against policy. Nothing moves; this is the preview. */
  async swapQuote(input: { walletId: string; chain: ChainId; assetIn: string; assetOut: string; amountIn: bigint }): Promise<Preview & { quote: SwapQuote }> {
    const provider = this.d.swap;
    const policy = this.d.policies[input.walletId];
    if (!provider) {
      const p = await this.#open("swap", { walletId: input.walletId, chain: input.chain, asset: input.assetIn, to: "swap:none", amount: input.amountIn }, { rules: () => ({ decision: "deny", reasons: ["swaps_not_enabled"] }) });
      throw new Error(`denied:${p.policy.reasons.join(",")}`);
    }
    const quote = await provider.quote(input);
    const rules = () => checkSwap(policy, quote);
    const p = await this.#open("swap", { walletId: input.walletId, chain: input.chain, asset: input.assetIn, to: `swap:${provider.id}`, amount: input.amountIn }, { swap: quote, rules });
    return Object.assign(p, { quote });
  }

  async swapExecute(previewId: string): Promise<{ txHash: string; amountOut: bigint }> {
    const p = await this.#take(previewId, "swap");
    const quote = this.#plans.get(p.id)!.swap!;
    const r = p.request;
    try {
      const from = await this.d.signer.address(r.chain);
      const result = await this.d.swap!.execute(quote, { from });
      if (result.amountOut < quote.minAmountOut) throw new Error("slippage_exceeded");
      this.#executed.push({ walletId: r.walletId, asset: r.asset, amount: r.amount, at: this.#now() });
      await this.#emit(EVENT_TYPES.swap.executed, r, { decision: "allow", txHash: result.txHash });
      return result;
    } catch (err) {
      await this.#emit(EVENT_TYPES.swap.failed, r, { reasons: [(err as Error).message] });
      throw err;
    }
  }

  async #emit(type: ForgePayEvent["type"], r: TransferRequest, extra: { decision?: string; reasons?: string[]; txHash?: string }) {
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
