import type { ChainId, SignRequest, SignedTx } from "../types.js";
import type { Signer } from "./index.js";

/**
 * Threshold signer backed by FORGE Custody (openfireblocks): the agent host
 * never holds a key; a quorum of co-signers does. It talks to a service that
 * must provide:
 *
 *   GET  {baseUrl}/v1/vaults/{vaultId}/addresses/{chain}  → { address }
 *   POST {baseUrl}/v1/vaults/{vaultId}/sign
 *        { chain, payload: <hex>, idempotency_key }
 *        → 200 { signature: <hex> }                    signed at once
 *        → 202 { request_id }                          waiting for co-signers
 *   GET  {baseUrl}/v1/sign-requests/{request_id}
 *        → { status: "pending" | "signed" | "rejected", signature? }
 *
 * with `Authorization: Bearer <token>`. THIS CONTRACT IS OURS, written before
 * openfireblocks' API was available to this project. It is tested against a
 * local stand-in only. Check it against the real service and adapt the paths
 * and field names here before this signs anything that matters.
 */
export interface OpenFireblocksConfig {
  baseUrl: string;
  vaultId: string;
  token: string;
  fetchImpl?: typeof fetch;
  /** How long to wait for co-signers. Default 2 minutes. */
  signTimeoutMs?: number;
  pollIntervalMs?: number;
}

export class OpenFireblocksSigner implements Signer {
  readonly id = "openfireblocks";
  readonly #cfg: Required<Omit<OpenFireblocksConfig, "fetchImpl">> & { fetchImpl: typeof fetch };
  #addresses = new Map<ChainId, string>();

  constructor(cfg: OpenFireblocksConfig) {
    this.#cfg = { signTimeoutMs: 120_000, pollIntervalMs: 1_000, fetchImpl: fetch, ...cfg, baseUrl: cfg.baseUrl.replace(/\/+$/, "") };
  }

  async #call(path: string, init: RequestInit = {}) {
    const res = await this.#cfg.fetchImpl(`${this.#cfg.baseUrl}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${this.#cfg.token}`, "content-type": "application/json", ...(init.headers ?? {}) },
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, any>;
    return { status: res.status, body };
  }

  async address(chain: ChainId): Promise<string> {
    const cached = this.#addresses.get(chain);
    if (cached) return cached;
    const { status, body } = await this.#call(`/v1/vaults/${encodeURIComponent(this.#cfg.vaultId)}/addresses/${chain}`);
    if (status !== 200 || typeof body.address !== "string") throw new Error(`openfireblocks: no address for ${chain} (status ${status})`);
    this.#addresses.set(chain, body.address);
    return body.address;
  }

  async sign(req: SignRequest): Promise<SignedTx> {
    const first = await this.#call(`/v1/vaults/${encodeURIComponent(this.#cfg.vaultId)}/sign`, {
      method: "POST",
      body: JSON.stringify({ chain: req.chain, payload: Buffer.from(req.payload).toString("hex"), idempotency_key: globalThis.crypto.randomUUID() }),
    });
    let signature: string | undefined;
    if (first.status === 200) signature = first.body.signature;
    else if (first.status === 202 && typeof first.body.request_id === "string") signature = await this.#await(first.body.request_id);
    else throw new Error(`openfireblocks: sign refused (status ${first.status})`);
    if (typeof signature !== "string") throw new Error("openfireblocks: no signature returned");
    return { chain: req.chain, payload: req.payload, signature, signerId: this.id };
  }

  async #await(requestId: string): Promise<string> {
    const deadline = Date.now() + this.#cfg.signTimeoutMs;
    while (Date.now() < deadline) {
      const { body } = await this.#call(`/v1/sign-requests/${encodeURIComponent(requestId)}`);
      if (body.status === "signed" && typeof body.signature === "string") return body.signature;
      if (body.status === "rejected") throw new Error("openfireblocks: co-signers rejected the request");
      await new Promise((r) => setTimeout(r, this.#cfg.pollIntervalMs));
    }
    throw new Error("openfireblocks: timed out waiting for co-signers");
  }

  toJSON(): Record<string, string> {
    return { id: this.id, vaultId: this.#cfg.vaultId };
  }
}
