import { describe, expect, it } from "vitest";
import { Platform } from "../src/index.js";

/**
 * WorkOS SSO wired onto the existing account/auth model: `setSsoOrganization`
 * links an account to a WorkOS org, and `completeSsoLogin` resolves an
 * authenticated profile onto the same User/Membership/Session path password
 * login already uses. The actual WorkOS HTTP calls live in apps/api/src/workos.ts
 * behind a swappable client — these tests exercise the domain logic only.
 */

function newHolder(platform: Platform, email = "founder@acme.co.za") {
  return platform.signup({ email, name: "Acme", currency: "ZAR", accountType: "enterprise" });
}

describe("SSO organization setup", () => {
  it("links a domain and WorkOS org id to an account", () => {
    const platform = new Platform();
    const holder = newHolder(platform);
    const updated = platform.setSsoOrganization(holder.id, { workosOrganizationId: "org_123", ssoDomain: "Acme.co.za" });
    expect(updated.workosOrganizationId).toBe("org_123");
    expect(updated.ssoDomain).toBe("acme.co.za"); // lowercased
  });

  it("looks accounts up by domain and by WorkOS org id", () => {
    const platform = new Platform();
    const holder = newHolder(platform);
    platform.setSsoOrganization(holder.id, { workosOrganizationId: "org_123", ssoDomain: "acme.co.za" });

    expect(platform.getAccountHolderBySsoDomain("ACME.CO.ZA")?.id).toBe(holder.id);
    expect(platform.getAccountHolderBySsoDomain("nope.com")).toBeUndefined();
    expect(platform.getAccountHolderByWorkosOrganizationId("org_123")?.id).toBe(holder.id);
    expect(platform.getAccountHolderByWorkosOrganizationId("org_other")).toBeUndefined();
  });

  it("refuses to route the same domain to two different accounts", () => {
    const platform = new Platform();
    const a = newHolder(platform, "a@acme.co.za");
    const b = newHolder(platform, "b@other.co.za");
    platform.setSsoOrganization(a.id, { workosOrganizationId: "org_a", ssoDomain: "acme.co.za" });
    expect(() => platform.setSsoOrganization(b.id, { workosOrganizationId: "org_b", ssoDomain: "acme.co.za" })).toThrow(
      /already configured for SSO/,
    );
  });

  it("lets an account reconfigure its own domain without tripping the collision check", () => {
    const platform = new Platform();
    const holder = newHolder(platform);
    platform.setSsoOrganization(holder.id, { workosOrganizationId: "org_123", ssoDomain: "acme.co.za" });
    // Re-running setup (e.g. after regenerating the WorkOS org) must not self-collide.
    expect(() =>
      platform.setSsoOrganization(holder.id, { workosOrganizationId: "org_123_v2", ssoDomain: "acme.co.za" }),
    ).not.toThrow();
  });
});

describe("SSO login", () => {
  it("creates a new user and membership on first SSO login", () => {
    const platform = new Platform();
    const holder = newHolder(platform);
    platform.setSsoOrganization(holder.id, { workosOrganizationId: "org_123", ssoDomain: "acme.co.za" });

    const { token, context } = platform.completeSsoLogin({
      accountHolderId: holder.id,
      email: "newperson@acme.co.za",
      name: "New Person",
    });
    expect(token).toMatch(/^sess_/);
    expect(context.role).toBe("member"); // not owner — the org already has one
    expect(context.accountHolderId).toBe(holder.id);
    expect(context.user.email).toBe("newperson@acme.co.za");
  });

  it("reuses the same user and membership on a second SSO login, without changing their role", () => {
    const platform = new Platform();
    const holder = newHolder(platform);
    platform.setSsoOrganization(holder.id, { workosOrganizationId: "org_123", ssoDomain: "acme.co.za" });

    const first = platform.completeSsoLogin({ accountHolderId: holder.id, email: "person@acme.co.za", name: "Person" });
    // Promote them by hand (as an admin would via /v1/auth/members), then log in again via SSO.
    platform.auth.addMembership(first.context.user.id, holder.id, "admin");
    const second = platform.completeSsoLogin({ accountHolderId: holder.id, email: "person@acme.co.za", name: "Person" });

    expect(second.context.user.id).toBe(first.context.user.id);
    expect(second.context.role).toBe("admin"); // SSO login did not clobber the promoted role
  });

  it("an SSO-only user has no password anyone knows, so password login fails for them", () => {
    const platform = new Platform();
    const holder = newHolder(platform);
    platform.setSsoOrganization(holder.id, { workosOrganizationId: "org_123", ssoDomain: "acme.co.za" });
    platform.completeSsoLogin({ accountHolderId: holder.id, email: "ssoonly@acme.co.za", name: "SSO Only" });

    expect(() => platform.auth.login({ email: "ssoonly@acme.co.za", password: "" })).toThrow();
    expect(() => platform.auth.login({ email: "ssoonly@acme.co.za", password: "guessing-forever" })).toThrow(
      /invalid email or password/,
    );
  });

  it("never exposes the account holder's SSO configuration through completeSsoLogin's result", () => {
    const platform = new Platform();
    const holder = newHolder(platform);
    platform.setSsoOrganization(holder.id, { workosOrganizationId: "org_123", ssoDomain: "acme.co.za" });
    const { context } = platform.completeSsoLogin({ accountHolderId: holder.id, email: "p@acme.co.za", name: "P" });
    expect(context.user).not.toHaveProperty("passwordHash");
    expect(context.user).not.toHaveProperty("mfaSecret");
  });
});
