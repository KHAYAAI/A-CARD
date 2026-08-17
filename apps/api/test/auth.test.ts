import { beforeEach, describe, expect, it } from "vitest";
import { Platform } from "@acard/core";
import { createApp } from "../src/app.js";

/**
 * Human auth + RBAC over the REST API: register/login/session, and the role
 * gate that separates read-only viewers from members, admins, and owners —
 * the boundary the API key alone did not provide.
 */
const SECRET = "whsec_test";
let app: ReturnType<typeof createApp>;

async function json(res: Response) {
  return (await res.json()) as any;
}

function withToken(path: string, token: string, init: RequestInit = {}) {
  return app.request(path, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

beforeEach(() => {
  app = createApp({ platform: new Platform(), issuerWebhookSecret: SECRET });
});

async function register(email: string, password = "supersecret") {
  const res = await app.request("/v1/auth/register", {
    method: "POST",
    body: JSON.stringify({ email, name: "Owner", password }),
    headers: { "content-type": "application/json" },
  });
  expect(res.status).toBe(201);
  return json(res);
}

describe("auth: register / login / session", () => {
  it("registers a user, creates their org as owner, and issues a working session", async () => {
    const body = await register("founder@acard.co.za");
    expect(body.role).toBe("owner");
    expect(body.session_token).toMatch(/^sess_/);

    // The session authenticates a normal /v1 call.
    const me = await json(await withToken("/v1/auth/me", body.session_token));
    expect(me.role).toBe("owner");
    expect(me.account_holder.email).toBe("founder@acard.co.za");
  });

  it("sets an httpOnly session cookie on register", async () => {
    const res = await app.request("/v1/auth/register", {
      method: "POST",
      body: JSON.stringify({ email: "cookie@acard.co.za", name: "C", password: "supersecret" }),
      headers: { "content-type": "application/json" },
    });
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("acard_session=");
    expect(cookie.toLowerCase()).toContain("httponly");
  });

  it("rejects a wrong password and a short password", async () => {
    await register("real@acard.co.za");
    const bad = await app.request("/v1/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: "real@acard.co.za", password: "wrongwrong" }),
      headers: { "content-type": "application/json" },
    });
    expect(bad.status).toBe(401);

    const weak = await app.request("/v1/auth/register", {
      method: "POST",
      body: JSON.stringify({ email: "weak@acard.co.za", name: "W", password: "short" }),
      headers: { "content-type": "application/json" },
    });
    expect(weak.status).toBe(400);
  });

  it("logout revokes the session", async () => {
    const { session_token } = await register("bye@acard.co.za");
    expect((await withToken("/v1/auth/me", session_token)).status).toBe(200);
    await withToken("/v1/auth/logout", session_token, { method: "POST" });
    expect((await withToken("/v1/auth/me", session_token)).status).toBe(401);
  });

  it("locks out an account after repeated failed logins, independent of the attacker's IP", async () => {
    await register("locktarget@acard.co.za");
    const attempt = () =>
      app.request("/v1/auth/login", {
        method: "POST",
        body: JSON.stringify({ email: "locktarget@acard.co.za", password: "wrongwrong" }),
        headers: { "content-type": "application/json" },
      });

    for (let i = 0; i < 5; i++) {
      expect((await attempt()).status).toBe(401);
    }
    // 6th attempt (even with the right password) is locked out, not just re-declined.
    const lockedOut = await app.request("/v1/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: "locktarget@acard.co.za", password: "supersecret" }),
      headers: { "content-type": "application/json" },
    });
    expect(lockedOut.status).toBe(429);
    expect((await json(lockedOut)).error.code).toBe("account_locked");
  });

  it("a successful login clears the failed-attempt counter", async () => {
    await register("resettable@acard.co.za");
    const failOnce = () =>
      app.request("/v1/auth/login", {
        method: "POST",
        body: JSON.stringify({ email: "resettable@acard.co.za", password: "wrongwrong" }),
        headers: { "content-type": "application/json" },
      });
    for (let i = 0; i < 3; i++) await failOnce();

    const success = await app.request("/v1/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: "resettable@acard.co.za", password: "supersecret" }),
      headers: { "content-type": "application/json" },
    });
    expect(success.status).toBe(200);

    // Counter reset — three more failures shouldn't trip the (5-attempt) lockout.
    for (let i = 0; i < 3; i++) expect((await failOnce()).status).toBe(401);
    const stillNotLocked = await app.request("/v1/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: "resettable@acard.co.za", password: "supersecret" }),
      headers: { "content-type": "application/json" },
    });
    expect(stillNotLocked.status).toBe(200);
  });
});

describe("RBAC: roles gate what a session can do", () => {
  it("a viewer can read but cannot create cards; a member can", async () => {
    const owner = await register("boss@acard.co.za");

    // Owner invites a viewer and a member.
    await withToken("/v1/auth/members", owner.session_token, {
      method: "POST",
      body: JSON.stringify({ email: "viewer@acard.co.za", name: "V", password: "viewerpass", role: "viewer" }),
    });
    await withToken("/v1/auth/members", owner.session_token, {
      method: "POST",
      body: JSON.stringify({ email: "member@acard.co.za", name: "M", password: "memberpass", role: "member" }),
    });

    const viewer = await json(
      await app.request("/v1/auth/login", {
        method: "POST",
        body: JSON.stringify({ email: "viewer@acard.co.za", password: "viewerpass" }),
        headers: { "content-type": "application/json" },
      }),
    );
    const member = await json(
      await app.request("/v1/auth/login", {
        method: "POST",
        body: JSON.stringify({ email: "member@acard.co.za", password: "memberpass" }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(viewer.role).toBe("viewer");
    expect(member.role).toBe("member");

    // Viewer: reads OK, writes forbidden.
    expect((await withToken("/v1/wallet", viewer.session_token)).status).toBe(200);
    const viewerCard = await withToken("/v1/cards", viewer.session_token, { method: "POST", body: "{}" });
    expect(viewerCard.status).toBe(403);

    // Member: can create a card.
    const memberCard = await withToken("/v1/cards", member.session_token, { method: "POST", body: "{}" });
    expect(memberCard.status).toBe(201);
  });

  it("only admins and owners can manage members", async () => {
    const owner = await register("chief@acard.co.za");
    await withToken("/v1/auth/members", owner.session_token, {
      method: "POST",
      body: JSON.stringify({ email: "m2@acard.co.za", name: "M", password: "memberpass", role: "member" }),
    });
    const member = await json(
      await app.request("/v1/auth/login", {
        method: "POST",
        body: JSON.stringify({ email: "m2@acard.co.za", password: "memberpass" }),
        headers: { "content-type": "application/json" },
      }),
    );
    // Member cannot list or add members.
    expect((await withToken("/v1/auth/members", member.session_token)).status).toBe(403);
    const add = await withToken("/v1/auth/members", member.session_token, {
      method: "POST",
      body: JSON.stringify({ email: "x@acard.co.za", password: "whatever8", role: "viewer" }),
    });
    expect(add.status).toBe(403);

    // Owner can.
    expect((await withToken("/v1/auth/members", owner.session_token)).status).toBe(200);
  });

  it("an API key retains full (owner-equivalent) access alongside sessions", async () => {
    const res = await app.request("/v1/signup", {
      method: "POST",
      body: JSON.stringify({ email: "agent@acard.co.za", name: "Agent" }),
      headers: { "content-type": "application/json" },
    });
    const { api_key } = await json(res);
    const card = await withToken("/v1/cards", api_key, { method: "POST", body: "{}" });
    expect(card.status).toBe(201);
  });
});
