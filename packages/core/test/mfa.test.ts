import { describe, expect, it } from "vitest";
import { generateSync } from "otplib";
import {
  AuthService,
  generateMfaSecret,
  generateRecoveryCodes,
  hashRecoveryCode,
  mfaKeyUri,
  verifyTotp,
} from "../src/index.js";

/** A live TOTP code for a secret, as an authenticator app would produce. */
function currentCode(secret: string): string {
  return generateSync({ strategy: "totp", secret });
}

describe("TOTP primitives", () => {
  it("verifies a live code and rejects wrong or malformed ones", () => {
    const secret = generateMfaSecret();
    expect(verifyTotp(currentCode(secret), secret)).toBe(true);
    expect(verifyTotp("000000", secret)).toBe(false);
    // otplib throws on malformed input; a bad code must read as invalid, not blow up.
    expect(verifyTotp("not-a-code", secret)).toBe(false);
    expect(verifyTotp("", secret)).toBe(false);
  });

  it("tolerates the spacing authenticator apps display codes with", () => {
    const secret = generateMfaSecret();
    const code = currentCode(secret);
    expect(verifyTotp(`${code.slice(0, 3)} ${code.slice(3)}`, secret)).toBe(true);
  });

  it("builds an otpauth URI an authenticator app can scan", () => {
    const secret = generateMfaSecret();
    const uri = mfaKeyUri("founder@acard.co.za", secret);
    expect(uri.startsWith("otpauth://totp/")).toBe(true);
    expect(uri).toContain("A-CARD");
    expect(uri).toContain(secret);
  });

  it("hashes recovery codes case-insensitively and ignoring the display hyphen", () => {
    const { codes, hashes } = generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    const [code] = codes as [string];
    expect(hashRecoveryCode(code)).toBe(hashes[0]);
    expect(hashRecoveryCode(code.toUpperCase())).toBe(hashes[0]);
    expect(hashRecoveryCode(code.replace("-", ""))).toBe(hashes[0]);
    // Codes are distinct.
    expect(new Set(hashes).size).toBe(10);
  });
});

describe("AuthService: MFA enrolment and login", () => {
  function withUser() {
    const auth = new AuthService();
    const user = auth.registerUser({ email: "founder@acard.co.za", name: "Founder", password: "supersecret" });
    auth.addMembership(user.id, "acct_1", "owner");
    return { auth, user };
  }

  it("logs in without a second factor until MFA is confirmed", () => {
    const { auth, user } = withUser();
    expect(auth.login({ email: user.email, password: "supersecret" }).status).toBe("authenticated");

    // Starting enrolment alone must not lock the user into a second factor.
    auth.beginMfaEnrolment(user.id);
    expect(auth.login({ email: user.email, password: "supersecret" }).status).toBe("authenticated");
  });

  it("requires a code to finish enrolment, then demands one at every login", () => {
    const { auth, user } = withUser();
    const { secret } = auth.beginMfaEnrolment(user.id);
    expect(() => auth.confirmMfaEnrolment(user.id, "000000")).toThrow(/invalid authentication code/);

    const { recoveryCodes } = auth.confirmMfaEnrolment(user.id, currentCode(secret));
    expect(recoveryCodes).toHaveLength(10);

    const result = auth.login({ email: user.email, password: "supersecret" });
    expect(result.status).toBe("mfa_required");
    if (result.status !== "mfa_required") throw new Error("expected a challenge");

    const session = auth.verifyMfaChallenge(result.challengeToken, currentCode(secret));
    expect(session.context.role).toBe("owner");
    expect(auth.resolveSession(session.token)?.user.id).toBe(user.id);
  });

  it("consumes the challenge on a wrong code, so it cannot be brute-forced", () => {
    const { auth, user } = withUser();
    const { secret } = auth.beginMfaEnrolment(user.id);
    auth.confirmMfaEnrolment(user.id, currentCode(secret));

    const result = auth.login({ email: user.email, password: "supersecret" });
    if (result.status !== "mfa_required") throw new Error("expected a challenge");

    expect(() => auth.verifyMfaChallenge(result.challengeToken, "000000")).toThrow(/invalid authentication code/);
    // Even the right code now fails: that challenge is spent.
    expect(() => auth.verifyMfaChallenge(result.challengeToken, currentCode(secret))).toThrow(/expired/);
  });

  it("accepts a recovery code once and never again", () => {
    const { auth, user } = withUser();
    const { secret } = auth.beginMfaEnrolment(user.id);
    const { recoveryCodes } = auth.confirmMfaEnrolment(user.id, currentCode(secret));
    const [code] = recoveryCodes as [string];

    const first = auth.login({ email: user.email, password: "supersecret" });
    if (first.status !== "mfa_required") throw new Error("expected a challenge");
    expect(auth.verifyMfaChallenge(first.challengeToken, code).context.role).toBe("owner");

    const second = auth.login({ email: user.email, password: "supersecret" });
    if (second.status !== "mfa_required") throw new Error("expected a challenge");
    expect(() => auth.verifyMfaChallenge(second.challengeToken, code)).toThrow(/invalid authentication code/);
  });

  it("never exposes the MFA secret or recovery hashes through a session context", () => {
    const { auth, user } = withUser();
    const { secret } = auth.beginMfaEnrolment(user.id);
    auth.confirmMfaEnrolment(user.id, currentCode(secret));

    const result = auth.login({ email: user.email, password: "supersecret" });
    if (result.status !== "mfa_required") throw new Error("expected a challenge");
    const { context } = auth.verifyMfaChallenge(result.challengeToken, currentCode(secret));

    expect(context.user).not.toHaveProperty("passwordHash");
    expect(context.user).not.toHaveProperty("mfaSecret");
    expect(context.user).not.toHaveProperty("mfaRecoveryCodeHashes");
    expect(context.user.mfaEnabled).toBe(true);
  });

  it("needs both the password and a code to disable MFA", () => {
    const { auth, user } = withUser();
    const { secret } = auth.beginMfaEnrolment(user.id);
    auth.confirmMfaEnrolment(user.id, currentCode(secret));

    expect(() => auth.disableMfa(user.id, "wrongpassword", currentCode(secret))).toThrow(/invalid password/);
    expect(() => auth.disableMfa(user.id, "supersecret", "000000")).toThrow(/invalid authentication code/);

    auth.disableMfa(user.id, "supersecret", currentCode(secret));
    expect(auth.login({ email: user.email, password: "supersecret" }).status).toBe("authenticated");
  });

  it("still enforces the login lockout ahead of the MFA challenge", () => {
    const { auth, user } = withUser();
    const { secret } = auth.beginMfaEnrolment(user.id);
    auth.confirmMfaEnrolment(user.id, currentCode(secret));

    for (let i = 0; i < 5; i++) {
      expect(() => auth.login({ email: user.email, password: "wrongwrong" })).toThrow(/invalid email or password/);
    }
    // A correct password now gets the lockout, not a second-factor prompt — the
    // rate limit is not a place to leak that the password was right.
    expect(() => auth.login({ email: user.email, password: "supersecret" })).toThrow(/too many failed login attempts/);
  });
});
