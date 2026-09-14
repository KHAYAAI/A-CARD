import { randomBytes } from "node:crypto";
import { hashSessionToken } from "@acard/core";
import type { MerchantAuthService, MerchantDirectory, MerchantUser } from "@acard/core";
import type { MerchantAuthPort, MerchantDirectoryPort } from "./types.js";

/**
 * Wraps the synchronous `packages/core` classes behind the async port —
 * every call just awaits an immediate value. Backs the sandbox and the
 * single-writer snapshot deployment path, same relationship
 * `InMemoryPlatformService` has to the synchronous `Platform`.
 */
export class InMemoryMerchantDirectory implements MerchantDirectoryPort {
  constructor(private readonly directory: MerchantDirectory) {}

  async register(...args: Parameters<MerchantDirectory["register"]>) {
    return this.directory.register(...args);
  }
  async get(...args: Parameters<MerchantDirectory["get"]>) {
    return this.directory.get(...args);
  }
  async list(...args: Parameters<MerchantDirectory["list"]>) {
    return this.directory.list(...args);
  }
  async setStatus(...args: Parameters<MerchantDirectory["setStatus"]>) {
    return this.directory.setStatus(...args);
  }
  async attachKybDocument(...args: Parameters<MerchantDirectory["attachKybDocument"]>) {
    return this.directory.attachKybDocument(...args);
  }
  async updateProfile(...args: Parameters<MerchantDirectory["updateProfile"]>) {
    return this.directory.updateProfile(...args);
  }
  async upsertItem(...args: Parameters<MerchantDirectory["upsertItem"]>) {
    return this.directory.upsertItem(...args);
  }
  async restate(...args: Parameters<MerchantDirectory["restate"]>) {
    return this.directory.restate(...args);
  }
  async getItem(...args: Parameters<MerchantDirectory["getItem"]>) {
    return this.directory.getItem(...args);
  }
  async listItems(...args: Parameters<MerchantDirectory["listItems"]>) {
    return this.directory.listItems(...args);
  }
  async removeItem(...args: Parameters<MerchantDirectory["removeItem"]>) {
    return this.directory.removeItem(...args);
  }
  async catalogHealth(...args: Parameters<MerchantDirectory["catalogHealth"]>) {
    return this.directory.catalogHealth(...args);
  }
  async reportPurchase(...args: Parameters<MerchantDirectory["reportPurchase"]>) {
    return this.directory.reportPurchase(...args);
  }
  async getPurchase(...args: Parameters<MerchantDirectory["getPurchase"]>) {
    return this.directory.getPurchase(...args);
  }
  async listPurchases(...args: Parameters<MerchantDirectory["listPurchases"]>) {
    return this.directory.listPurchases(...args);
  }
  async listPurchasesByBuyer(...args: Parameters<MerchantDirectory["listPurchasesByBuyer"]>) {
    return this.directory.listPurchasesByBuyer(...args);
  }
  async resolvePurchase(...args: Parameters<MerchantDirectory["resolvePurchase"]>) {
    return this.directory.resolvePurchase(...args);
  }
  async pendingPurchaseCount(...args: Parameters<MerchantDirectory["pendingPurchaseCount"]>) {
    return this.directory.pendingPurchaseCount(...args);
  }
  async search(...args: Parameters<MerchantDirectory["search"]>) {
    return this.directory.search(...args);
  }
  async placeOrder(...args: Parameters<MerchantDirectory["placeOrder"]>) {
    return this.directory.placeOrder(...args);
  }
  async getOrder(...args: Parameters<MerchantDirectory["getOrder"]>) {
    return this.directory.getOrder(...args);
  }
  async listOrders(...args: Parameters<MerchantDirectory["listOrders"]>) {
    return this.directory.listOrders(...args);
  }
  async listOrdersByBuyer(...args: Parameters<MerchantDirectory["listOrdersByBuyer"]>) {
    return this.directory.listOrdersByBuyer(...args);
  }
  async advanceOrder(...args: Parameters<MerchantDirectory["advanceOrder"]>) {
    return this.directory.advanceOrder(...args);
  }
  async openOrderCount(...args: Parameters<MerchantDirectory["openOrderCount"]>) {
    return this.directory.openOrderCount(...args);
  }
  async reliability(...args: Parameters<MerchantDirectory["reliability"]>) {
    return this.directory.reliability(...args);
  }
  async setWebhook(merchantId: string, input: { url: string; events?: string[] }) {
    const secret = `mwh_${randomBytes(24).toString("hex")}`;
    const webhook = {
      url: input.url,
      hashedSecret: hashSessionToken(secret),
      events: input.events ?? [],
      createdAt: new Date().toISOString(),
      consecutiveFailures: 0,
    };
    this.directory.updateProfile(merchantId, { webhook });
    return { webhook, secret };
  }
  async clearWebhook(merchantId: string) {
    this.directory.updateProfile(merchantId, { webhook: undefined });
  }
  async recordWebhookDelivery(merchantId: string, ok: boolean) {
    const current = this.directory.get(merchantId).webhook;
    if (!current) return;
    this.directory.updateProfile(merchantId, {
      webhook: {
        ...current,
        lastDeliveryAt: new Date().toISOString(),
        lastDeliveryOk: ok,
        consecutiveFailures: ok ? 0 : current.consecutiveFailures + 1,
      },
    });
  }
}

export class InMemoryMerchantAuth implements MerchantAuthPort {
  constructor(private readonly auth: MerchantAuthService) {}

  async createInvite(...args: Parameters<MerchantAuthService["createInvite"]>) {
    return this.auth.createInvite(...args);
  }
  async peekInvite(...args: Parameters<MerchantAuthService["peekInvite"]>) {
    return this.auth.peekInvite(...args);
  }
  async redeemInvite(...args: Parameters<MerchantAuthService["redeemInvite"]>) {
    return this.auth.redeemInvite(...args);
  }
  async listInvites(...args: Parameters<MerchantAuthService["listInvites"]>) {
    return this.auth.listInvites(...args);
  }
  async getUser(...args: Parameters<MerchantAuthService["getUser"]>) {
    return this.auth.getUser(...args);
  }
  async listUsers(...args: Parameters<MerchantAuthService["listUsers"]>) {
    return this.auth.listUsers(...args);
  }
  async createSession(user: MerchantUser) {
    return this.auth.createSession(user);
  }
  async resolveSession(...args: Parameters<MerchantAuthService["resolveSession"]>) {
    return this.auth.resolveSession(...args);
  }
  async revokeSession(...args: Parameters<MerchantAuthService["revokeSession"]>) {
    return this.auth.revokeSession(...args);
  }
  async createApiKey(...args: Parameters<MerchantAuthService["createApiKey"]>) {
    return this.auth.createApiKey(...args);
  }
  async listApiKeys(...args: Parameters<MerchantAuthService["listApiKeys"]>) {
    return this.auth.listApiKeys(...args);
  }
  async resolveApiKey(...args: Parameters<MerchantAuthService["resolveApiKey"]>) {
    return this.auth.resolveApiKey(...args);
  }
  async revokeApiKey(...args: Parameters<MerchantAuthService["revokeApiKey"]>) {
    return this.auth.revokeApiKey(...args);
  }
}
