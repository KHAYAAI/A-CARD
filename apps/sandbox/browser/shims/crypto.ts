/**
 * Browser stand-in for the few node:crypto functions the platform uses
 * (hashing, HMAC, random ids, scrypt password hashing, an Ed25519 dev
 * signer, constant-time compare), built on audited noble libraries.
 * Encryption-at-rest (createCipheriv) is not used by the sandbox and throws.
 */
import { Buffer } from "buffer";
import { sha256 } from "@noble/hashes/sha2.js";
import { md5 } from "@noble/hashes/legacy.js";
import { hmac } from "@noble/hashes/hmac.js";
import { scrypt } from "@noble/hashes/scrypt.js";
import { ed25519 } from "@noble/curves/ed25519.js";

const bytes = (d: string | Uint8Array | Buffer): Uint8Array => (typeof d === "string" ? new TextEncoder().encode(d) : d);
const out = (u: Uint8Array, enc?: string): any => (enc ? Buffer.from(u).toString(enc as BufferEncoding) : Buffer.from(u));

class Hasher {
  #chunks: Uint8Array[] = [];
  constructor(private readonly algo: "sha256" | "md5", private readonly key?: Uint8Array) {}
  update(d: string | Uint8Array | Buffer) {
    this.#chunks.push(bytes(d));
    return this;
  }
  digest(enc?: string) {
    const all = Buffer.concat(this.#chunks);
    const f = this.algo === "md5" ? md5 : sha256;
    return out(this.key ? hmac(f, this.key, all) : f(all), enc);
  }
}
const algo = (a: string) => {
  const n = a.toLowerCase();
  if (n !== "sha256" && n !== "md5") throw new Error(`hash ${a} is not available in the browser sandbox`);
  return n as "sha256" | "md5";
};

export const createHash = (a: string) => new Hasher(algo(a));
export const createHmac = (a: string, key: string | Uint8Array) => new Hasher(algo(a), bytes(key));
export const randomBytes = (n: number) => Buffer.from(crypto.getRandomValues(new Uint8Array(n)));
export const randomUUID = () => crypto.randomUUID();
export const timingSafeEqual = (a: Uint8Array, b: Uint8Array) => {
  if (a.length !== b.length) throw new RangeError("Input buffers must have the same byte length");
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i]! ^ b[i]!;
  return d === 0;
};
export const scryptSync = (password: string | Uint8Array, salt: string | Uint8Array, keylen: number) =>
  Buffer.from(scrypt(bytes(password), bytes(salt), { N: 16384, r: 8, p: 1, dkLen: keylen }));

// Ed25519 dev signer. SPKI DER for ed25519 = fixed 12-byte prefix + 32-byte public key.
export type KeyObject = { secret: Uint8Array; pub: Uint8Array; export(o: { type: string; format: string }): Buffer };
export const generateKeyPairSync = (_type: "ed25519") => {
  const secret = ed25519.utils.randomSecretKey();
  const pub = ed25519.getPublicKey(secret);
  const prefix = Buffer.from("302a300506032b6570032100", "hex");
  const key: KeyObject = { secret, pub, export: () => Buffer.concat([prefix, pub]) };
  return { privateKey: key, publicKey: key };
};
export const sign = (_alg: null, data: Uint8Array, key: KeyObject) => Buffer.from(ed25519.sign(data, key.secret));
export const createCipheriv = () => {
  throw new Error("encryption at rest is not available in the browser sandbox");
};
export const createDecipheriv = createCipheriv;
