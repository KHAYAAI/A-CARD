import { createHash, randomBytes } from "node:crypto";
import { generateSecret, generateURI, verifySync } from "otplib";

/**
 * TOTP (RFC 6238) multi-factor authentication for human logins.
 *
 * The algorithm itself comes from `otplib` — this module owns the parts that
 * are ours: enrolment state, the one-step-either-side clock tolerance, and
 * single-use recovery codes so a lost authenticator device is not a permanent
 * lockout.
 *
 * Recovery codes are treated exactly like session tokens and API keys
 * elsewhere in this codebase: shown once at enrolment, stored only as SHA-256
 * hashes, and consumed on use.
 *
 * The TOTP secret itself cannot be hashed (verification needs the original),
 * so it is stored as-is and relies on encryption at rest — RDS is provisioned
 * with `storageEncrypted: true` in `infra/cdk`. Application-level envelope
 * encryption of this column is a reasonable follow-up once key management
 * exists, but it is deliberately not faked here.
 */

export const MFA_ISSUER = "A-CARD";
export const RECOVERY_CODE_COUNT = 10;

/**
 * Accept one 30s step either side of now, so a slightly-skewed device clock
 * still authenticates. Wider than this starts meaningfully extending the
 * window in which a shoulder-surfed code stays usable.
 */
const EPOCH_TOLERANCE_SECONDS = 30;

export function generateMfaSecret(): string {
  return generateSecret();
}

/** The `otpauth://` URI an authenticator app consumes, usually via a QR code. */
export function mfaKeyUri(accountName: string, secret: string): string {
  return generateURI({ strategy: "totp", issuer: MFA_ISSUER, label: accountName, secret });
}

export function verifyTotp(token: string, secret: string): boolean {
  // otplib rejects malformed input (non-numeric, wrong length) by throwing
  // rather than returning invalid; a bad code is an expected outcome here.
  try {
    return verifySync({
      strategy: "totp",
      secret,
      token: token.replace(/\s+/g, ""),
      epochTolerance: EPOCH_TOLERANCE_SECONDS,
    }).valid;
  } catch {
    return false;
  }
}

export function hashRecoveryCode(code: string): string {
  return createHash("sha256").update(normalizeRecoveryCode(code)).digest("hex");
}

/** Compare case-insensitively and ignore the display hyphen. */
export function normalizeRecoveryCode(code: string): string {
  return code.replace(/-/g, "").trim().toLowerCase();
}

/** Returns the plaintext codes (shown once) alongside the hashes to store. */
export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT): { codes: string[]; hashes: string[] } {
  const codes = Array.from({ length: count }, () => {
    const raw = randomBytes(5).toString("hex"); // 10 hex chars
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
  return { codes, hashes: codes.map(hashRecoveryCode) };
}
