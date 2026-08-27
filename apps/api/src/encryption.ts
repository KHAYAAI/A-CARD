import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * AES-256-GCM at the Postgres storage boundary for card credential fields
 * (today: `sandbox_pan`). Deliberately scoped to the Postgres backend only —
 * the in-memory `Platform`/`Card` object always holds plaintext at runtime
 * (the rules engine, redaction, and the CLI's one-time reveal all need it),
 * and the JSONB snapshot persistence mode (`ACARD_PERSISTENCE=snapshot`) is
 * explicitly the non-default, single-instance legacy path — see
 * `apps/api/src/persistence.ts`. Encrypting that path too is a reasonable
 * follow-up, not done here.
 *
 * A real issuer keeps PANs out of this system entirely (see `cards.ts`'s
 * design comment) — this hardens what's stored today (a sandbox
 * `4242…` test PAN) and whatever a real deployment stores before that
 * migration happens, rather than waiting for it.
 */

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

/**
 * Reads `ACARD_ENCRYPTION_KEY` (64 hex chars = 32 bytes, for AES-256). If
 * unset, generates a random per-process key so local/dev/test runs keep
 * working without configuration — but data encrypted with it is NOT
 * decryptable after a restart, so this is loud on purpose. Production
 * deployments must set a real, persisted key.
 */
export function loadEncryptionKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  const hex = env.ACARD_ENCRYPTION_KEY;
  if (hex) {
    const key = Buffer.from(hex, "hex");
    if (key.length !== 32) {
      throw new Error(
        `ACARD_ENCRYPTION_KEY must be 64 hex characters (32 bytes) for AES-256-GCM; got ${key.length} bytes. Generate one with: openssl rand -hex 32`,
      );
    }
    return key;
  }
  console.warn(
    "ACARD_ENCRYPTION_KEY not set — generating a random per-process key. " +
      "Card data encrypted this run will NOT be decryptable after a restart. " +
      "Set ACARD_ENCRYPTION_KEY (openssl rand -hex 32) before storing real card data.",
  );
  return randomBytes(32);
}

/** Encrypts to a single self-contained base64 string: iv (12B) + authTag (16B) + ciphertext. */
export function encryptField(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString("base64");
}

/** Inverse of `encryptField`. Throws if the auth tag doesn't verify — tampered or wrong key. */
export function decryptField(packed: string, key: Buffer): string {
  const buf = Buffer.from(packed, "base64");
  const iv = buf.subarray(0, IV_LENGTH);
  const tag = buf.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = buf.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
