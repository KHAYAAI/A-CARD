import { randomBytes } from "node:crypto";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { USDC_BY_NETWORK, type PaymentRequirement, type TransferAuthorization } from "./protocol.js";

/**
 * Signs the one thing an x402 "exact" payment needs: an EIP-3009
 * `TransferWithAuthorization` over the token, as EIP-712 typed data.
 *
 *   domain  = { name, version, chainId, verifyingContract: token }
 *   message = TransferWithAuthorization(address from, address to, uint256 value,
 *             uint256 validAfter, uint256 validBefore, bytes32 nonce)
 *   digest  = keccak256(0x1901 ‖ domainSeparator ‖ hashStruct(message))
 *
 * The token's domain `name`/`version` come from the requirement's `extra`
 * (the x402 exact-EVM scheme puts them there), falling back to the known
 * USDC deployment. Tested against viem's independent implementation.
 */

export interface X402Signer {
  /**
   * Set by a signer that produces cryptographically meaningless signatures.
   * A real signer omits it, so anything new is treated as carrying real
   * value until it says otherwise — the safe direction.
   */
  readonly isSandbox?: boolean;
  /** The address the signatures recover to, when the signer knows it. */
  readonly address?: string;
  sign(input: {
    requirement: PaymentRequirement;
    from: string;
    value: string;
    validAfter: string;
    validBefore: string;
    nonce: string;
  }): Promise<{ signature: string }>;
}

/** Round-trips the flow so it's testable end to end. Never wire it into a deployment that moves real value: it moves none. */
export const SANDBOX_SIGNER: X402Signer = {
  isSandbox: true,
  async sign() {
    return { signature: `0x${"00".repeat(64)}1b` };
  },
};

const hex = (bytes: Uint8Array) => `0x${Buffer.from(bytes).toString("hex")}`;
const fromHex = (value: string) => Uint8Array.from(Buffer.from(value.replace(/^0x/, ""), "hex"));
const utf8 = (value: string) => new TextEncoder().encode(value);
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
};
const word = (value: bigint) => {
  if (value < 0n || value >= 1n << 256n) throw new Error("uint256 out of range");
  return fromHex(value.toString(16).padStart(64, "0"));
};
const addressWord = (address: string) => {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error(`not an EVM address: ${address}`);
  return word(BigInt(address));
};
const bytes32 = (value: string) => {
  const b = fromHex(value);
  if (b.length !== 32) throw new Error("nonce must be 32 bytes");
  return b;
};

const DOMAIN_TYPEHASH = keccak_256(utf8("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"));
const TRANSFER_TYPEHASH = keccak_256(
  utf8("TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"),
);

/** The EIP-712 digest a `TransferWithAuthorization` signature covers. Exported for tests. */
export function transferAuthorizationDigest(
  domain: { name: string; version: string; chainId: number; verifyingContract: string },
  message: TransferAuthorization,
): Uint8Array {
  const domainSeparator = keccak_256(
    concat(DOMAIN_TYPEHASH, keccak_256(utf8(domain.name)), keccak_256(utf8(domain.version)), word(BigInt(domain.chainId)), addressWord(domain.verifyingContract)),
  );
  const structHash = keccak_256(
    concat(
      TRANSFER_TYPEHASH,
      addressWord(message.from),
      addressWord(message.to),
      word(BigInt(message.value)),
      word(BigInt(message.validAfter)),
      word(BigInt(message.validBefore)),
      bytes32(message.nonce),
    ),
  );
  return keccak_256(concat(Uint8Array.of(0x19, 0x01), domainSeparator, structHash));
}

/** EIP-55 checksummed address for a secp256k1 secret key. */
export function addressFromSecretKey(secretKey: Uint8Array): string {
  const publicKey = secp256k1.getPublicKey(secretKey, false); // 0x04 ‖ X ‖ Y
  const lower = Buffer.from(keccak_256(publicKey.slice(1)).slice(12)).toString("hex");
  const hash = Buffer.from(keccak_256(utf8(lower))).toString("hex");
  return `0x${[...lower].map((c, i) => (parseInt(hash[i]!, 16) >= 8 ? c.toUpperCase() : c)).join("")}`;
}

export function domainFor(requirement: PaymentRequirement) {
  const chainId = Number(/^eip155:(\d+)$/.exec(requirement.network)?.[1]);
  if (!Number.isSafeInteger(chainId)) throw new Error(`not an EVM network: ${requirement.network}`);
  const known = USDC_BY_NETWORK[requirement.network];
  return {
    name: typeof requirement.extra?.name === "string" ? requirement.extra.name : (known?.name ?? ""),
    version: typeof requirement.extra?.version === "string" ? requirement.extra.version : (known?.version ?? ""),
    chainId,
    verifyingContract: requirement.asset,
  };
}

/**
 * A real signer over a raw secp256k1 key. Holding the key in process memory
 * is the simplest custody there is, fit for a testnet float or a small hot
 * wallet; anything larger belongs in a KMS or custody provider behind this
 * same interface.
 */
export function createEip3009Signer(privateKeyHex: string): X402Signer & { address: string } {
  const secretKey = fromHex(privateKeyHex);
  if (secretKey.length !== 32) throw new Error("x402 signer key must be 32 bytes of hex");
  const address = addressFromSecretKey(secretKey);
  return {
    address,
    async sign(input) {
      const digest = transferAuthorizationDigest(domainFor(input.requirement), {
        from: input.from,
        to: input.requirement.payTo,
        value: input.value,
        validAfter: input.validAfter,
        validBefore: input.validBefore,
        nonce: input.nonce,
      });
      // noble's "recovered" format is recovery ‖ r ‖ s; Ethereum wants r ‖ s ‖ v, v = 27 + recovery.
      const sig = secp256k1.sign(digest, secretKey, { prehash: false, format: "recovered" });
      return { signature: hex(concat(sig.slice(1), Uint8Array.of(27 + sig[0]!))) };
    },
  };
}

/** A fresh 32-byte EIP-3009 nonce. */
export const newNonce = () => hex(randomBytes(32));
