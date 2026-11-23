import { MemoryPasskeyStore, type PasskeyStore } from "./store.js";
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

export class PasskeyError extends Error {
  constructor(readonly status: 400 | 401 | 404 | 409, readonly code: string, message: string) {
    super(message);
  }
}

export class PasskeyService {
  constructor(private readonly cfg: PasskeyConfig, readonly store: PasskeyStore = new MemoryPasskeyStore()) {}

  async list(userId: string) {
    return (await this.store.listCredentials(userId)).map((c) => ({ id: c.id, created_at: c.createdAt }));
  }

  async registrationOptions(user: { id: string; email: string; name?: string }) {
    const options = await generateRegistrationOptions({
      rpName: this.cfg.rpName,
      rpID: this.cfg.rpId,
      userName: user.email,
      userDisplayName: user.name ?? user.email,
      userID: new TextEncoder().encode(user.id),
      attestationType: "none",
      excludeCredentials: (await this.store.listCredentials(user.id)).map((c) => ({ id: c.id })),
      authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
    });
    await this.store.putChallenge(`reg:${user.id}`, { challenge: options.challenge, userId: user.id, expires: Date.now() + 5 * 60_000 });
    return options;
  }

  async verifyRegistration(userId: string, response: any) {
    const pending = await this.store.takeChallenge(`reg:${userId}`);
    if (!pending || pending.userId !== userId || pending.expires < Date.now()) throw new PasskeyError(409, "no_registration_pending", "start passkey registration first");
    let v;
    try {
      v = await verifyRegistrationResponse({ response, expectedChallenge: pending.challenge, expectedOrigin: this.cfg.origins, expectedRPID: this.cfg.rpId, requireUserVerification: true });
    } catch (e) {
      throw new PasskeyError(400, "passkey_invalid", `passkey registration failed: ${(e as Error).message}`);
    }
    if (!v.verified || !v.registrationInfo) throw new PasskeyError(400, "passkey_invalid", "passkey registration was not verified");
    const c = v.registrationInfo.credential;
    await this.store.addCredential({ id: c.id, userId, publicKey: new Uint8Array(c.publicKey), counter: c.counter, transports: c.transports, createdAt: new Date().toISOString() });
    return { id: c.id };
  }

  /** A challenge bound to one purpose (e.g. one purchase), valid for 5 minutes. */
  async authenticationOptions(userId: string, purpose: string) {
    const list = await this.store.listCredentials(userId);
    if (!list.length) throw new PasskeyError(409, "no_passkey", "register a passkey on your device first");
    const options = await generateAuthenticationOptions({
      rpID: this.cfg.rpId,
      allowCredentials: list.map((c) => ({ id: c.id, transports: c.transports as any })),
      userVerification: "required",
    });
    await this.store.putChallenge(purpose, { challenge: options.challenge, userId, expires: Date.now() + 5 * 60_000 });
    return options;
  }

  /** Verifies an assertion for exactly that purpose and user. One use, even across API instances. */
  async verifyAuthentication(userId: string, purpose: string, response: any) {
    const pending = await this.store.takeChallenge(purpose);
    if (!pending || pending.userId !== userId || pending.expires < Date.now()) throw new PasskeyError(401, "passkey_challenge_missing", "ask for a new passkey prompt and try again");
    const cred = (await this.store.listCredentials(userId)).find((c) => c.id === response?.id);
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
    await this.store.updateCounter(cred.id, v.authenticationInfo.newCounter);
    return true;
  }
}
