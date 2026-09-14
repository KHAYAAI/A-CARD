import { beforeEach, describe, expect, it } from "vitest";
import { ComplianceService, Platform } from "@acard/core";
import { createApp } from "../src/app.js";
import { InMemoryMerchantAuth, InMemoryMerchantDirectory } from "../src/merchant/index.js";
import { InMemoryComplianceStore, SandboxComplianceProvider } from "../src/compliance/index.js";

const SECRET = "whsec_test";
const JOBURG = { lat: -26.2041, lng: 28.0473, addressLine: "1 Main Road", city: "Johannesburg", province: "Gauteng", country: "ZA" };

let platform: Platform;
let store: InMemoryComplianceStore;
let app: ReturnType<typeof createApp>;
let apiKey: string;

async function json(res: Response) {
  return (await res.json()) as any;
}

/**
 * `enforce` decides whether verification merely *records* or actually
 * *blocks*, so every test says which world it is in.
 */
function build(options: { enforce: boolean; email?: string } = { enforce: false }) {
  platform = new Platform();
  store = new InMemoryComplianceStore(new ComplianceService());
  return createApp({
    platform,
    issuerWebhookSecret: SECRET,
    merchants: new InMemoryMerchantDirectory(platform.merchants),
    merchantAuth: new InMemoryMerchantAuth(platform.merchantAuth),
    compliance: { provider: new SandboxComplianceProvider(), store, enforce: options.enforce },
  });
}

async function signup(email = "dev@example.co.za") {
  const res = await app.request("/v1/signup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, name: "Dev", currency: "ZAR" }),
  });
  return (await json(res)).api_key as string;
}

function authed(path: string, init: RequestInit = {}) {
  return app.request(path, {
    ...init,
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

describe("compliance: recording without enforcing", () => {
  beforeEach(async () => {
    app = build({ enforce: false });
    apiKey = await signup();
  });

  it("starts a verification session and is idempotent on a second call", async () => {
    const first = await authed("/v1/compliance/verify", { method: "POST" });
    expect(first.status).toBe(201);
    const started = (await json(first)).verification;
    expect(started.providerDecision).toBe("pending");
    expect(started.verificationUrl).toContain("sandbox.invalid");

    const second = await json(await authed("/v1/compliance/verify", { method: "POST" }));
    expect(second.resumed).toBe(true);
    expect(second.verification.id).toBe(started.id);
    expect((await store.list()).length).toBe(1);
  });

  it("reports status, and permits money movement because enforcement is off", async () => {
    const me = await json(await authed("/v1/compliance/me"));
    expect(me.status).toBe("not_started");
    expect(me.enforced).toBe(false);
    expect(me.can_move_money).toBe(true);
  });

  it("an unverified org can still fund and issue cards when enforcement is off", async () => {
    const fund = await authed("/v1/wallet/fund", { method: "POST", body: JSON.stringify({ amount: 50_000, currency: "ZAR" }) });
    expect(fund.status).toBe(201);
    const card = await authed("/v1/cards", { method: "POST", body: JSON.stringify({ currency: "ZAR" }) });
    expect(card.status).toBe(201);
  });
});

describe("compliance: enforcing", () => {
  beforeEach(async () => {
    app = build({ enforce: true });
    apiKey = await signup();
  });

  it("blocks funding and card issuance until verification passes", async () => {
    const fund = await authed("/v1/wallet/fund", { method: "POST", body: JSON.stringify({ amount: 50_000, currency: "ZAR" }) });
    expect(fund.status).toBe(403);
    const body = await json(fund);
    expect(body.error.code).toBe("verification_required");
    expect(body.verification_status).toBe("not_started");

    const card = await authed("/v1/cards", { method: "POST", body: JSON.stringify({ currency: "ZAR" }) });
    expect(card.status).toBe(403);
  });

  it("does not gate reads, approvals, or team management", async () => {
    expect((await authed("/v1/wallet")).status).toBe(200);
    expect((await authed("/v1/cards")).status).toBe(200);
    expect((await authed("/v1/auth/me")).status).toBe(200);
  });

  it("unblocks the moment the provider approves", async () => {
    const record = (await json(await authed("/v1/compliance/verify", { method: "POST" }))).verification;
    await store.recordProviderDecision(record.id, { status: "approved", amlRisk: "clear" });

    const fund = await authed("/v1/wallet/fund", { method: "POST", body: JSON.stringify({ amount: 50_000, currency: "ZAR" }) });
    expect(fund.status).toBe(201);
    expect((await json(await authed("/v1/compliance/me"))).can_move_money).toBe(true);
  });

  it("a sanctions hit blocks money even on an approved identity, with its own message", async () => {
    const record = (await json(await authed("/v1/compliance/verify", { method: "POST" }))).verification;
    await store.recordProviderDecision(record.id, { status: "approved", amlRisk: "hit", reasons: ["OFAC SDN"] });

    const fund = await authed("/v1/wallet/fund", { method: "POST", body: JSON.stringify({ amount: 50_000, currency: "ZAR" }) });
    expect(fund.status).toBe(403);
    expect((await json(fund)).error.message).toMatch(/compliance review/);
  });

  it("an attributed operator override clears the hit and unblocks", async () => {
    const record = (await json(await authed("/v1/compliance/verify", { method: "POST" }))).verification;
    await store.recordProviderDecision(record.id, { status: "approved", amlRisk: "hit" });

    const overridden = await authed(`/v1/compliance/verifications/${record.id}/override`, {
      method: "POST",
      body: JSON.stringify({ status: "approved", reason: "false positive — DOB and nationality both differ" }),
    });
    expect(overridden.status).toBe(200);
    const saved = (await json(overridden)).verification;
    expect(saved.override.decidedBy).toBe("dev@example.co.za");
    // The provider's own finding is preserved alongside the override.
    expect(saved.amlRisk).toBe("hit");

    expect((await authed("/v1/wallet/fund", { method: "POST", body: JSON.stringify({ amount: 50_000, currency: "ZAR" }) })).status).toBe(201);
  });

  it("an override must carry a reason", async () => {
    const record = (await json(await authed("/v1/compliance/verify", { method: "POST" }))).verification;
    const res = await authed(`/v1/compliance/verifications/${record.id}/override`, {
      method: "POST",
      body: JSON.stringify({ status: "approved", reason: "" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("compliance: merchant KYB", () => {
  beforeEach(async () => {
    app = build({ enforce: false });
    apiKey = await signup();
  });

  async function registerMerchant(name = "Kasi Hardware") {
    const res = await authed("/v1/merchants", {
      method: "POST",
      body: JSON.stringify({
        name,
        merchant_category_code: "5211",
        address: JOBURG,
        kyb: { registration_number: "2019/123456/07", contact_email: "orders@kasi.co.za" },
      }),
    });
    return (await json(res)).merchant.id as string;
  }

  it("a KYB approval webhook makes the merchant discoverable automatically", async () => {
    const merchantId = await registerMerchant();
    expect((await platform.merchants.get(merchantId)).status).toBe("pending_kyb");

    const started = (await json(await authed(`/v1/compliance/merchants/${merchantId}/verify`, { method: "POST" }))).verification;

    const res = await app.request("/webhooks/compliance", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session_id: started.providerSessionId, status: "Approved", vendor_data: merchantId }),
    });
    expect(res.status).toBe(200);
    expect((await json(res)).matched).toBe(true);

    const merchant = await platform.merchants.get(merchantId);
    expect(merchant.status).toBe("verified");
    expect(merchant.kyb.reviewedBy).toContain("didit:");
  });

  it("a KYB decline suspends the merchant", async () => {
    const merchantId = await registerMerchant();
    const started = (await json(await authed(`/v1/compliance/merchants/${merchantId}/verify`, { method: "POST" }))).verification;

    await app.request("/webhooks/compliance", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session_id: started.providerSessionId, status: "Declined" }),
    });
    expect((await platform.merchants.get(merchantId)).status).toBe("suspended");
  });

  it("an operator override on a merchant also moves the directory's own KYB gate", async () => {
    const merchantId = await registerMerchant();
    const started = (await json(await authed(`/v1/compliance/merchants/${merchantId}/verify`, { method: "POST" }))).verification;

    await authed(`/v1/compliance/verifications/${started.id}/override`, {
      method: "POST",
      body: JSON.stringify({ status: "approved", reason: "documents verified in person" }),
    });
    expect((await platform.merchants.get(merchantId)).status).toBe("verified");
  });

  it("a webhook for an unknown session is acknowledged, not retried forever", async () => {
    const res = await app.request("/webhooks/compliance", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session_id: "sbx_nope", status: "Approved" }),
    });
    expect(res.status).toBe(200);
    expect((await json(res)).matched).toBe(false);
  });

  it("a malformed webhook body is rejected as unverifiable", async () => {
    const res = await app.request("/webhooks/compliance", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    expect(res.status).toBe(401);
  });
});

describe("compliance: AML and registry", () => {
  beforeEach(async () => {
    app = build({ enforce: false });
    apiKey = await signup();
  });

  it("screens a name and reports matches", async () => {
    const clear = await json(
      await authed("/v1/compliance/aml/screen", { method: "POST", body: JSON.stringify({ full_name: "Thandi Nkosi" }) }),
    );
    expect(clear.result.risk).toBe("clear");
    expect(clear.result.matches).toHaveLength(0);

    const hit = await json(
      await authed("/v1/compliance/aml/screen", { method: "POST", body: JSON.stringify({ full_name: "Sanctioned AML Person" }) }),
    );
    expect(hit.result.risk).toBe("hit");
    expect(hit.result.matches[0].listName).toBe("SANDBOX-LIST");
  });

  it("rejects an alpha-3 nationality, which the real provider also refuses", async () => {
    const res = await authed("/v1/compliance/aml/screen", {
      method: "POST",
      body: JSON.stringify({ full_name: "Someone", nationality: "ZAF" }),
    });
    expect(res.status).toBe(400);
  });

  it("searches a company registry and resolves a candidate to officers and UBOs", async () => {
    const search = await json(await authed("/v1/compliance/registry/search?country_code=ZA&name=Kasi%20Hardware"));
    expect(search.candidates).toHaveLength(1);

    const company = await json(await authed(`/v1/compliance/registry/${search.candidates[0].providerCandidateId}`));
    expect(company.company.beneficialOwners[0].ownershipPercent).toBe(100);
    expect(company.company.officers[0].role).toBe("director");
  });

  it("requires a country code to search", async () => {
    expect((await authed("/v1/compliance/registry/search?name=x")).status).toBe(400);
  });

  it("the review queue surfaces exactly what needs a human", async () => {
    const reviewKey = apiKey;
    const record = await store.open("account_holder", "ah_review_me");
    await store.attachSession(record.id, { providerSessionId: "s_rev", providerWorkflowId: "wf" });
    await store.recordProviderDecision(record.id, { status: "in_review" });

    apiKey = reviewKey;
    const queue = await json(await authed("/v1/compliance/queue"));
    expect(queue.verifications.map((v: { subjectId: string }) => v.subjectId)).toContain("ah_review_me");
  });
});

describe("compliance: unmounted", () => {
  it("no compliance routes exist and nothing is gated when it is not configured", async () => {
    platform = new Platform();
    app = createApp({ platform, issuerWebhookSecret: SECRET });
    apiKey = await signup();

    expect((await authed("/v1/compliance/me")).status).toBe(404);
    expect((await authed("/v1/compliance/verify", { method: "POST" })).status).toBe(404);
    expect((await app.request("/webhooks/compliance", { method: "POST", body: "{}" })).status).toBe(404);
    // And money still moves exactly as it did before compliance existed.
    expect((await authed("/v1/wallet/fund", { method: "POST", body: JSON.stringify({ amount: 1000, currency: "ZAR" }) })).status).toBe(201);
  });
});
