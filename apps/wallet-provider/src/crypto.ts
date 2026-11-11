import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import { base58 } from "@scure/base";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Chain } from "./types.js";

/**
 * Key generation and encryption at rest.
 *
 * Keys are generated here, from the operating system's CSPRNG, and are never
 * returned by any endpoint. At rest each key is sealed with AES-256-GCM under
 * a per-record key derived (HKDF-SHA256) from the operator's master key and a
 * random salt, with the wallet's identity bound in as additional data so a
 * sealed key can't be moved to a different wallet record.
 *
 * What this does NOT do: it does not protect against someone who has both the
 * store file and the master key, or who can run code inside this process. For
 * real funds the master key belongs in a KMS/HSM and signing in a hardened
 * enclave; see README.md.
 */

export interface SealedKey {
  v: 1;
  salt: string; // base64
  iv: string;
  tag: string;
  ct: string;
}

const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
const unb64 = (s: string) => Buffer.from(s, "base64");

/** Accepts 32 bytes as 64 hex characters or base64. Anything else is refused. */
export function parseMasterKey(raw: string): Buffer {
  const t = raw.trim();
  const key = /^[0-9a-fA-F]{64}$/.test(t) ? Buffer.from(t, "hex") : Buffer.from(t, "base64");
  if (key.length !== 32) throw new Error("PROVIDER_MASTER_KEY must be 32 bytes (64 hex characters, or base64)");
  if (key.every((x) => x === key[0])) throw new Error("PROVIDER_MASTER_KEY is a constant byte string; generate a random one (openssl rand -hex 32)");
  return key;
}

const aad = (userId: string, chain: Chain, address: string) => Buffer.from(`acard-wallet-provider/v1|${userId}|${chain}|${address}`);

export function seal(master: Buffer, secret: Uint8Array, userId: string, chain: Chain, address: string): SealedKey {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = Buffer.from(hkdfSync("sha256", master, salt, "acard-wallet-provider/record-key", 32));
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad(userId, chain, address));
  const ct = Buffer.concat([cipher.update(secret), cipher.final()]);
  key.fill(0);
  return { v: 1, salt: b64(salt), iv: b64(iv), tag: b64(cipher.getAuthTag()), ct: b64(ct) };
}

/** Returns the secret, or throws if the master key is wrong or the record was altered or moved. */
export function open(master: Buffer, sealed: SealedKey, userId: string, chain: Chain, address: string): Buffer {
  const key = Buffer.from(hkdfSync("sha256", master, unb64(sealed.salt), "acard-wallet-provider/record-key", 32));
  try {
    const d = createDecipheriv("aes-256-gcm", key, unb64(sealed.iv));
    d.setAAD(aad(userId, chain, address));
    d.setAuthTag(unb64(sealed.tag));
    return Buffer.concat([d.update(unb64(sealed.ct)), d.final()]);
  } catch {
    throw new Error("could not unseal the key: wrong master key, or the record was altered");
  } finally {
    key.fill(0);
  }
}

export interface NewKey {
  address: string;
  secret: Buffer;
}

/** A fresh key and its address. EVM: secp256k1, EIP-55 checksummed. Solana: ed25519, base58 public key. */
export function generateKey(chain: Chain): NewKey {
  if (chain === "solana") {
    const secret = Buffer.from(ed25519.utils.randomSecretKey());
    return { address: base58.encode(ed25519.getPublicKey(secret)), secret };
  }
  const hex = generatePrivateKey();
  return { address: privateKeyToAccount(hex).address, secret: Buffer.from(hex.slice(2), "hex") };
}

export const toHex = (secret: Uint8Array) => `0x${Buffer.from(secret).toString("hex")}` as `0x${string}`;
