import { CreateKeyCommand, GetPublicKeyCommand, KMSClient, SignCommand } from "@aws-sdk/client-kms";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak256, recoverAddress, serializeTransaction, toHex, type Hex, type TransactionSerializable } from "viem";
import { publicKeyToAddress, toAccount } from "viem/accounts";

/**
 * Signing inside AWS KMS: the private key is generated in KMS's HSMs and never
 * leaves them. Each wallet is its own KMS key (ECC_SECG_P256K1, SIGN_VERIFY);
 * this process only ever holds the key id and the public key, and asks KMS to
 * sign a 32-byte digest. Every signature is a CloudTrail event, and IAM decides
 * who may call kms:Sign on which keys.
 *
 * EVM only: KMS secp256k1 keys sign Ethereum-style transactions once the DER
 * signature is converted (low-s normalised, recovery id found by recovery).
 */
export interface SigningBackend {
  readonly name: string;
  createKey(tags: Record<string, string>): Promise<string>;
  /** 65-byte uncompressed secp256k1 point. */
  publicKey(keyId: string): Promise<Uint8Array>;
  /** DER-encoded ECDSA signature over a 32-byte digest. */
  signDigest(keyId: string, digest: Uint8Array): Promise<Uint8Array>;
}

export const awsKmsSigner = (region?: string, policyNote = "A-CARD wallet key"): SigningBackend => {
  const kms = new KMSClient(region ? { region } : {});
  return {
    name: "aws-kms",
    async createKey(tags) {
      const out = await kms.send(
        new CreateKeyCommand({
          KeySpec: "ECC_SECG_P256K1",
          KeyUsage: "SIGN_VERIFY",
          Description: policyNote,
          Tags: Object.entries(tags).map(([TagKey, TagValue]) => ({ TagKey, TagValue })),
        }),
      );
      if (!out.KeyMetadata?.KeyId) throw new Error("KMS created no key");
      return out.KeyMetadata.KeyId;
    },
    async publicKey(keyId) {
      const out = await kms.send(new GetPublicKeyCommand({ KeyId: keyId }));
      if (out.KeySpec !== "ECC_SECG_P256K1" || !out.PublicKey) throw new Error(`KMS key ${keyId} is not a secp256k1 signing key`);
      return spkiToPoint(out.PublicKey);
    },
    async signDigest(keyId, digest) {
      const out = await kms.send(new SignCommand({ KeyId: keyId, Message: digest, MessageType: "DIGEST", SigningAlgorithm: "ECDSA_SHA_256" }));
      if (!out.Signature) throw new Error("KMS returned no signature");
      return out.Signature;
    },
  };
};

/** The SPKI DER for a secp256k1 key ends with the 65-byte uncompressed point. */
export function spkiToPoint(spki: Uint8Array): Uint8Array {
  const p = spki.slice(-65);
  if (p.length !== 65 || p[0] !== 4) throw new Error("unexpected public key encoding");
  return p;
}

const N = secp256k1.Point.CURVE().n;

/** DER ECDSA → (r, s), with s forced into the low half as Ethereum requires. */
export function derToRs(der: Uint8Array): { r: bigint; s: bigint } {
  let i = 0;
  const take = (tag: number) => {
    if (der[i++] !== tag) throw new Error("bad DER signature");
    const len = der[i++]!;
    const v = der.slice(i, i + len);
    i += len;
    return v;
  };
  if (der[i++] !== 0x30) throw new Error("bad DER signature");
  i++; // sequence length
  const big = (b: Uint8Array) => BigInt("0x" + (Buffer.from(b).toString("hex") || "0"));
  const r = big(take(0x02));
  let s = big(take(0x02));
  if (r <= 0n || r >= N || s <= 0n || s >= N) throw new Error("signature out of range");
  if (s > N / 2n) s = N - s;
  return { r, s };
}

const hex32 = (x: bigint) => toHex(x, { size: 32 });

export async function signHash(backend: SigningBackend, keyId: string, address: Hex, hash: Hex) {
  const { r, s } = derToRs(await backend.signDigest(keyId, Buffer.from(hash.slice(2), "hex")));
  for (const yParity of [0, 1] as const) {
    const sig = { r: hex32(r), s: hex32(s), yParity };
    if ((await recoverAddress({ hash, signature: sig })).toLowerCase() === address.toLowerCase()) return sig;
  }
  throw new Error("KMS signature does not match this wallet's address");
}

export async function addressForKey(backend: SigningBackend, keyId: string): Promise<Hex> {
  return publicKeyToAddress(toHex(await backend.publicKey(keyId)));
}

/** A viem account whose only signing path is KMS. */
export function kmsAccount(backend: SigningBackend, keyId: string, address: Hex) {
  return toAccount({
    address,
    async signMessage() {
      throw new Error("message signing is not offered by this provider");
    },
    async signTypedData() {
      throw new Error("typed-data signing is not offered by this provider");
    },
    async signTransaction(tx, opts) {
      const ser = opts?.serializer ?? serializeTransaction;
      const sig = await signHash(backend, keyId, address, keccak256(await ser(tx as TransactionSerializable)));
      return ser(tx as TransactionSerializable, sig);
    },
  });
}
