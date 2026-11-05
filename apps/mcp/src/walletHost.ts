import { createHash, timingSafeEqual } from "node:crypto";
import { devWallet, MemoryApprovalStore, stderrSink, type EventSink, type WalletService } from "@acard/agent-wallet";

/**
 * The sandbox wallet for the hosted (HTTP) MCP server.
 *
 * The HTTP server is stateless per request, but a wallet isn't: it has a
 * balance, previews waiting to be executed, and approvals waiting for a
 * person. So wallets live here, one per A-CARD API key, in this process's
 * memory. That means:
 *
 *   - run ONE instance (or sticky routing by key) while the wallet is on;
 *     two instances would each hold a different wallet for the same key
 *   - a restart resets every wallet to its starting test funds
 *   - it is the sandbox wallet: a mock chain, no real funds
 *
 * Approvals are decided by an operator over HTTP, authenticated with a
 * separate secret the agent never has (the agent only holds its A-CARD API
 * key). Approval ids are random UUIDs.
 *
 *   GET  /wallet/approvals                  pending ids
 *   POST /wallet/approvals/:id/approve      (or /reject)
 *   Authorization: Bearer <ACARD_WALLET_OPERATOR_TOKEN>
 */
export interface WalletHostOptions {
  operatorToken: string;
  /** Wallets kept at once; the least recently created is dropped past this. Default 1000. */
  maxWallets?: number;
  sink?: EventSink;
  /** Sandbox/tests only: let x402 reach private-network URLs. */
  x402AllowPrivateNetworks?: boolean;
}

const sha = (v: string) => createHash("sha256").update(v).digest();
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export class WalletHost {
  readonly #wallets = new Map<string, Promise<WalletService>>();
  readonly #approvals = new MemoryApprovalStore();
  readonly #operator: Buffer;
  readonly #max: number;

  constructor(private readonly opts: WalletHostOptions) {
    if (opts.operatorToken.length < 24) throw new Error("ACARD_WALLET_OPERATOR_TOKEN must be at least 24 characters");
    this.#operator = sha(opts.operatorToken);
    this.#max = opts.maxWallets ?? 1000;
  }

  /** The caller's wallet, created with the sandbox starting funds on first use. */
  forKey(apiKey: string): Promise<WalletService> {
    const id = sha(apiKey).toString("hex");
    let wallet = this.#wallets.get(id);
    if (!wallet) {
      wallet = devWallet({ approvals: this.#approvals, sink: this.opts.sink ?? stderrSink, x402AllowPrivateNetworks: this.opts.x402AllowPrivateNetworks });
      this.#wallets.set(id, wallet);
      if (this.#wallets.size > this.#max) this.#wallets.delete(this.#wallets.keys().next().value!);
    }
    return wallet;
  }

  /** Operator routes. Returns undefined for any path that isn't one of them. */
  async handleOperator(request: Request): Promise<Response | undefined> {
    const path = new URL(request.url).pathname;
    if (!path.startsWith("/wallet/approvals")) return undefined;

    const auth = request.headers.get("authorization") ?? "";
    const presented = auth.startsWith("Bearer ") ? sha(auth.slice(7)) : Buffer.alloc(32);
    if (!timingSafeEqual(presented, this.#operator)) return json(401, { error: "operator token required" });

    if (request.method === "GET" && path === "/wallet/approvals") return json(200, { pending: this.#approvals.pending() });
    const match = /^\/wallet\/approvals\/([0-9a-f-]{36})\/(approve|reject)$/.exec(path);
    if (request.method === "POST" && match) {
      try {
        this.#approvals.decide(match[1]!, match[2] === "approve");
        return json(200, { approval_id: match[1], status: match[2] === "approve" ? "approved" : "rejected" });
      } catch {
        return json(404, { error: "not a pending approval" });
      }
    }
    return json(404, { error: "not found" });
  }
}
