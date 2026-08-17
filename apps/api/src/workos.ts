import { WorkOS, DomainDataState } from "@workos-inc/node";

/**
 * WorkOS SSO — the enterprise front door. Existing email/password login
 * (with its own TOTP MFA, see mfa.ts in packages/core) stays primary for
 * every account; this is purely an additive path scoped to organizations
 * that have configured SAML/OIDC via their own identity provider. A WorkOS
 * profile never becomes a second source of identity: `Platform.completeSsoLogin`
 * resolves it onto the same User/Membership/Session model password login
 * already uses.
 */

export interface WorkOSConfig {
  apiKey: string;
  clientId: string;
  /** Where WorkOS redirects back after the identity provider completes. */
  redirectUri: string;
}

export interface WorkOSProfile {
  email: string;
  firstName?: string;
  lastName?: string;
  /** The WorkOS Organization the authenticated profile belongs to. */
  organizationId?: string;
}

/**
 * The narrow surface app.ts depends on — real WorkOS in production
 * (`createWorkOSClient`), a fake implementing this interface in tests. Kept
 * deliberately small: app.ts never touches the `@workos-inc/node` SDK directly.
 */
export interface WorkOSClient {
  createOrganization(name: string, domain: string): Promise<{ id: string }>;
  /** A link the org's own admin can use to configure their SAML/OIDC connection — no A-CARD login required on their end. */
  generatePortalLink(organizationId: string, returnUrl: string): Promise<string>;
  getAuthorizationUrl(organizationId: string, state?: string): string;
  getProfile(code: string): Promise<WorkOSProfile>;
}

export function createWorkOSClient(config: WorkOSConfig): WorkOSClient {
  const workos = new WorkOS(config.apiKey, { clientId: config.clientId });

  return {
    async createOrganization(name, domain) {
      const org = await workos.organizations.createOrganization({
        name,
        domainData: [{ domain, state: DomainDataState.Verified }],
      });
      return { id: org.id };
    },

    async generatePortalLink(organizationId, returnUrl) {
      const { link } = await workos.adminPortal.generateLink({
        organization: organizationId,
        intent: "sso",
        returnUrl,
      });
      return link;
    },

    getAuthorizationUrl(organizationId, state) {
      return workos.sso.getAuthorizationUrl({
        clientId: config.clientId,
        redirectUri: config.redirectUri,
        organization: organizationId,
        state,
      });
    },

    async getProfile(code) {
      const { profile } = await workos.sso.getProfileAndToken({ code, clientId: config.clientId });
      return {
        email: profile.email,
        firstName: profile.firstName,
        lastName: profile.lastName,
        organizationId: profile.organizationId,
      };
    },
  };
}

/** The domain half of a work email, lowercased. `founder@Acme.co.za` -> `acme.co.za`. */
export function domainFromEmail(email: string): string {
  const domain = email.split("@")[1];
  if (!domain) throw new Error(`not a valid email address: ${email}`);
  return domain.toLowerCase();
}
