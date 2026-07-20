import { randomBytes, scryptSync, timingSafeEqual, createHash } from "node:crypto";
import { newId } from "./ids.js";
import { DomainError, InvalidStateError, NotFoundError } from "./errors.js";

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
  user: Omit<User, "passwordHash">;
  accountHolderId: string;
  role: Role;
}

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days

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

export function publicUser(user: User): Omit<User, "passwordHash"> {
  const { passwordHash: _hash, ...rest } = user;
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

  /** Verify credentials and open a session bound to `accountHolderId`. Returns the raw token once. */
  login(input: { email: string; password: string; accountHolderId?: string }): { token: string; session: Session; context: SessionContext } {
    const user = this.getUserByEmail(input.email);
    if (!user || !verifyPassword(input.password, user.passwordHash)) {
      throw new DomainError("invalid_credentials", "invalid email or password", 401);
    }
    const memberships = this.membershipsForUser(user.id);
    const membership =
      (input.accountHolderId && memberships.find((m) => m.accountHolderId === input.accountHolderId)) || memberships[0];
    if (!membership) throw new DomainError("no_membership", "user has no organization", 403);
    return this.openSession(user, membership);
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
