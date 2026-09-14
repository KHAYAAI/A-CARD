import { randomBytes } from "node:crypto";
import { hashSessionToken } from "./auth.js";
import { DomainError, InvalidStateError, NotFoundError } from "./errors.js";
import { newId } from "./ids.js";

/**
 * A-MERCHANT identity — separate from A-CARD's own `AuthService`.
 *
 * A merchant user is not an account holder. It has no wallet, no cards, no
 * subscription tier — it exists only to log into that one merchant's own
 * catalog and restate stock. Modeling it as a second, narrower entity rather
 * than reusing `User`/`Membership` keeps a bug in one identity system from
 * being a bug in the other: an agent's org login should never be able to
 * touch a merchant record, and a merchant login should never see a wallet.
 *
 * Authentication itself is WorkOS AuthKit's hosted flow (password, magic
 * link, social — WorkOS's problem, not ours). This module only tracks what
 * A-CARD needs on top of that: which merchant a WorkOS user belongs to, the
 * invite that vouched for them, and the session it issues afterward. The
 * session token scheme mirrors `AuthService` deliberately — same hashing,
 * same "the plaintext token is returned once and never stored" discipline.
 */

export type MerchantRole = "owner" | "staff";

export interface MerchantUser {
  id: string;
  merchantId: string;
  /** WorkOS's own user id — the join key back to AuthKit. Unique. */
  workosUserId: string;
  email: string;
  name: string;
  role: MerchantRole;
  createdAt: string;
}

export interface MerchantSessionContext {
  merchantUserId: string;
  merchantId: string;
  role: MerchantRole;
}

interface MerchantSessionRecord extends MerchantSessionContext {
  tokenHash: string;
  expiresAt: string;
  createdAt: string;
}

// Exported so any other backend (e.g. a SQL-backed adapter) uses the exact
// same lifetimes rather than a second, driftable copy of these numbers.
export const MERCHANT_SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days — matches AuthService
export const MERCHANT_INVITE_TTL_MS = 1000 * 60 * 60 * 24 * 3; // 3 days: long enough for a merchant to get to it, short enough not to accumulate stale links

export interface MerchantInvite {
  id: string;
  merchantId: string;
  role: MerchantRole;
  /** Who on the A-CARD side generated this — an unattributed invite is exactly the KYB gap this platform doesn't allow elsewhere. */
  issuedBy: string;
  expiresAt: string;
  consumedAt?: string;
  consumedByUserId?: string;
  createdAt: string;
}

interface MerchantInviteRecord extends MerchantInvite {
  tokenHash: string;
}

/**
 * A merchant's machine credential.
 *
 * The portal session assumes a human at a browser, which is the wrong shape
 * for the integration that actually scales A-MERCHANT: a POS or ERP system
 * syncing a catalog on a schedule, with nobody watching. That system needs a
 * long-lived credential scoped to exactly one merchant — never an A-CARD
 * tenant key, which would reach wallets and cards.
 *
 * `readWrite` is the default because the whole point is writing stock;
 * `readOnly` exists for an analytics or monitoring integration that should
 * never be able to change a price.
 */
export type MerchantApiKeyScope = "read_only" | "read_write";

export interface MerchantApiKey {
  id: string;
  merchantId: string;
  name: string;
  hashedSecret: string;
  /** First characters of the secret, for display in a list. */
  prefix: string;
  scope: MerchantApiKeyScope;
  /** Who created it — an unattributed machine credential is an audit hole. */
  createdBy: string;
  lastUsedAt?: string;
  createdAt: string;
  revokedAt?: string;
}

/** What a merchant API key resolves to on an authenticated request. */
export interface MerchantApiContext {
  merchantId: string;
  apiKeyId: string;
  scope: MerchantApiKeyScope;
}

export interface SerializedMerchantAuth {
  users: MerchantUser[];
  sessions: Array<MerchantSessionRecord>;
  invites: Array<MerchantInviteRecord>;
  apiKeys?: MerchantApiKey[];
}

export class MerchantAuthService {
  private readonly users = new Map<string, MerchantUser>();
  private readonly usersByWorkosId = new Map<string, string>();
  private readonly sessions = new Map<string, MerchantSessionRecord>(); // keyed by tokenHash
  private readonly invites = new Map<string, MerchantInviteRecord>(); // keyed by tokenHash
  private readonly apiKeys = new Map<string, MerchantApiKey>(); // keyed by id
  private readonly apiKeysByHash = new Map<string, string>(); // tokenHash → id

  // -- machine credentials -----------------------------------------------

  /**
   * Issue a machine credential for one merchant. The secret is returned once
   * and only the hash is kept, the same discipline as A-CARD's own API keys
   * and session tokens — a credential this platform can read back is a
   * credential an attacker can read back.
   */
  createApiKey(
    merchantId: string,
    input: { name: string; scope?: MerchantApiKeyScope; createdBy: string },
  ): { apiKey: MerchantApiKey; secret: string } {
    if (!input.createdBy) {
      throw new DomainError("issuer_required", "a merchant API key must record who created it");
    }
    // The `mk_` prefix makes these impossible to confuse with an A-CARD
    // tenant key (`ak_`) or a portal session (`sess_`) in a log or a header.
    const secret = `mk_live_${randomBytes(24).toString("hex")}`;
    const apiKey: MerchantApiKey = {
      id: newId("mkey"),
      merchantId,
      name: input.name,
      hashedSecret: hashSessionToken(secret),
      prefix: secret.slice(0, 16),
      scope: input.scope ?? "read_write",
      createdBy: input.createdBy,
      createdAt: new Date().toISOString(),
    };
    this.apiKeys.set(apiKey.id, apiKey);
    this.apiKeysByHash.set(apiKey.hashedSecret, apiKey.id);
    return { apiKey, secret };
  }

  listApiKeys(merchantId: string): MerchantApiKey[] {
    return [...this.apiKeys.values()]
      .filter((k) => k.merchantId === merchantId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Resolve a presented secret. Returns undefined for unknown or revoked keys — never throws. */
  resolveApiKey(secret: string): MerchantApiContext | undefined {
    const id = this.apiKeysByHash.get(hashSessionToken(secret));
    if (!id) return undefined;
    const key = this.apiKeys.get(id);
    if (!key || key.revokedAt) return undefined;
    // Recording last use is what makes an unused credential identifiable
    // later, which is the first thing anyone auditing machine access asks.
    key.lastUsedAt = new Date().toISOString();
    return { merchantId: key.merchantId, apiKeyId: key.id, scope: key.scope };
  }

  revokeApiKey(merchantId: string, apiKeyId: string): MerchantApiKey {
    const key = this.apiKeys.get(apiKeyId);
    if (!key || key.merchantId !== merchantId) throw new NotFoundError("merchant API key", apiKeyId);
    if (!key.revokedAt) key.revokedAt = new Date().toISOString();
    return key;
  }

  // -- invites -----------------------------------------------------------

  /**
   * The only door into a merchant's portal. An A-CARD operator (already
   * gated by `requireRole("admin")` at the API layer) generates one of these
   * per onboarding — there is no open signup, because "anyone can claim to
   * run this hardware store" is exactly the KYB gap the rest of A-MERCHANT
   * refuses to leave open.
   */
  createInvite(merchantId: string, role: MerchantRole, issuedBy: string): { invite: MerchantInvite; token: string } {
    if (!issuedBy) throw new DomainError("issuer_required", "a portal invite must name who issued it");
    const token = newId("minv");
    const now = new Date();
    const record: MerchantInviteRecord = {
      id: newId("minvrec"),
      merchantId,
      role,
      issuedBy,
      expiresAt: new Date(now.getTime() + MERCHANT_INVITE_TTL_MS).toISOString(),
      createdAt: now.toISOString(),
      tokenHash: hashSessionToken(token),
    };
    this.invites.set(record.tokenHash, record);
    const { tokenHash: _hash, ...invite } = record;
    return { invite, token };
  }

  /** Read-only lookup — used to render "does this link still work" before spending a WorkOS round trip on it. */
  peekInvite(token: string): MerchantInvite | undefined {
    const record = this.invites.get(hashSessionToken(token));
    if (!record) return undefined;
    const { tokenHash: _hash, ...invite } = record;
    return invite;
  }

  /**
   * Spends the invite and links (or creates) the merchant user in one step —
   * called from the WorkOS callback once the identity is already verified,
   * so there is no window where an invite is consumed without a real user
   * behind it.
   */
  redeemInvite(token: string, workosUser: { workosUserId: string; email: string; name: string }): MerchantUser {
    const record = this.invites.get(hashSessionToken(token));
    if (!record) throw new InvalidStateError("this invite link is invalid");
    if (record.consumedAt) throw new InvalidStateError("this invite link has already been used");
    if (Date.parse(record.expiresAt) < Date.now()) throw new InvalidStateError("this invite link has expired");

    const user = this.linkOrCreateUser(record.merchantId, {
      workosUserId: workosUser.workosUserId,
      email: workosUser.email,
      name: workosUser.name,
      role: record.role,
    });
    record.consumedAt = new Date().toISOString();
    record.consumedByUserId = user.id;
    return user;
  }

  listInvites(merchantId: string): MerchantInvite[] {
    return [...this.invites.values()]
      .filter((i) => i.merchantId === merchantId)
      .map(({ tokenHash: _hash, ...invite }) => invite);
  }

  // -- users ---------------------------------------------------------------

  private linkOrCreateUser(
    merchantId: string,
    input: { workosUserId: string; email: string; name: string; role: MerchantRole },
  ): MerchantUser {
    const existingId = this.usersByWorkosId.get(input.workosUserId);
    if (existingId) {
      const existing = this.users.get(existingId);
      if (existing) {
        // Same WorkOS identity used across two merchants' invites (an owner
        // who also runs a second shop) is a real case; if it happened for
        // a *different* merchant, keep it distinct rather than overwrite —
        // one WorkOS user, several merchant memberships, none of which is
        // "the" record for that user across merchants.
        if (existing.merchantId === merchantId) return existing;
      }
    }
    const user: MerchantUser = {
      id: newId("mu"),
      merchantId,
      workosUserId: input.workosUserId,
      email: input.email,
      name: input.name || input.email,
      role: input.role,
      createdAt: new Date().toISOString(),
    };
    this.users.set(user.id, user);
    // Only index the *first* merchant this WorkOS identity redeemed an
    // invite for — good enough for "log back in and land in your shop" on
    // the common case without pretending to fully solve multi-merchant staff.
    if (!this.usersByWorkosId.has(input.workosUserId)) this.usersByWorkosId.set(input.workosUserId, user.id);
    return user;
  }

  getUser(id: string): MerchantUser {
    const user = this.users.get(id);
    if (!user) throw new NotFoundError("merchant user", id);
    return user;
  }

  listUsers(merchantId: string): MerchantUser[] {
    return [...this.users.values()].filter((u) => u.merchantId === merchantId);
  }

  // -- sessions --------------------------------------------------------------

  createSession(user: MerchantUser): { token: string; context: MerchantSessionContext } {
    const token = newId("msess");
    const now = new Date();
    const record: MerchantSessionRecord = {
      merchantUserId: user.id,
      merchantId: user.merchantId,
      role: user.role,
      tokenHash: hashSessionToken(token),
      expiresAt: new Date(now.getTime() + MERCHANT_SESSION_TTL_MS).toISOString(),
      createdAt: now.toISOString(),
    };
    this.sessions.set(record.tokenHash, record);
    return { token, context: { merchantUserId: user.id, merchantId: user.merchantId, role: user.role } };
  }

  resolveSession(token: string): MerchantSessionContext | undefined {
    const record = this.sessions.get(hashSessionToken(token));
    if (!record) return undefined;
    if (Date.parse(record.expiresAt) < Date.now()) {
      this.sessions.delete(hashSessionToken(token));
      return undefined;
    }
    return { merchantUserId: record.merchantUserId, merchantId: record.merchantId, role: record.role };
  }

  revokeSession(token: string): void {
    this.sessions.delete(hashSessionToken(token));
  }

  // -- persistence -----------------------------------------------------------

  serializeApiKeys(): MerchantApiKey[] {
    return [...this.apiKeys.values()];
  }

  serialize(): SerializedMerchantAuth {
    return {
      users: [...this.users.values()],
      sessions: [...this.sessions.values()],
      invites: [...this.invites.values()],
      apiKeys: [...this.apiKeys.values()],
    };
  }

  static hydrate(snapshot: SerializedMerchantAuth): MerchantAuthService {
    const service = new MerchantAuthService();
    for (const user of snapshot.users) {
      service.users.set(user.id, user);
      if (!service.usersByWorkosId.has(user.workosUserId)) service.usersByWorkosId.set(user.workosUserId, user.id);
    }
    for (const session of snapshot.sessions) service.sessions.set(session.tokenHash, session);
    for (const invite of snapshot.invites) service.invites.set(invite.tokenHash, invite);
    // Back-compat: snapshots taken before merchant API keys existed have none.
    for (const key of snapshot.apiKeys ?? []) {
      service.apiKeys.set(key.id, key);
      service.apiKeysByHash.set(key.hashedSecret, key.id);
    }
    return service;
  }
}
