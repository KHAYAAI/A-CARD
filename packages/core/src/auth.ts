import { randomBytes, scryptSync, timingSafeEqual, createHash } from "node:crypto";
import { newId } from "./ids.js";
import { DomainError, InvalidStateError, NotFoundError } from "./errors.js";
import { generateMfaSecret, generateRecoveryCodes, hashRecoveryCode, mfaKeyUri, verifyTotp } from "./mfa.js";

/**
 * Human authentication and role-based access control for the dashboard.
 *
 * This is a separate boundary from the API key. The API key is a tenant-wide
 * programmatic credential (agents, CLI, MCP) — full access, no user identity.
 * This layer adds *people*: a `User` (email + password) belongs to one or more
 * account holders (the org that owns a wallet) as a `Member` with a `Role`,
 * and authenticates with a server-side `Session`. Passwords are scrypt-hashed;
 * session tokens are shown once and stored only as a SHA-256 hash.
 */

export type Role = "owner" | "admin" | "member" | "viewer";

/** Higher rank ⇒ more capability. Used by `roleAtLeast`. */
export const ROLE_RANK: Record<Role, number> = { viewer: 0, member: 1, admin: 2, owner: 3 };

export function roleAtLeast(role: Role, min: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[min];
}

export interface User {
  id: string;
  email: string;
  name: string;
  passwordHash: string;
  createdAt: string;
  /** TOTP shared secret. Present once enrolment starts, before it is confirmed. */
  mfaSecret?: string;
  /** Only true after a first valid code proves the authenticator is working. */
  mfaEnabled?: boolean;
  /** SHA-256 of each unused recovery code; entries are removed as they are consumed. */
  mfaRecoveryCodeHashes?: string[];
}

export interface Membership {
  userId: string;
  /** The account holder / org this membership grants access to. */
  accountHolderId: string;
  role: Role;
  createdAt: string;
}

export interface Session {
  /** SHA-256 of the raw token — the raw value is returned once and never stored. */
  hashedToken: string;
  userId: string;
  /** Active org for this session (a user may belong to several). */
  accountHolderId: string;
  createdAt: string;
  expiresAt: string;
}

export interface SessionContext {
  user: PublicUser;
  accountHolderId: string;
  role: Role;
}

/**
 * A pending second factor. Password verification succeeded, but no session
 * exists yet — the challenge is exchanged for one by presenting a valid TOTP
 * or recovery code. Short-lived and single-use, so an intercepted challenge is
 * worth little on its own.
 */
export interface MfaChallenge {
  hashedToken: string;
  userId: string;
  accountHolderId: string;
  expiresAt: string;
}

/** What a login returns: either a session, or the demand for a second factor. */
export type LoginResult =
  | { status: "authenticated"; token: string; session: Session; context: SessionContext }
  | { status: "mfa_required"; challengeToken: string };

export const MFA_CHALLENGE_TTL_MS = 1000 * 60 * 5; // 5 minutes

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days

/**
 * Per-account login lockout. The WAF rate limit on `/v1/auth/login` (see
 * `infra/cdk`) stops a flood from one IP; this catches the distributed case —
 * an attacker rotating IPs against a single email — which no IP-keyed rule can.
 */
export const LOGIN_LOCKOUT_THRESHOLD = 5;
export const LOGIN_LOCKOUT_WINDOW_MS = 1000 * 60 * 15; // 15 minutes

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, 64);
  return `scrypt$${salt.toString("hex")}$${derived.toString("hex")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, saltHex, hashHex] = stored.split("$");
  if (scheme !== "scrypt" || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const derived = scryptSync(password, Buffer.from(saltHex, "hex"), expected.length);
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** A user as it may cross the API boundary: no password hash, no MFA material. */
export type PublicUser = Omit<User, "passwordHash" | "mfaSecret" | "mfaRecoveryCodeHashes">;

export function publicUser(user: User): PublicUser {
  const { passwordHash: _hash, mfaSecret: _secret, mfaRecoveryCodeHashes: _codes, ...rest } = user;
  return rest;
}

/**
 * In-memory users / memberships / sessions, serializable with the rest of the
 * platform. The Postgres store implements the same behaviour in SQL.
 */
export class AuthService {
  private readonly users = new Map<string, User>();
  private readonly usersByEmail = new Map<string, string>();
  private readonly memberships: Membership[] = [];
  private readonly sessions = new Map<string, Session>();
  /** email (lowercased) -> timestamps (ms) of recent failed login attempts. Not persisted — resetting on restart is an acceptable trade-off for an in-memory security counter. */
  private readonly failedLoginAttempts = new Map<string, number[]>();
  /** Pending second factors, keyed by hashed challenge token. Short-lived, so not persisted. */
  private readonly mfaChallenges = new Map<string, MfaChallenge>();

  serialize(): { users: User[]; memberships: Membership[]; sessions: Session[] } {
    return { users: [...this.users.values()], memberships: this.memberships, sessions: [...this.sessions.values()] };
  }

  static hydrate(data: { users: User[]; memberships: Membership[]; sessions: Session[] }): AuthService {
    const service = new AuthService();
    for (const user of data.users ?? []) {
      service.users.set(user.id, user);
      service.usersByEmail.set(user.email.toLowerCase(), user.id);
    }
    service.memberships.push(...(data.memberships ?? []));
    for (const session of data.sessions ?? []) service.sessions.set(session.hashedToken, session);
    return service;
  }

  registerUser(input: { email: string; name: string; password: string }): User {
    const email = input.email.toLowerCase();
    if (this.usersByEmail.has(email)) {
      throw new InvalidStateError(`a user with email ${input.email} already exists`);
    }
    if (input.password.length < 8) {
      throw new DomainError("weak_password", "password must be at least 8 characters");
    }
    const user: User = {
      id: newId("usr"),
      email,
      name: input.name,
      passwordHash: hashPassword(input.password),
      createdAt: new Date().toISOString(),
    };
    this.users.set(user.id, user);
    this.usersByEmail.set(email, user.id);
    return user;
  }

  getUserByEmail(email: string): User | undefined {
    const id = this.usersByEmail.get(email.toLowerCase());
    return id ? this.users.get(id) : undefined;
  }

  getUser(id: string): User {
    const user = this.users.get(id);
    if (!user) throw new NotFoundError("user", id);
    return user;
  }

  addMembership(userId: string, accountHolderId: string, role: Role): Membership {
    this.getUser(userId);
    const existing = this.memberships.find((m) => m.userId === userId && m.accountHolderId === accountHolderId);
    if (existing) {
      existing.role = role;
      return existing;
    }
    const membership: Membership = { userId, accountHolderId, role, createdAt: new Date().toISOString() };
    this.memberships.push(membership);
    return membership;
  }

  membershipsForUser(userId: string): Membership[] {
    return this.memberships.filter((m) => m.userId === userId);
  }

  membersOf(accountHolderId: string): Membership[] {
    return this.memberships.filter((m) => m.accountHolderId === accountHolderId);
  }

  getMembership(userId: string, accountHolderId: string): Membership | undefined {
    return this.memberships.find((m) => m.userId === userId && m.accountHolderId === accountHolderId);
  }

  private recentFailedAttempts(email: string): number[] {
    const key = email.toLowerCase();
    const windowStart = Date.now() - LOGIN_LOCKOUT_WINDOW_MS;
    const attempts = (this.failedLoginAttempts.get(key) ?? []).filter((t) => t > windowStart);
    this.failedLoginAttempts.set(key, attempts);
    return attempts;
  }

  private recordFailedLogin(email: string): void {
    const attempts = this.recentFailedAttempts(email);
    attempts.push(Date.now());
    this.failedLoginAttempts.set(email.toLowerCase(), attempts);
  }

  private clearFailedLogins(email: string): void {
    this.failedLoginAttempts.delete(email.toLowerCase());
  }

  /**
   * Verify credentials. Returns a session for users without MFA; for users
   * with MFA enabled it returns a challenge that must be exchanged via
   * `verifyMfaChallenge` before any session exists.
   */
  login(input: { email: string; password: string; accountHolderId?: string }): LoginResult {
    if (this.recentFailedAttempts(input.email).length >= LOGIN_LOCKOUT_THRESHOLD) {
      throw new DomainError("account_locked", "too many failed login attempts — try again in a few minutes", 429);
    }
    const user = this.getUserByEmail(input.email);
    if (!user || !verifyPassword(input.password, user.passwordHash)) {
      this.recordFailedLogin(input.email);
      throw new DomainError("invalid_credentials", "invalid email or password", 401);
    }
    this.clearFailedLogins(input.email);
    const memberships = this.membershipsForUser(user.id);
    const membership =
      (input.accountHolderId && memberships.find((m) => m.accountHolderId === input.accountHolderId)) || memberships[0];
    if (!membership) throw new DomainError("no_membership", "user has no organization", 403);

    if (user.mfaEnabled) {
      return { status: "mfa_required", challengeToken: this.openMfaChallenge(user.id, membership.accountHolderId) };
    }
    return { status: "authenticated", ...this.openSession(user, membership) };
  }

  private openMfaChallenge(userId: string, accountHolderId: string): string {
    const token = `mfa_${randomBytes(32).toString("base64url")}`;
    this.mfaChallenges.set(hashSessionToken(token), {
      hashedToken: hashSessionToken(token),
      userId,
      accountHolderId,
      expiresAt: new Date(Date.now() + MFA_CHALLENGE_TTL_MS).toISOString(),
    });
    return token;
  }

  /**
   * Exchange a login challenge plus a TOTP (or recovery) code for a session.
   * The challenge is consumed either way, so a wrong code costs a full
   * password round-trip rather than allowing unlimited guesses.
   */
  verifyMfaChallenge(challengeToken: string, code: string): { token: string; session: Session; context: SessionContext } {
    const hashed = hashSessionToken(challengeToken);
    const challenge = this.mfaChallenges.get(hashed);
    this.mfaChallenges.delete(hashed);
    if (!challenge || Date.parse(challenge.expiresAt) < Date.now()) {
      throw new DomainError("invalid_mfa_challenge", "this login attempt expired — sign in again", 401);
    }
    const user = this.getUser(challenge.userId);
    if (!this.consumeMfaCode(user, code)) {
      throw new DomainError("invalid_mfa_code", "invalid authentication code", 401);
    }
    const membership = this.getMembership(user.id, challenge.accountHolderId);
    if (!membership) throw new DomainError("no_membership", "user has no organization", 403);
    return this.openSession(user, membership);
  }

  /** True if `code` is a valid TOTP or an unused recovery code (which it then burns). */
  private consumeMfaCode(user: User, code: string): boolean {
    if (user.mfaSecret && verifyTotp(code, user.mfaSecret)) return true;
    const hashed = hashRecoveryCode(code);
    const remaining = user.mfaRecoveryCodeHashes ?? [];
    const index = remaining.indexOf(hashed);
    if (index === -1) return false;
    remaining.splice(index, 1);
    user.mfaRecoveryCodeHashes = remaining;
    return true;
  }

  /**
   * Begin enrolment: mint a secret and return the `otpauth://` URI for a QR
   * code. MFA is not active until `confirmMfa` proves the device works, so an
   * abandoned setup cannot lock anyone out.
   */
  beginMfaEnrolment(userId: string): { secret: string; keyUri: string } {
    const user = this.getUser(userId);
    if (user.mfaEnabled) throw new InvalidStateError("MFA is already enabled for this user");
    const secret = generateMfaSecret();
    user.mfaSecret = secret;
    return { secret, keyUri: mfaKeyUri(user.email, secret) };
  }

  /** Confirm enrolment with a live code; returns recovery codes, shown once. */
  confirmMfaEnrolment(userId: string, code: string): { recoveryCodes: string[] } {
    const user = this.getUser(userId);
    if (user.mfaEnabled) throw new InvalidStateError("MFA is already enabled for this user");
    if (!user.mfaSecret) throw new InvalidStateError("start MFA enrolment before confirming it");
    if (!verifyTotp(code, user.mfaSecret)) {
      throw new DomainError("invalid_mfa_code", "invalid authentication code", 401);
    }
    const { codes, hashes } = generateRecoveryCodes();
    user.mfaEnabled = true;
    user.mfaRecoveryCodeHashes = hashes;
    return { recoveryCodes: codes };
  }

  /** Turn MFA off. Requires the password *and* a current code — either factor alone is not enough. */
  disableMfa(userId: string, password: string, code: string): void {
    const user = this.getUser(userId);
    if (!user.mfaEnabled) throw new InvalidStateError("MFA is not enabled for this user");
    if (!verifyPassword(password, user.passwordHash)) {
      throw new DomainError("invalid_credentials", "invalid password", 401);
    }
    if (!this.consumeMfaCode(user, code)) {
      throw new DomainError("invalid_mfa_code", "invalid authentication code", 401);
    }
    user.mfaEnabled = false;
    user.mfaSecret = undefined;
    user.mfaRecoveryCodeHashes = undefined;
  }

  openSession(user: User, membership: Membership): { token: string; session: Session; context: SessionContext } {
    const token = `sess_${randomBytes(32).toString("base64url")}`;
    const now = Date.now();
    const session: Session = {
      hashedToken: hashSessionToken(token),
      userId: user.id,
      accountHolderId: membership.accountHolderId,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + SESSION_TTL_MS).toISOString(),
    };
    this.sessions.set(session.hashedToken, session);
    return { token, session, context: { user: publicUser(user), accountHolderId: membership.accountHolderId, role: membership.role } };
  }

  resolveSession(token: string): SessionContext | undefined {
    const session = this.sessions.get(hashSessionToken(token));
    if (!session) return undefined;
    if (Date.parse(session.expiresAt) < Date.now()) {
      this.sessions.delete(session.hashedToken);
      return undefined;
    }
    const user = this.users.get(session.userId);
    const membership = this.getMembership(session.userId, session.accountHolderId);
    if (!user || !membership) return undefined;
    return { user: publicUser(user), accountHolderId: session.accountHolderId, role: membership.role };
  }

  revokeSession(token: string): void {
    this.sessions.delete(hashSessionToken(token));
  }
}
