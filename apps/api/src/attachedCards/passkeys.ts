import { createHash, randomBytes, randomUUID } from "node:crypto";
import { MemoryPasskeyStore, type PasskeyStore, type SecurityEvent } from "./store.js";
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

/** After a recovery, approvals and rule increases wait this long, in case it wasn't really the holder. */
export const RECOVERY_COOLDOWN_MS = 24 * 60 * 60_000;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O, 1/I
const normalise = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, "");
const hashCode = (userId: string, code: string) => createHash("sha256").update(`acard-recovery:${userId}:${normalise(code)}`).digest("hex");
const newCode = () => { const b = randomBytes(10); let s = ""; for (const x of b) s += CODE_ALPHABET[x % 32]; return `${s.slice(0, 5)}-${s.slice(5)}`; };

export class PasskeyError extends Error {
  constructor(readonly status: 400 | 401 | 403 | 404 | 409 | 429, readonly code: string, message: string) {
    super(message);
  }
}

export class PasskeyService {
  constructor(private readonly cfg: PasskeyConfig, readonly store: PasskeyStore = new MemoryPasskeyStore()) {}

  async list(userId: string) {
    return (await this.store.listCredentials(userId)).map((c) => ({ id: c.id, created_at: c.createdAt }));
  }

  async status(userId: string) {
    const [passkeys, codes, until, events] = await Promise.all([this.list(userId), this.store.countRecoveryCodes(userId), this.store.getCooldown(userId), this.store.listEvents(userId)]);
    const cooling = until && until > Date.now() ? new Date(until).toISOString() : null;
    return { passkeys, recovery_codes: codes, cooldown_until: cooling, events: events.map((e) => ({ kind: e.kind, at: e.at, detail: e.detail ?? null })) };
  }

  /** Approvals and rule increases are paused for a day after a recovery. */
  async inCooldown(userId: string) {
    const until = await this.store.getCooldown(userId);
    return until !== undefined && until > Date.now() ? until : undefined;
  }

  private async event(userId: string, kind: SecurityEvent["kind"], detail?: Record<string, unknown>) {
    await this.store.addEvent({ id: randomUUID(), userId, kind, detail, at: new Date().toISOString() });
  }

  /** Issue 10 fresh one-time recovery codes (shown once; only hashes are kept), replacing any old ones. */
  async issueRecoveryCodes(userId: string): Promise<string[]> {
    const codes = Array.from({ length: 10 }, newCode);
    await this.store.setRecoveryCodes(userId, codes.map((c) => hashCode(userId, c)));
    await this.event(userId, "recovery_codes_issued");
    return codes;
  }

  /**
   * Lost phone: a recovery code (plus the caller's password, checked by the
   * route) removes every passkey, so whoever has the old phone can't approve
   * anything, and starts a cooling-off period before the new passkey can.
   */
  async recover(userId: string, code: string) {
    if (!(await this.store.consumeRecoveryCode(userId, hashCode(userId, code)))) {
      await this.event(userId, "recovery_code_failed");
      const fails = (await this.store.listEvents(userId)).filter((e) => e.kind === "recovery_code_failed" && Date.parse(e.at) > Date.now() - 60 * 60_000).length;
      if (fails > 5) throw new PasskeyError(429, "too_many_attempts", "too many wrong recovery codes; try again in an hour");
      throw new PasskeyError(401, "recovery_code_invalid", "that recovery code is wrong or already used");
    }
    const removed = await this.store.deleteAllCredentials(userId);
    const until = Date.now() + RECOVERY_COOLDOWN_MS;
    await this.store.setCooldown(userId, until);
    await this.event(userId, "recovered", { passkeys_removed: removed });
    return { passkeys_removed: removed, cooldown_until: new Date(until).toISOString(), recovery_codes_left: (await this.store.countRecoveryCodes(userId)).unused };
  }

  /** Remove one passkey (say, a lost phone) by signing with ANOTHER registered passkey. */
  async removalOptions(userId: string, credentialId: string) {
    const list = await this.store.listCredentials(userId);
    if (!list.some((c) => c.id === credentialId)) throw new PasskeyError(404, "passkey_not_found", "no such passkey");
    const others = list.filter((c) => c.id !== credentialId);
    if (!others.length) throw new PasskeyError(409, "last_passkey", "this is your only passkey: use a recovery code instead");
    const options = await generateAuthenticationOptions({ rpID: this.cfg.rpId, allowCredentials: others.map((c) => ({ id: c.id, transports: c.transports as any })), userVerification: "required" });
    await this.store.putChallenge(`remove:${credentialId}`, { challenge: options.challenge, userId, expires: Date.now() + 5 * 60_000 });
    return options;
  }

  async remove(userId: string, credentialId: string, response: any) {
    if (response?.id === credentialId) throw new PasskeyError(401, "passkey_invalid", "sign with a different passkey than the one you're removing");
    await this.verifyAuthentication(userId, `remove:${credentialId}`, response);
    if (!(await this.store.deleteCredential(userId, credentialId))) throw new PasskeyError(404, "passkey_not_found", "no such passkey");
    await this.event(userId, "passkey_removed", { id: credentialId });
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
    await this.event(userId, "passkey_added", { id: c.id });
    // The first passkey comes with recovery codes, shown once.
    const codes = (await this.store.countRecoveryCodes(userId)).unused === 0 ? await this.issueRecoveryCodes(userId) : undefined;
    return { id: c.id, recovery_codes: codes };
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
