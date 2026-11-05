import { generateKeyPairSync, sign as edSign, createHash, type KeyObject } from "node:crypto";
import { TESTNETS, type ChainId, type SignRequest, type SignedTx } from "../types.js";

/** Agents get capabilities, never keys. No implementation may expose key material. */
export interface Signer {
  readonly id: string;
  address(chain: ChainId): Promise<string>;
  sign(request: SignRequest): Promise<SignedTx>;
}

/**
 * Local development signer. Ed25519 key held in memory only.
 * Refuses every non-testnet chain — production must use OpenFireblocksSigner.
 */
export class DevSigner implements Signer {
  readonly id = "dev";
  readonly #privateKey: KeyObject;
  readonly #publicKeyDer: Buffer;

  constructor() {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    this.#privateKey = privateKey;
    this.#publicKeyDer = publicKey.export({ type: "spki", format: "der" });
  }

  async address(chain: ChainId): Promise<string> {
    this.#assertTestnet(chain);
    const h = createHash("sha256").update(this.#publicKeyDer).digest("hex");
    return `${chain}:${h.slice(0, 40)}`;
  }

  async sign(req: SignRequest): Promise<SignedTx> {
    this.#assertTestnet(req.chain);
    const signature = edSign(null, req.payload, this.#privateKey).toString("hex");
    return { chain: req.chain, payload: req.payload, signature, signerId: this.id };
  }

  #assertTestnet(chain: ChainId): void {
    if (!TESTNETS.has(chain)) throw new Error(`DevSigner refuses non-testnet chain: ${chain}`);
  }

  /** Prevent accidental serialisation of the signer (and its key) into logs/output. */
  toJSON(): Record<string, string> {
    return { id: this.id };
  }
}

export { OpenFireblocksSigner, type OpenFireblocksConfig } from "./openfireblocks.js";
