import { WorkOS } from "@workos-inc/node";

/**
 * WorkOS AuthKit — the merchant portal's login, in full: password, magic
 * link, social, email verification, session refresh, all hosted by WorkOS.
 * A-CARD never sees a merchant's password. This is deliberately a different
 * WorkOS product than `workos.ts`'s org SSO: SSO federates an A-CARD
 * *organization* to its own identity provider; AuthKit gives an individual
 * *person* — a hardware store owner with no IT department — an account.
 * Same WorkOS project, same API key, different surface.
 *
 * The narrow interface app.ts depends on mirrors `WorkOSClient`'s shape on
 * purpose: real AuthKit in production, a fake implementing this interface in
 * tests, app.ts never touches the SDK directly.
 */

export interface MerchantAuthKitConfig {
  apiKey: string;
  clientId: string;
  /** Where WorkOS redirects back after the hosted login/signup completes. */
  redirectUri: string;
}

export interface AuthKitProfile {
  workosUserId: string;
  email: string;
  name: string;
}

export interface MerchantAuthKitClient {
  /** `state` round-trips the invite token through WorkOS so the callback can recover which merchant this login is for. */
  getAuthorizationUrl(state: string): string;
  authenticateWithCode(code: string): Promise<AuthKitProfile>;
}

export function createMerchantAuthKitClient(config: MerchantAuthKitConfig): MerchantAuthKitClient {
  const workos = new WorkOS(config.apiKey, { clientId: config.clientId });

  return {
    getAuthorizationUrl(state) {
      return workos.userManagement.getAuthorizationUrl({
        clientId: config.clientId,
        redirectUri: config.redirectUri,
        provider: "authkit",
        state,
      });
    },

    async authenticateWithCode(code) {
      const { user } = await workos.userManagement.authenticateWithCode({ clientId: config.clientId, code });
      const name = [user.firstName, user.lastName].filter(Boolean).join(" ");
      return { workosUserId: user.id, email: user.email, name: name || user.email };
    },
  };
}
