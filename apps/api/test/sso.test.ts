import { beforeEach, describe, expect, it } from "vitest";
import { Platform } from "@acard/core";
import { createApp } from "../src/app.js";
import type { WorkOSClient, WorkOSProfile } from "../src/workos.js";

/**
 * WorkOS SSO over the real HTTP surface. A fake `WorkOSClient` stands in for
 * `@workos-inc/node` so these tests exercise the actual routes and the
 * account-linking-by-email logic without any network call — the same
 * dependency-injection pattern EmbeddedWalletClient and PaystackClient use
 * elsewhere in this codebase, just via a swappable client object instead of
 * a mocked `fetch`.
 *
 * The point under test: existing email/password login (with its own TOTP
 * MFA) is untouched by any of this — SSO is purely an additive door.
 */
const SECRET = "whsec_test";

/** A fake WorkOS that behaves like the real one closely enough to test against. */
function fakeWorkOS() {
  let nextOrgId = 1;
  const organizations = new Map<string, { id: string; name: string; domain: string }>();
  let profileForNextCode: WorkOSProfile | undefined;

  const client: WorkOSClient & { setNextProfile: (p: WorkOSProfile) => void; organizations: typeof organizations } = {
    organizations,
    setNextProfile: (p) => { profileForNextCode = p; },
    async createOrganization(name, domain) {
      const id = `org_${nextOrgId++}`;
      organizations.set(id, { id, name, domain });
      return { id };
    },
    async generatePortalLink(organizationId) {
      return `https://id.workos.com/portal/launch?organization=${organizationId}`;
    },
    getAuthorizationUrl(organizationId, state) {
      return `https://api.workos.com/sso/authorize?organization=${organizationId}${state ? `&state=${state}` : ""}`;
    },
    async getProfile(code) {
      if (code !== "valid_code" || !profileForNextCode) throw new Error("invalid code");
      return profileForNextCode;
    },
  };
  return client;
}

let app: ReturnType<typeof createApp>;
let workos: ReturnType<typeof fakeWorkOS>;

async function json(res: Response) {
  return (await res.json()) as any;
}

function withToken(path: string, token: string, init: RequestInit = {}) {
  return app.request(path, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

async function ownerSession(email = "founder@acme.co.za") {
  const res = await app.request("/v1/auth/register", {
    method: "POST",
    body: JSON.stringify({ email, name: "Founder", password: "supersecret", account_type: "enterprise" }),
    headers: { "content-type": "application/json" },
  });
  expect(res.status).toBe(201);
  return json(res);
}

describe("SSO: not configured", () => {
  beforeEach(() => {
    app = createApp({ platform: new Platform(), issuerWebhookSecret: SECRET }); // no `workos` config
  });

  it("returns 501 rather than erroring when no WorkOS client is configured", async () => {
    const owner = await ownerSession();
    const setup = await withToken("/v1/sso/setup", owner.session_token, { method: "POST", body: "{}" });
    expect(setup.status).toBe(501);

    const authorize = await app.request("/v1/auth/sso/authorize", {
      method: "POST",
      body: JSON.stringify({ email: "someone@acme.co.za" }),
      headers: { "content-type": "application/json" },
    });
    expect(authorize.status).toBe(501);
  });

  it("password login still works exactly as before", async () => {
    const owner = await ownerSession();
    const login = await json(
      await app.request("/v1/auth/login", {
        method: "POST",
        body: JSON.stringify({ email: "founder@acme.co.za", password: "supersecret" }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(login.session_token).toMatch(/^sess_/);
    expect(owner.role).toBe("owner");
  });
});

describe("SSO: configured", () => {
  beforeEach(() => {
    workos = fakeWorkOS();
    app = createApp({
      platform: new Platform(),
      issuerWebhookSecret: SECRET,
      workos,
      dashboardUrl: "https://app.acard.io",
    });
  });

  it("lets an owner set up SSO and get a portal link, without needing WorkOS credentials themselves", async () => {
    const owner = await ownerSession();
    const res = await withToken("/v1/sso/setup", owner.session_token, { method: "POST", body: "{}" });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.portal_url).toContain("workos.com/portal/launch");
    expect([...workos.organizations.values()][0]?.domain).toBe("acme.co.za"); // inferred from the owner's email
  });

  it("only owners can run SSO setup", async () => {
    const owner = await ownerSession();
    await withToken("/v1/auth/members", owner.session_token, {
      method: "POST",
      body: JSON.stringify({ email: "admin@acme.co.za", name: "A", password: "adminpass1", role: "admin" }),
    });
    const admin = await json(
      await app.request("/v1/auth/login", {
        method: "POST",
        body: JSON.stringify({ email: "admin@acme.co.za", password: "adminpass1" }),
        headers: { "content-type": "application/json" },
      }),
    );
    const res = await withToken("/v1/sso/setup", admin.session_token, { method: "POST", body: "{}" });
    expect(res.status).toBe(403);
  });

  it("accepts an explicit domain override at setup", async () => {
    const owner = await ownerSession("founder@personalmail.example");
    const res = await withToken("/v1/sso/setup", owner.session_token, {
      method: "POST",
      body: JSON.stringify({ domain: "acme-corp.com" }),
    });
    expect(res.status).toBe(200);
    expect([...workos.organizations.values()][0]?.domain).toBe("acme-corp.com");
  });

  it("reuses the existing WorkOS org on a second setup call rather than creating another", async () => {
    const owner = await ownerSession();
    await withToken("/v1/sso/setup", owner.session_token, { method: "POST", body: "{}" });
    await withToken("/v1/sso/setup", owner.session_token, { method: "POST", body: "{}" });
    expect(workos.organizations.size).toBe(1);
  });

  it("returns a redirect URL for a domain with SSO configured, 404 for one without", async () => {
    const owner = await ownerSession();
    await withToken("/v1/sso/setup", owner.session_token, { method: "POST", body: "{}" });

    const ok = await app.request("/v1/auth/sso/authorize", {
      method: "POST",
      body: JSON.stringify({ email: "anyone@acme.co.za" }),
      headers: { "content-type": "application/json" },
    });
    expect(ok.status).toBe(200);
    expect((await json(ok)).redirect_url).toContain("api.workos.com/sso/authorize");

    const notConfigured = await app.request("/v1/auth/sso/authorize", {
      method: "POST",
      body: JSON.stringify({ email: "anyone@unrelated.com" }),
      headers: { "content-type": "application/json" },
    });
    expect(notConfigured.status).toBe(404);
  });

  it("completes the callback: creates a new member with the default role and redirects with a session", async () => {
    const owner = await ownerSession();
    const setup = await json(await withToken("/v1/sso/setup", owner.session_token, { method: "POST", body: "{}" }));
    const organizationId = [...workos.organizations.keys()][0]!;
    expect(setup.portal_url).toBeDefined();

    workos.setNextProfile({ email: "newperson@acme.co.za", firstName: "New", lastName: "Person", organizationId });

    const cb = await app.request("/v1/auth/sso/callback?code=valid_code");
    expect(cb.status).toBe(302);
    const location = cb.headers.get("location") ?? "";
    expect(location.startsWith("https://app.acard.io/?sso_token=")).toBe(true);
    const token = decodeURIComponent(location.split("sso_token=")[1]!);
    expect(token).toMatch(/^sess_/);

    const me = await json(await withToken("/v1/auth/me", token));
    expect(me.role).toBe("member"); // not owner — the org already has one
    expect(me.account_holder.email).toBe("founder@acme.co.za"); // the org, not the new person
  });

  it("logs an existing member in via SSO without duplicating their user or resetting a promoted role", async () => {
    const owner = await ownerSession();
    const setup = await json(await withToken("/v1/sso/setup", owner.session_token, { method: "POST", body: "{}" }));
    const organizationId = [...workos.organizations.keys()][0]!;
    void setup;

    workos.setNextProfile({ email: "person@acme.co.za", firstName: "P", lastName: "Erson", organizationId });
    const first = await app.request("/v1/auth/sso/callback?code=valid_code");
    const firstToken = decodeURIComponent(first.headers.get("location")!.split("sso_token=")[1]!);
    const firstMe = await json(await withToken("/v1/auth/me", firstToken));

    // Promote by hand, as an admin would via the dashboard.
    await withToken("/v1/auth/members", owner.session_token, {
      method: "POST",
      body: JSON.stringify({ email: "person@acme.co.za", role: "admin" }),
    });

    workos.setNextProfile({ email: "person@acme.co.za", firstName: "P", lastName: "Erson", organizationId });
    const second = await app.request("/v1/auth/sso/callback?code=valid_code");
    const secondToken = decodeURIComponent(second.headers.get("location")!.split("sso_token=")[1]!);
    const secondMe = await json(await withToken("/v1/auth/me", secondToken));

    expect(secondMe.account_holder.id).toBe(firstMe.account_holder.id);
    expect(secondMe.role).toBe("admin"); // the SSO login did not reset the promotion back to member
  });

  it("refuses a callback for an organization with no linked account", async () => {
    workos.setNextProfile({ email: "x@nowhere.com", organizationId: "org_unlinked" });
    const res = await app.request("/v1/auth/sso/callback?code=valid_code");
    expect(res.status).toBe(404);
  });

  it("rejects a callback with a bad or missing code", async () => {
    const missing = await app.request("/v1/auth/sso/callback");
    expect(missing.status).toBe(400);

    const badCode = await app.request("/v1/auth/sso/callback?code=garbage");
    expect(badCode.status).toBe(500); // the fake client throws, same as the real SDK would on a bad exchange
  });

  it("an SSO-provisioned user cannot log in with a password — no one knows it", async () => {
    const owner = await ownerSession();
    await withToken("/v1/sso/setup", owner.session_token, { method: "POST", body: "{}" });
    const organizationId = [...workos.organizations.keys()][0]!;
    workos.setNextProfile({ email: "ssoonly@acme.co.za", organizationId });
    await app.request("/v1/auth/sso/callback?code=valid_code");

    const attempt = await app.request("/v1/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: "ssoonly@acme.co.za", password: "any-guess-at-all" }),
      headers: { "content-type": "application/json" },
    });
    expect(attempt.status).toBe(401);
  });

  it("SSO does not interfere with MFA on the same account's password login path", async () => {
    // Not exhaustively re-testing MFA here (see keys-mfa.test.ts) — just that
    // configuring SSO for the org doesn't change how the owner's own
    // password + MFA login behaves.
    const owner = await ownerSession();
    await withToken("/v1/sso/setup", owner.session_token, { method: "POST", body: "{}" });

    const login = await json(
      await app.request("/v1/auth/login", {
        method: "POST",
        body: JSON.stringify({ email: "founder@acme.co.za", password: "supersecret" }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(login.mfa_required).toBeUndefined();
    expect(login.session_token).toMatch(/^sess_/);
  });
});
