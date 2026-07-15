import { createHash } from "node:crypto";

/**
 * Idempotency for mutating requests and issuer webhook events. A repeated key
 * with the same request payload returns the stored response; the same key
 * with a different payload is a conflict.
 */

export interface StoredResponse {
  status: number;
  body: unknown;
  requestHash: string;
}

export class IdempotencyStore {
  private readonly responses = new Map<string, StoredResponse>();
  private readonly seenEvents = new Set<string>();

  hashRequest(payload: unknown): string {
    return createHash("sha256").update(JSON.stringify(payload) ?? "null").digest("hex");
  }

  get(key: string, requestHash: string): { hit: true; response: StoredResponse } | { hit: false; conflict: boolean } {
    const stored = this.responses.get(key);
    if (!stored) return { hit: false, conflict: false };
    if (stored.requestHash !== requestHash) return { hit: false, conflict: true };
    return { hit: true, response: stored };
  }

  put(key: string, requestHash: string, status: number, body: unknown): void {
    this.responses.set(key, { status, body, requestHash });
  }

  /** Exactly-once processing for webhook event ids. Returns true first time. */
  markEvent(eventId: string): boolean {
    if (this.seenEvents.has(eventId)) return false;
    this.seenEvents.add(eventId);
    return true;
  }
}
