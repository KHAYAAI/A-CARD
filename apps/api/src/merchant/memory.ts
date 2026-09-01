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
  async search(...args: Parameters<MerchantDirectory["search"]>) {
    return this.directory.search(...args);
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
}
