import { beforeEach, describe, expect, it } from "vitest";
import { Platform } from "@acard/core";
import { generateSync } from "otplib";
import { createApp } from "../src/app.js";

/**
 * The two enterprise/compliance gaps closed over HTTP: scoped API keys and a
 * TOTP second factor. These exercise the real middleware and route gates —
 * the point is that a read-only key is refused by the *same* `requireRole`
 * check every write route already carried, not by a parallel permission path.
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

async function ownerSession(email = "founder@acard.co.za") {
  const res = await app.request("/v1/auth/register", {
    method: "POST",
    body: JSON.stringify({ email, name: "Founder", password: "supersecret" }),
    headers: { "content-type": "application/json" },
  });
  expect(res.status).toBe(201);
  return json(res);
}

describe("API key scoping", () => {
  it("a read-only key reads but cannot write", async () => {
    const owner = await ownerSession();
    const issued = await json(
      await withToken("/v1/keys", owner.session_token, {
        method: "POST",
        body: JSON.stringify({ name: "bi tool", scope: "read_only" }),
      }),
    );
    expect(issued.scope).toBe("read_only");

    // Reads pass.
    expect((await withToken("/v1/wallet", issued.api_key)).status).toBe(200);
    expect((await withToken("/v1/cards", issued.api_key)).status).toBe(200);
    expect((await withToken("/v1/transactions", issued.api_key)).status).toBe(200);

    // Writes are refused by the existing role gate.
    const card = await withToken("/v1/cards", issued.api_key, { method: "POST", body: "{}" });
    expect(card.status).toBe(403);
    const fund = await withToken("/v1/wallet/fund", issued.api_key, {
      method: "POST",
      body: JSON.stringify({ amount: 10_000 }),
    });
    expect(fund.status).toBe(403);
  });

  it("a full-scope key keeps the original owner-equivalent access", async () => {
    const owner = await ownerSession();
    const issued = await json(
      await withToken("/v1/keys", owner.session_token, { method: "POST", body: JSON.stringify({ name: "agent" }) }),
    );
    expect(issued.scope).toBe("full");
    expect((await withToken("/v1/cards", issued.api_key, { method: "POST", body: "{}" })).status).toBe(201);
  });

  it("signup's default key is unscoped, so existing integrations are unaffected", async () => {
    const { api_key } = await json(
      await app.request("/v1/signup", {
        method: "POST",
        body: JSON.stringify({ email: "agent@acard.co.za", name: "Agent" }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect((await withToken("/v1/cards", api_key, { method: "POST", body: "{}" })).status).toBe(201);
  });

  it("enforces a spend cap across the cards a key provisions", async () => {
    const owner = await ownerSession();
    const issued = await json(
      await withToken("/v1/keys", owner.session_token, {
        method: "POST",
        body: JSON.stringify({ name: "capped", spend_cap_cents: 100_000 }),
      }),
    );
    expect(issued.spend_cap_cents).toBe(100_000);

    const first = await withToken("/v1/cards", issued.api_key, {
      method: "POST",
      body: JSON.stringify({ limits: { total: 60_000 } }),
    });
    expect(first.status).toBe(201);

    const overCap = await withToken("/v1/cards", issued.api_key, {
      method: "POST",
      body: JSON.stringify({ limits: { total: 50_000 } }),
    });
    expect(overCap.status).toBe(403);
    expect((await json(overCap)).error.code).toBe("api_key_spend_cap_exceeded");

    // The remaining R400 is still usable — the cap throttles, it does not brick the key.
    const withinRemaining = await withToken("/v1/cards", issued.api_key, {
      method: "POST",
      body: JSON.stringify({ limits: { total: 40_000 } }),
    });
    expect(withinRemaining.status).toBe(201);
  });

  it("refuses an unbounded card through a capped key", async () => {
    const owner = await ownerSession();
    const issued = await json(
      await withToken("/v1/keys", owner.session_token, {
        method: "POST",
        body: JSON.stringify({ name: "capped", spend_cap_cents: 100_000 }),
      }),
    );
    // No limits.total would otherwise slip past the cap entirely.
    const res = await withToken("/v1/cards", issued.api_key, { method: "POST", body: "{}" });
    expect(res.status).toBe(400);
    expect((await json(res)).error.code).toBe("card_budget_required");
  });

  it("does not draw down the allowance for a card refused on other grounds", async () => {
    const owner = await ownerSession();
    const issued = await json(
      await withToken("/v1/keys", owner.session_token, {
        method: "POST",
        body: JSON.stringify({ name: "capped", spend_cap_cents: 1_000_000 }),
      }),
    );

    // The free tier allows 5 cards/month; use them all up.
    for (let i = 0; i < 5; i++) {
      const res = await withToken("/v1/cards", issued.api_key, {
        method: "POST",
        body: JSON.stringify({ limits: { total: 1_000 } }),
      });
      expect(res.status).toBe(201);
    }
    const provisioned = (await json(await withToken("/v1/keys", owner.session_token))).keys.find(
      (k: any) => k.id === issued.api_key_id,
    ).provisionedCents;
    expect(provisioned).toBe(5_000);

    // The 6th is refused by the plan limit, not the cap.
    const refused = await withToken("/v1/cards", issued.api_key, {
      method: "POST",
      body: JSON.stringify({ limits: { total: 1_000 } }),
    });
    expect(refused.status).toBe(402);

    // That refusal must not have spent any of the key's allowance.
    const after = (await json(await withToken("/v1/keys", owner.session_token))).keys.find(
      (k: any) => k.id === issued.api_key_id,
    ).provisionedCents;
    expect(after).toBe(provisioned);
  });

  it("lists keys without their secrets, and stops a revoked key authenticating", async () => {
    const owner = await ownerSession();
    const issued = await json(
      await withToken("/v1/keys", owner.session_token, {
        method: "POST",
        body: JSON.stringify({ name: "temp", scope: "read_only" }),
      }),
    );

    const { keys } = await json(await withToken("/v1/keys", owner.session_token));
    const listed = keys.find((k: any) => k.id === issued.api_key_id);
    expect(listed.scope).toBe("read_only");
    expect(listed).not.toHaveProperty("hashedSecret");

    expect((await withToken("/v1/wallet", issued.api_key)).status).toBe(200);
    expect((await withToken(`/v1/keys/${issued.api_key_id}`, owner.session_token, { method: "DELETE" })).status).toBe(200);
    expect((await withToken("/v1/wallet", issued.api_key)).status).toBe(401);
  });

  it("only admins and owners may issue keys", async () => {
    const owner = await ownerSession();
    await withToken("/v1/auth/members", owner.session_token, {
      method: "POST",
      body: JSON.stringify({ email: "member@acard.co.za", name: "M", password: "memberpass", role: "member" }),
    });
    const member = await json(
      await app.request("/v1/auth/login", {
        method: "POST",
        body: JSON.stringify({ email: "member@acard.co.za", password: "memberpass" }),
        headers: { "content-type": "application/json" },
      }),
    );
    const res = await withToken("/v1/keys", member.session_token, { method: "POST", body: "{}" });
    expect(res.status).toBe(403);
  });
});

describe("MFA over HTTP", () => {
  /** Enrol the signed-in user and return their TOTP secret + recovery codes. */
  async function enrol(sessionToken: string) {
    const setup = await json(await withToken("/v1/auth/mfa/setup", sessionToken, { method: "POST" }));
    expect(setup.otpauth_url.startsWith("otpauth://totp/")).toBe(true);
    const enabled = await json(
      await withToken("/v1/auth/mfa/enable", sessionToken, {
        method: "POST",
        body: JSON.stringify({ code: generateSync({ strategy: "totp", secret: setup.secret }) }),
      }),
    );
    expect(enabled.enabled).toBe(true);
    return { secret: setup.secret as string, recoveryCodes: enabled.recovery_codes as string[] };
  }

  it("logs in with a password alone until MFA is enabled", async () => {
    const owner = await ownerSession();
    const before = await json(
      await app.request("/v1/auth/login", {
        method: "POST",
        body: JSON.stringify({ email: "founder@acard.co.za", password: "supersecret" }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(before.session_token).toMatch(/^sess_/);
    expect(before.mfa_required).toBeUndefined();
    expect(owner.role).toBe("owner");
  });

  it("returns a challenge instead of a session once MFA is on, and no cookie with it", async () => {
    const owner = await ownerSession();
    const { secret } = await enrol(owner.session_token);

    const res = await app.request("/v1/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: "founder@acard.co.za", password: "supersecret" }),
      headers: { "content-type": "application/json" },
    });
    const body = await json(res);
    expect(body.mfa_required).toBe(true);
    expect(body.challenge_token).toMatch(/^mfa_/);
    expect(body.session_token).toBeUndefined();
    // A challenge is not an authenticated state — it must not set the session cookie.
    expect(res.headers.get("set-cookie") ?? "").not.toContain("acard_session=");

    const verified = await json(
      await app.request("/v1/auth/mfa/verify", {
        method: "POST",
        body: JSON.stringify({
          challenge_token: body.challenge_token,
          code: generateSync({ strategy: "totp", secret }),
        }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(verified.session_token).toMatch(/^sess_/);
    expect((await withToken("/v1/auth/me", verified.session_token)).status).toBe(200);
  });

  it("rejects a wrong code and spends the challenge", async () => {
    const owner = await ownerSession();
    const { secret } = await enrol(owner.session_token);
    const { challenge_token } = await json(
      await app.request("/v1/auth/login", {
        method: "POST",
        body: JSON.stringify({ email: "founder@acard.co.za", password: "supersecret" }),
        headers: { "content-type": "application/json" },
      }),
    );

    const bad = await app.request("/v1/auth/mfa/verify", {
      method: "POST",
      body: JSON.stringify({ challenge_token, code: "000000" }),
      headers: { "content-type": "application/json" },
    });
    expect(bad.status).toBe(401);

    // The challenge is spent, so even the right code cannot retry it.
    const retry = await app.request("/v1/auth/mfa/verify", {
      method: "POST",
      body: JSON.stringify({ challenge_token, code: generateSync({ strategy: "totp", secret }) }),
      headers: { "content-type": "application/json" },
    });
    expect(retry.status).toBe(401);
    expect((await json(retry)).error.code).toBe("invalid_mfa_challenge");
  });

  it("accepts a recovery code in place of the authenticator", async () => {
    const owner = await ownerSession();
    const { recoveryCodes } = await enrol(owner.session_token);
    const { challenge_token } = await json(
      await app.request("/v1/auth/login", {
        method: "POST",
        body: JSON.stringify({ email: "founder@acard.co.za", password: "supersecret" }),
        headers: { "content-type": "application/json" },
      }),
    );
    const verified = await json(
      await app.request("/v1/auth/mfa/verify", {
        method: "POST",
        body: JSON.stringify({ challenge_token, code: recoveryCodes[0] }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(verified.session_token).toMatch(/^sess_/);
  });

  it("disables MFA only with both the password and a code", async () => {
    const owner = await ownerSession();
    const { secret } = await enrol(owner.session_token);

    const wrongPassword = await withToken("/v1/auth/mfa/disable", owner.session_token, {
      method: "POST",
      body: JSON.stringify({ password: "nope", code: generateSync({ strategy: "totp", secret }) }),
    });
    expect(wrongPassword.status).toBe(401);

    const ok = await withToken("/v1/auth/mfa/disable", owner.session_token, {
      method: "POST",
      body: JSON.stringify({ password: "supersecret", code: generateSync({ strategy: "totp", secret }) }),
    });
    expect(ok.status).toBe(200);

    // Back to a single factor.
    const after = await json(
      await app.request("/v1/auth/login", {
        method: "POST",
        body: JSON.stringify({ email: "founder@acard.co.za", password: "supersecret" }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(after.session_token).toMatch(/^sess_/);
  });

  it("refuses MFA enrolment through an API key, which authenticates an org and not a person", async () => {
    const { api_key } = await json(
      await app.request("/v1/signup", {
        method: "POST",
        body: JSON.stringify({ email: "agent@acard.co.za", name: "Agent" }),
        headers: { "content-type": "application/json" },
      }),
    );
    const res = await withToken("/v1/auth/mfa/setup", api_key, { method: "POST" });
    expect(res.status).toBe(403);
    expect((await json(res)).error.code).toBe("session_required");
  });
});
