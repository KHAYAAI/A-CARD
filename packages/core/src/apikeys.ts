import { createHash, randomBytes } from "node:crypto";
import { newId } from "./ids.js";
import { DomainError } from "./errors.js";

/**
 * API keys for programmatic access (MCP server, CLI, direct API). The secret
 * is shown once at creation; only a SHA-256 hash is stored.
 *
 * Keys are scoped. `full` is the historical behaviour — tenant-wide access,
 * equivalent to the `owner` role. `read_only` maps onto the `viewer` role, so
 * it reuses the same `requireRole` gate every route already carries rather
 * than introducing a second, parallel permission system.
 *
 * A key may also carry a `spendCapCents`: the cumulative card budget it is
 * allowed to provision. Because a card's `limits.total` is the ceiling on what
 * that card can ever spend, capping the budget a key hands out is a real bound
 * on the money that key can cause to move — and it is enforceable at card
 * creation, which is the point where the key is actually authenticated (the
 * issuer authorization webhook is signed by the issuer, and carries no key).
 */

export type ApiKeyScope = "full" | "read_only";

export interface ApiKey {
  id: string;
  accountHolderId: string;
  name: string;
  hashedSecret: string;
  prefix: string; // first chars of the secret, for display
  scope: ApiKeyScope;
  /** Cumulative card budget (minor units) this key may provision. Undefined = uncapped. */
  spendCapCents?: number;
  /** Running total of card budget already provisioned through this key. */
  provisionedCents: number;
  createdAt: string;
  revokedAt?: string;
}

export interface IssueApiKeyOptions {
  scope?: ApiKeyScope;
  spendCapCents?: number;
}

export interface IssuedApiKey {
  key: ApiKey;
  /** Full secret — returned exactly once. */
  secret: string;
}

export function hashApiKeySecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

export class ApiKeyService {
  private readonly keys = new Map<string, ApiKey>();
  private readonly byHash = new Map<string, ApiKey>();

  serialize(): ApiKey[] {
    return [...this.keys.values()];
  }

  static hydrate(data: ApiKey[]): ApiKeyService {
    const service = new ApiKeyService();
    for (const key of data) {
      // Keys snapshotted before scoping existed are full-access and uncapped.
      const migrated: ApiKey = { ...key, scope: key.scope ?? "full", provisionedCents: key.provisionedCents ?? 0 };
      service.keys.set(migrated.id, migrated);
      service.byHash.set(migrated.hashedSecret, migrated);
    }
    return service;
  }

  issue(accountHolderId: string, name: string, options: IssueApiKeyOptions = {}): IssuedApiKey {
    const secret = `ak_live_${randomBytes(24).toString("base64url")}`;
    const key: ApiKey = {
      id: newId("key"),
      accountHolderId,
      name,
      hashedSecret: hashApiKeySecret(secret),
      prefix: secret.slice(0, 12),
      scope: options.scope ?? "full",
      spendCapCents: options.spendCapCents,
      provisionedCents: 0,
      createdAt: new Date().toISOString(),
    };
    this.keys.set(key.id, key);
    this.byHash.set(key.hashedSecret, key);
    return { key, secret };
  }

  /**
   * Throw unless a capped key can still provision `amountCents` of budget.
   * A no-op for uncapped keys.
   *
   * `undefined` means the card declares no total budget. Through a capped key
   * that is refused rather than counted as zero: an unbounded card would
   * otherwise slip straight past the cap it is supposed to be bounded by.
   *
   * Deliberately separate from `recordSpend` so a card that is refused for an
   * unrelated reason (plan limit, bad department) does not leave the key's
   * allowance drawn down for a card that was never created.
   */
  assertSpendAllowance(id: string, amountCents: number | undefined): void {
    const key = this.keys.get(id);
    if (!key || key.spendCapCents === undefined) return;
    if (amountCents === undefined) {
      throw new DomainError(
        "card_budget_required",
        "a spend-capped API key must set limits.total on every card it creates",
        400,
      );
    }
    if (key.provisionedCents + amountCents > key.spendCapCents) {
      throw new DomainError(
        "api_key_spend_cap_exceeded",
        `this API key may provision at most ${key.spendCapCents} (minor units) of card budget; ${key.provisionedCents} already used`,
        403,
      );
    }
  }

  /** Draw down a capped key's allowance. Call only once the card is certain. */
  recordSpend(id: string, amountCents: number | undefined): void {
    const key = this.keys.get(id);
    if (!key || key.spendCapCents === undefined || amountCents === undefined) return;
    key.provisionedCents += amountCents;
  }

  authenticate(secret: string): ApiKey | undefined {
    const key = this.byHash.get(hashApiKeySecret(secret));
    if (!key || key.revokedAt) return undefined;
    return key;
  }

  revoke(id: string): void {
    const key = this.keys.get(id);
    if (key) key.revokedAt = new Date().toISOString();
  }

  list(accountHolderId: string): ApiKey[] {
    return [...this.keys.values()].filter((k) => k.accountHolderId === accountHolderId);
  }
}
