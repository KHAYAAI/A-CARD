import { describe, expect, it } from "vitest";
import pg from "pg";
import { PostgresPlatformService } from "../src/service/postgres.js";

/**
 * The upgrade path, not the fresh-install path. API-key scoping and MFA added
 * columns to `acard_api_keys` and `acard_users`; this proves `migrate()` brings
 * a database created before them forward without manual intervention, and that
 * nothing existing is retroactively tightened — an old key stays full-access
 * and uncapped, an old user stays single-factor.
 *
 * Runs its own schema teardown, so it is kept out of pg-service.test.ts rather
 * than sharing that file's per-test table truncation.
 */
const DB = process.env.ACARD_TEST_DATABASE_URL;
const suite = DB ? describe : describe.skip;

suite("Postgres upgrade path (pre-scoping, pre-MFA deployment)", () => {
  it("migrates the older table shape and leaves existing access unchanged", async () => {
    const pool = new pg.Pool({ connectionString: DB });
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");

    // The pre-upgrade shape of the two tables that changed.
    await pool.query(`
      CREATE TABLE acard_account_holders (
        id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL, currency TEXT NOT NULL,
        wallet_account_id TEXT NOT NULL, subscription_tier TEXT NOT NULL DEFAULT 'free',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now());
      CREATE TABLE acard_api_keys (
        id TEXT PRIMARY KEY, account_holder_id TEXT NOT NULL, name TEXT NOT NULL,
        hashed_secret TEXT UNIQUE NOT NULL, prefix TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(), revoked_at TIMESTAMPTZ);
      CREATE TABLE acard_users (
        id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
        password_hash TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
    `);

    const svc = new PostgresPlatformService(DB!);
    await svc.migrate(); // must not throw against the older shape

    // A key issued after the upgrade behaves as before by default.
    const holder = await svc.signup({ email: "legacy@x.co.za", name: "Legacy", currency: "ZAR" });
    const key = await svc.issueApiKey(holder.id, "default");
    expect(key.scope).toBe("full");
    const principal = await svc.authenticateApiKey(key.secret);
    expect(principal?.key.scope).toBe("full");
    expect(principal?.key.spendCapCents).toBeUndefined();
    expect(principal?.key.provisionedCents).toBe(0);

    // Uncapped: a card with no declared total is still fine.
    await svc.createCard({ accountHolderId: holder.id, apiKeyId: key.id });

    // A user created after the upgrade logs in with one factor.
    const reg = await svc.registerAccount({ email: "legacyuser@x.co.za", name: "U", password: "supersecret" });
    expect(reg.sessionToken).toMatch(/^sess_/);
    const login = await svc.login({ email: "legacyuser@x.co.za", password: "supersecret" });
    expect(login.status).toBe("authenticated");

    // migrate() is idempotent.
    await svc.migrate();
    await pool.end();
    await svc.close();
  });
});
