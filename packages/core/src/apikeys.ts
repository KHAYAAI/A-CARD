import { createHash, randomBytes } from "node:crypto";
import { newId } from "./ids.js";

/**
 * API keys for programmatic access (MCP server, CLI, direct API). The secret
 * is shown once at creation; only a SHA-256 hash is stored.
 */

export interface ApiKey {
  id: string;
  accountHolderId: string;
  name: string;
  hashedSecret: string;
  prefix: string; // first chars of the secret, for display
  createdAt: string;
  revokedAt?: string;
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

  issue(accountHolderId: string, name: string): IssuedApiKey {
    const secret = `ak_live_${randomBytes(24).toString("base64url")}`;
    const key: ApiKey = {
      id: newId("key"),
      accountHolderId,
      name,
      hashedSecret: hashApiKeySecret(secret),
      prefix: secret.slice(0, 12),
      createdAt: new Date().toISOString(),
    };
    this.keys.set(key.id, key);
    this.byHash.set(key.hashedSecret, key);
    return { key, secret };
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
