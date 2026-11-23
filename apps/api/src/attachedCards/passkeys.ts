import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse } from "@simplewebauthn/server";

/**
 * Passkeys (WebAuthn) for approving attached-card purchases. The approval is a
 * signature from the holder's own device (Face ID, fingerprint, device PIN),
 * bound to one purchase: an agent holding an API key cannot produce it.
 * Stored in memory for now, behind a small interface.
 */
export interface PasskeyConfig {
  rpId: string;
  rpName: string;
  /** The dashboard origin(s) the browser ceremony runs on, e.g. https://app.a-card.cc */
  origins: string[];
}

interface StoredPasskey {
  id: string;
  publicKey: Uint8Array<ArrayBuffer>;
  counter: number;
  transports?: string[];
  createdAt: string;
}

export class PasskeyError extends Error {
  constructor(readonly status: 400 | 401 | 404 | 409, readonly code: string, message: string) {
    super(message);
  }
}

export class PasskeyService {
  private creds = new Map<string, StoredPasskey[]>(); // by user id
  private regChallenges = new Map<string, string>(); // user id -> challenge
  private authChallenges = new Map<string, { challenge: string; userId: string; expires: number }>(); // purpose key -> challenge

  constructor(private readonly cfg: PasskeyConfig) {}

  list(userId: string) {
    return (this.creds.get(userId) ?? []).map((c) => ({ id: c.id, created_at: c.createdAt }));
  }

  has(userId: string) {
    return (this.creds.get(userId)?.length ?? 0) > 0;
  }

  async registrationOptions(user: { id: string; email: string; name?: string }) {
    const options = await generateRegistrationOptions({
      rpName: this.cfg.rpName,
      rpID: this.cfg.rpId,
      userName: user.email,
      userDisplayName: user.name ?? user.email,
      userID: new TextEncoder().encode(user.id),
      attestationType: "none",
      excludeCredentials: (this.creds.get(user.id) ?? []).map((c) => ({ id: c.id })),
      authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
    });
    this.regChallenges.set(user.id, options.challenge);
    return options;
  }

  async verifyRegistration(userId: string, response: any) {
    const expectedChallenge = this.regChallenges.get(userId);
    if (!expectedChallenge) throw new PasskeyError(409, "no_registration_pending", "start passkey registration first");
    this.regChallenges.delete(userId);
    let v;
    try {
      v = await verifyRegistrationResponse({ response, expectedChallenge, expectedOrigin: this.cfg.origins, expectedRPID: this.cfg.rpId, requireUserVerification: true });
    } catch (e) {
      throw new PasskeyError(400, "passkey_invalid", `passkey registration failed: ${(e as Error).message}`);
    }
    if (!v.verified || !v.registrationInfo) throw new PasskeyError(400, "passkey_invalid", "passkey registration was not verified");
    const c = v.registrationInfo.credential;
    const list = this.creds.get(userId) ?? [];
    list.push({ id: c.id, publicKey: new Uint8Array(c.publicKey), counter: c.counter, transports: c.transports, createdAt: new Date().toISOString() });
    this.creds.set(userId, list);
    return { id: c.id };
  }

  /** A challenge bound to one purpose (e.g. one purchase), valid for 5 minutes. */
  async authenticationOptions(userId: string, purpose: string) {
    const list = this.creds.get(userId) ?? [];
    if (!list.length) throw new PasskeyError(409, "no_passkey", "register a passkey on your device first");
    const options = await generateAuthenticationOptions({
      rpID: this.cfg.rpId,
      allowCredentials: list.map((c) => ({ id: c.id, transports: c.transports as any })),
      userVerification: "required",
    });
    this.authChallenges.set(purpose, { challenge: options.challenge, userId, expires: Date.now() + 5 * 60_000 });
    return options;
  }

  /** Verifies an assertion for exactly that purpose and user. One use. */
  async verifyAuthentication(userId: string, purpose: string, response: any) {
    const pending = this.authChallenges.get(purpose);
    this.authChallenges.delete(purpose);
    if (!pending || pending.userId !== userId || pending.expires < Date.now()) throw new PasskeyError(401, "passkey_challenge_missing", "ask for a new passkey prompt and try again");
    const cred = (this.creds.get(userId) ?? []).find((c) => c.id === response?.id);
    if (!cred) throw new PasskeyError(401, "passkey_unknown", "that passkey is not registered to you");
    let v;
    try {
      v = await verifyAuthenticationResponse({
        response,
        expectedChallenge: pending.challenge,
        expectedOrigin: this.cfg.origins,
        expectedRPID: this.cfg.rpId,
        credential: { id: cred.id, publicKey: cred.publicKey, counter: cred.counter, transports: cred.transports as any },
        requireUserVerification: true,
      });
    } catch (e) {
      throw new PasskeyError(401, "passkey_invalid", `passkey check failed: ${(e as Error).message}`);
    }
    if (!v.verified) throw new PasskeyError(401, "passkey_invalid", "passkey check failed");
    cred.counter = v.authenticationInfo.newCounter;
    return true;
  }
}
